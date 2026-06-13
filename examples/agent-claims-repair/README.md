# Agent Claims Repair

The propose-only agent pattern from [ADR-0006](../../docs/adr/0006-claims-triage.md), small enough to read in one sitting — and the canonical `agent()` example from [ADR-0001](../../docs/adr/0001-agent-step-type.md).

The shape: a deterministic checker owns the promise (`claims` task), an agent step drafts the fix as a patch artifact (`claims-repair` task, `stdoutTo: "claims.patch"`), and a human applies it. The agent proposes; the checker disposes. Nothing here edits anything.

```txt
anchors.txt           the registry: <id>\t<anchor> per line, all current (verify is green)
anchors-stale.txt     committed stale fixture: one anchor reworded out from under the registry
docs/README.md        the "product docs" the anchors must appear in verbatim
scripts/check-claims.mjs   the deterministic authority
scripts/mock-agent.mjs     the mock adapter profile: mechanical repair, judgment deferred to stderr REVIEW notes
```

## Run It

```sh
node scripts/check-claims.mjs anchors.txt        # green: registry matches docs
node scripts/check-claims.mjs anchors-stale.txt  # fails: frob.cached anchor went stale

async-pipeline run repair                        # mock profile drafts claims.patch
cat claims.patch                                 # one hunk: "completely cached" -> "fully cached"
git apply --check claims.patch                   # applies cleanly (to the stale fixture)
```

The repair task is cached like any task: unchanged registry + docs replay `claims.patch` without invoking the adapter; `--force` asks for a fresh draft.

## Swap In A Real Model

```sh
ASYNC_AGENT=claude async-pipeline run repair --force
```

The `claude` profile sends the same prompt to `claude -p` on stdin and lands stdout in the same `claims.patch`. The mock exists so CI and this repo's example tests prove the plumbing without a model — the same split your pipeline should use: live profiles local, mock (or committed artifacts) in CI.

## What To Notice

- The agent's transcript and prompt land under `.async/runs/<run-id>/agents/` with secret redaction; `claims.patch` is the working artifact, gitignored.
- The mock writes REVIEW notes to stderr for anything needing judgment instead of guessing — a useful contract for real prompts too.
- `claims-repair` is a normal task: declared inputs, declared output, cache semantics, run evidence. The only new thing is *who* does the work.
