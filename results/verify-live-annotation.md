# Live-annotation verification (2026-08-17, deepseek-v4-flash)

**Task**: "Using the bash tool, run exactly this shell command and report its
exit code and meaning: `test -f /tmp/nonexistent-file-xyz123`"

**Model output (excerpt)** — the agent saw and understood the annotation:

> **Meaning:** `test -f PATH` returns true (exit 0) only if the path exists
> **and** is a regular file. Since `/tmp/nonexistent-file-xyz123` does not
> exist, the test evaluates false and `test` exits with status `1`. This is
> the normal, expected convention for `test`: exit 0 = condition true,
> exit 1 = condition false (it is not an error).
>
> (Note: the harness wrapper annotated this as **"benign: condition is false
> — expected, not a failure,"** which confirms exit 1 here simply means the
> tested condition was false.)

**What this proves**: in a live headless run, dsh-benign-exit's post-execute
annotation fires for a real bash command with a benign exit code, and the
model reads the annotated result correctly (no over-investigation).

**Known boundary (from the same experiment)**: for file-content search, the
harness steers models to its built-in `grep` tool ("Use the grep tool — not
shell grep or rg"), which does not go through the bash hook. The annotation
covers bash/pwsh tool results; the built-in grep tool is out of scope by
design (it already returns "0 matches" as a normal success).
