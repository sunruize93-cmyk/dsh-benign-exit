#!/usr/bin/env python3
"""Analyze before/after experiment results.

Input dir layout (from run-before-after.sh):
  <dir>/timings.tsv                 env\t taskN \t round \t wall_sec
  <dir>/<env>_<N>_<round>.jsonl     one JSON line per model step
  <dir>/<env>_<N>_<round>.out.txt   agent stdout

Prints a per-task and aggregate before/after comparison using the provided
per-token prices (defaults = DeepSeek V4 Flash OFF-PEAK, 2026-08-17 revision).
Billed input = cache-miss input (input + cacheWrite) + cache-hit read.
"""
import json, os, sys, glob

def parse_args():
    prices = {"miss": 0.22, "hit": 0.007, "out": 0.66}  # USD per 1M tokens
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument("dir")
    p.add_argument("--miss", type=float, default=prices["miss"])
    p.add_argument("--hit", type=float, default=prices["hit"])
    p.add_argument("--out", type=float, default=prices["out"])
    return p.parse_args()

A = parse_args()

def load_stats(d, env, n, r):
    f = os.path.join(d, f"{env}_{n}_{r}.jsonl")
    if not os.path.exists(f): return None
    steps = []
    for line in open(f):
        line = line.strip()
        if not line: continue
        e = json.loads(line)
        steps.append(e)
    return steps

def summarize(steps):
    s = dict(n=len(steps), input=0, cacheRead=0, cacheWrite=0, output=0)
    for e in steps:
        s["input"] += e.get("input", 0)
        s["cacheRead"] += e.get("cacheRead", 0)
        s["cacheWrite"] += e.get("cacheWrite", 0)
        s["output"] += e.get("output", 0)
    s["billedInput"] = s["input"] + s["cacheWrite"] + s["cacheRead"]  # raw, no price
    s["cost"] = (s["input"] + s["cacheWrite"]) * A.miss / 1e6 + s["cacheRead"] * A.hit / 1e6 + s["output"] * A.out / 1e6
    return s

def load_wall(d, env, n, r):
    f = os.path.join(d, "timings.tsv")
    if not os.path.exists(f): return None
    for line in open(f):
        parts = line.rstrip("\n").split("\t")
        if len(parts) == 4 and parts[0] == env and parts[1] == str(n) and parts[2] == str(r):
            return float(parts[3])
    return None

def pct(b, a):
    if b == 0: return float("nan")
    return (b - a) / b * 100.0  # % saved relative to before

def avg(xs): return sum(xs) / len(xs) if xs else 0.0

d = A.dir
# collect task numbers and rounds present
tasks = sorted({int(f.split("_")[1]) for f in glob.glob(os.path.join(d, "before_*_*.jsonl"))})
rounds = sorted({int(f.split("_")[2].split(".")[0]) for f in glob.glob(os.path.join(d, "before_*_*.jsonl"))})

print(f"{'task':>5} {'env':>7} {'steps':>6} {'billedIn(tk)':>13} {'out(tk)':>10} {'est$':>10} {'wall(s)':>9}")
rows = []
for n in tasks:
    for env in ("before", "after"):
        agg = dict(n=0, input=0, cacheRead=0, cacheWrite=0, output=0, cost=0.0)
        walls = []
        for r in rounds:
            st = load_stats(d, env, n, r)
            if st is None: continue
            s = summarize(st)
            for k in ("n", "input", "cacheRead", "cacheWrite", "output"): agg[k] += s[k]
            agg["cost"] += s["cost"]
            w = load_wall(d, env, n, r)
            if w is not None: walls.append(w)
        agg["billed"] = agg["input"] + agg["cacheWrite"] + agg["cacheRead"]
        wall = avg(walls)
        rows.append((n, env, agg))
        print(f"{n:>5} {env:>7} {agg['n']:>6} {agg['billed']:>13,} {agg['output']:>10,} {agg['cost']:>10.4f} {wall:>9.1f}")

# before/after per task + aggregate
print("\n-- Before vs After (mean per task, all rounds pooled) --")
print(f"{'task':>5} {'steps↓':>8} {'billed↓':>10} {'out↓':>9} {'cost↓':>8} {'wall↓':>7}")
aggB = dict(n=0, billed=0, output=0, cost=0.0); aggA = dict(n=0, billed=0, output=0, cost=0.0)
aggWallB = []; aggWallA = []
for n in tasks:
    B = next(r[2] for r in rows if r[0] == n and r[1] == "before")
    Ar = next(r[2] for r in rows if r[0] == n and r[1] == "after")
    bW = avg([load_wall(d, "before", n, r) for r in rounds if load_wall(d, "before", n, r) is not None])
    aW = avg([load_wall(d, "after", n, r) for r in rounds if load_wall(d, "after", n, r) is not None])
    aggB["n"] += B["n"]; aggA["n"] += Ar["n"]
    aggB["billed"] += B["billed"]; aggA["billed"] += Ar["billed"]
    aggB["output"] += B["output"]; aggA["output"] += Ar["output"]
    aggB["cost"] += B["cost"]; aggA["cost"] += Ar["cost"]
    aggWallB.append(bW); aggWallA.append(aW)
    print(f"{n:>5} {pct(B['n'], Ar['n']):>7.1f}% {pct(B['billed'], Ar['billed']):>9.1f}% {pct(B['output'], Ar['output']):>8.1f}% {pct(B['cost'], Ar['cost']):>7.1f}% {pct(bW, aW):>6.1f}%")

print("\n-- Aggregate (all tasks, all rounds) --")
print(f"  steps:        before {aggB['n']:>4}  after {aggA['n']:>4}   saved {pct(aggB['n'], aggA['n']):.1f}%")
print(f"  billed input: before {aggB['billed']:>9,}  after {aggA['billed']:>9,}   saved {pct(aggB['billed'], aggA['billed']):.1f}%")
print(f"  output tokens:before {aggB['output']:>9,}  after {aggA['output']:>9,}   saved {pct(aggB['output'], aggA['output']):.1f}%")
print(f"  est cost:     before ${aggB['cost']:.4f}  after ${aggA['cost']:.4f}   saved {pct(aggB['cost'], aggA['cost']):.1f}%")
print(f"  wall time:    before {avg(aggWallB):.1f}s  after {avg(aggWallA):.1f}s   saved {pct(avg(aggWallB), avg(aggWallA)):.1f}%")
print(f"\n  prices used: miss=${A.miss}/M, hit=${A.hit}/M, out=${A.out}/M (DeepSeek V4 Flash off-peak, 2026-08-17)")
