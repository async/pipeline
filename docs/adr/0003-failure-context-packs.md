# ADR-0003: Failure Context Packs and Per-File Input Digests

**Status:** Accepted (v1 subset shipped in 0.2.3)
**Date:** 2026-06-12
**Deciders:** PatrickJS
**Index:** [Design decisions](index.md)

> Shipped in 0.2.3 per Option A: per-file digest manifests (`inputs.json`) persisted with every cache entry, per-task last-passing baseline pointers (pruned by `gc` when their entries go), failure context packs under `.async/runs/<run-id>/context/` (redacted 4 KiB log tail, repro command, digest-only input diff, `baselineMissing` when no pass is recorded), and `explain <task> --diff-inputs` / `explain --run <run-id>` — see [api.md](../api.md#run-evidence-cache-receipts-and-failure-context-packs) for the reference and registered claims. The claims cross-reference shipped with a narrower heuristic than decision 2 described: packs name claims whose registered test titles appear in the failing log, rather than mapping test files to tasks. In 0.6.0, `explain --run` was extended from context-pack-only output to run evidence that also includes the execution record, graph snapshot, cache receipts, logs path, and context packs.

## Context

When a task fails, the run record answers *what* happened: `execution.json` has status, attempts, cache key, timings, and error; `summary.md` is the human view; `logs/<task>.log` holds output. What an agent (or a tired human) actually needs to start fixing is narrower and partly missing:

- **Which inputs changed since this task last passed.** Today `computeTaskCacheKey` streams every input file into a single rolling sha256 — per-file digests are computed in passing and thrown away. "The key changed" is recorded; *why* it changed is not reconstructable without re-hashing against a baseline that also doesn't exist.
- **The relevant slice of the log**, not 8 MiB of it.
- **What the task is supposed to guarantee** — for this repo, the claims in `tests/claims.json` whose tests the failing task runs.
- **The exact reproduction command.**

An agent diagnosing a failure today must re-read the repo to rediscover all of this, which is slow, token-expensive, and exactly the kind of work a pipeline that already walks every input file should do once and persist.

Forces: execution records carry `schemaVersion: 1` and additive fields are non-breaking; logs are size-bounded and secret-redacted; run records are auto-pruned (`ASYNC_PIPELINE_KEEP_RUNS`); input walks already touch every file, so digest persistence is nearly free at hash time but not free at storage time.

## Decision

Persist per-file input digests, and emit a bounded, machine-readable failure context pack per failed task.

1. **Input manifests.** Alongside each cache entry, write `inputs.json`: relative path → content digest for the task's resolved input files (the same walk and exclusions the cache key uses). Stored per cache entry rather than per run, because digests are a property of the keyed input state; runs reference them.
2. **Context packs.** On task failure, write `.async/runs/<run-id>/context/<task>.json` containing: task id and failing step, exit code and error, reproduction command (`async-pipeline run-task <task>`), bounded log tail (redacted, capped well below the log cap), input diff versus the task's most recent *passing* cache entry (added/removed/changed paths — digests only, never contents), dependency fingerprints that changed, and — when `tests/claims.json` exists — the claim ids whose tests name the failing task's test files.
3. **CLI surface: extend `explain`, don't add commands.** `explain <task> --diff-inputs` answers "what changed since this last passed" on demand; `explain --run <run-id> --format json` returns the context pack. No new top-level command.
4. **Bounded by construction.** Packs target small-context consumption: digests and paths, log *tail*, no file contents. A pack for a typical failure should be a few KB.

## Options Considered

### Option A: Persist digests per cache entry + failure packs (proposed)

| Dimension | Assessment |
| --- | --- |
| Complexity | Low-medium — data already in hand at hash time |
| Storage cost | One manifest per cache entry; pruned by existing `gc` |
| Token efficiency | High — diff is precomputed, pack is bounded |
| Schema risk | Additive only (`schemaVersion` unchanged) |

**Pros:** answers "what changed" exactly, from data the pipeline already computes; baseline (last passing entry) is well-defined; useful to humans (`--diff-inputs`) independent of any agent.
**Cons:** manifest write on every cache-entry creation; "last passing entry" can be gc'd, degrading the diff to "no baseline" (pack must say so explicitly).

### Option B: Recompute diffs on demand, persist nothing

| Dimension | Assessment |
| --- | --- |
| Complexity | Low |
| Storage cost | Zero |
| Token efficiency | Medium — answer arrives, but slowly and only if asked |
| Schema risk | None |

**Pros:** no storage growth; no new write paths.
**Cons:** requires a stored baseline anyway (you cannot diff against a state you didn't record), so this collapses into "store at least the last passing manifest" — Option A with fewer guarantees; re-hashing the working tree races against the user editing files post-failure.

### Option C: Full input snapshots (contents, not digests)

| Dimension | Assessment |
| --- | --- |
| Complexity | Medium |
| Storage cost | High — copies of inputs per entry |
| Token efficiency | Highest (exact patches reconstructable) |
| Schema risk | Additive but heavy |

**Pros:** enables exact "show me the change" without git.
**Cons:** duplicates what git already does in the repos this targets; storage blowup; secret-bearing input files would be copied into `.async/`, expanding the redaction surface for marginal gain.

## Trade-off Analysis

B demonstrates that some persistence is unavoidable — a diff needs a baseline — so the real choice is digest manifests (A) versus content snapshots (C). Digests answer the operative question ("which files moved") at path-list cost and leave content reconstruction to git, which is present in every intended deployment. C's only unique capability, exact content diffs without git, is not worth copying potentially secret-bearing inputs into the store.

The claims cross-reference is the most repo-specific piece: it makes the pack say "this failure breaks promise X" rather than "exit code 1". It is also optional by design — pipelines without a claims registry simply omit the field — so the feature stays general.

## Consequences

- Easier: ADR-0004 and ADR-0006 get their input format for free; `explain` becomes the debugging entrypoint for humans too.
- Easier: cache *misses* become explainable after the fact ("rerun because these 3 files changed"), a frequent support question for any caching tool.
- Harder: store layout grows (`inputs.json`, `context/`); `gc` and auto-prune must account for them; docs and the [execution-record schema](../api.md#execution-record-schema) section need the additive fields specified.
- Revisit: whether packs should also be written for failed *runs* of cached-passing tasks (downgraded hits); manifest compression if entry counts grow.

## Action Items

1. [ ] Capture per-file digests in `computeTaskCacheKey`'s walk and write `inputs.json` per cache entry.
2. [ ] Implement pack assembly on task failure in the runner; route every text field through the existing redaction.
3. [ ] Extend `explain` with `--diff-inputs` and `--run` JSON output; document in [api.md](../api.md).
4. [ ] Teach `gc` and run-pruning about manifests and packs.
5. [ ] Register claims (pack location and bounds, digest-only diffs, redaction, baseline-missing behavior) with `PROMISE:` tests; CHANGELOG entry.
