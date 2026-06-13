# ADR-0006: Claims Triage Automation

**Status:** Accepted (repair half shipped in 0.2.4; scout open)
**Date:** 2026-06-12
**Deciders:** PatrickJS
**Index:** [Design decisions](index.md)
**Depends on:** [ADR-0001](0001-agent-step-type.md) (agent steps), [ADR-0003](0003-failure-context-packs.md) (context packs)

> Shipped in 0.2.4, decision 1 (repair proposals): the self pipeline's `claims-repair` task drafts `claims.patch` via `agent({ stdoutTo })` — claude profile locally, deterministic mechanical mock (`scripts/mock-claims-repair.mjs`) elsewhere — and a human applies it; the checker remains the only authority. The copyable pattern lives in [examples/agent-claims-repair](../../examples/agent-claims-repair/README.md). Not yet shipped: decision 2 (`claims-scout` advisory promise discovery in the PR job) and the ADR-0004 `fixes/` integration (the patch lands as a declared task output instead — simpler, and sufficient until 0004 exists).

## Context

The claims system is this repo's most distinctive discipline: `tests/claims.json` maps documented promises to enforcing tests, and `scripts/check-claims.mjs` fails the release when an anchor goes stale, a referenced test disappears, or a `PROMISE:` test is unregistered. The checker is deliberately mechanical — it proves the *mapping exists*, while review owns *sufficiency*.

The mechanical failures have mechanical-looking fixes that are tedious to produce by hand. Rewording a README sentence breaks its anchor; the fix is locating the new wording and updating one JSON string. Renaming a test breaks every claim that references the old title. These are high-frequency, low-judgment edits — the registry currently holds 64 claims across seven source files, and routine doc editing trips over it regularly (by design: that friction is the feature).

The harder direction is unregistered promises: new doc text that *makes a behavioral claim* without a registered test. The checker cannot catch this — recognizing that a sentence constitutes a promise is judgment, not string matching. Today it relies entirely on author discipline and review.

Forces: the checker must remain the sole authority (an agent that *edits the registry silently* would gut the discipline); ADR-0003 packs identify which claims a failing task's tests enforce; ADR-0001 provides bounded agent execution; advisory output in CI must not become blocking noise.

## Decision

Two narrow agent applications, both subordinate to the existing checker:

1. **Repair proposals on `claims:check` failure.** When the `claims` task fails, an `onFail`-style agent (per ADR-0004's propose-only rule, but scoped to one JSON file) reads the checker's failure output plus the doc diff and emits a proposed `tests/claims.json` patch to `.async/runs/<run-id>/fixes/`. For stale anchors it locates the reworded sentence; for renamed tests it maps old→new titles; for dropped claims it proposes the entry's removal *with the deletion flagged for review* — removing a promise is never routine. The patch is applied by a human; the checker re-validates; the checker remains the only authority.
2. **Promise discovery as advisory output.** A `claims-scout` task in the PR job runs an agent over the doc diff with one question: which added or changed sentences assert runtime behavior, and which lack a registered claim? Output is an advisory report in the run record (and PR comment via the existing preview machinery), never a failure. Precision is tuned by prompt against the existing 64 registered claims as few-shot examples — the registry doubles as training data for what this repo considers a promise.

## Options Considered

### Option A: Propose-only repair + advisory discovery (proposed)

| Dimension | Assessment |
| --- | --- |
| Complexity | Low — narrowest possible agent scope (one JSON file, one report) |
| Authority | Checker unchanged; human applies patches |
| Failure cost | A bad proposal wastes a review glance, nothing more |
| Value | Removes the tedium tax on doc editing; catches forgotten registrations |

**Pros:** smallest end-to-end proof of the ADR-0001/0003/0004 stack; the discipline's friction drops without its guarantees weakening; discovery formalizes a review step that today depends on memory.
**Cons:** advisory reports rot if ignored; two agent invocations per affected PR have model cost.

### Option B: Auto-fix anchors mechanically, no agent

| Dimension | Assessment |
| --- | --- |
| Complexity | Low |
| Authority | Checker self-modifies its registry — a category change |
| Failure cost | Silent semantic drift |
| Value | Handles the easy half of one failure mode |

**Pros:** fuzzy string matching catches pure rewording without any model.
**Cons:** an anchor update is a *semantic* assertion — "this new sentence is the same promise" — and encoding that as edit-distance invites exactly the silent weakening the registry exists to prevent (a reworded claim that now promises less would be auto-blessed).

### Option C: Make promise discovery blocking

| Dimension | Assessment |
| --- | --- |
| Complexity | Medium |
| Authority | An agent's judgment gates releases |
| Failure cost | False positives block unrelated work |
| Value | Strongest enforcement, least trustworthy enforcer |

**Pros:** unregistered promises could not ship.
**Cons:** promise-recognition precision is unproven; a probabilistic gate on the release path violates the repo's own standard that release blockers be mechanical and reproducible; appeal path ("the agent is wrong") has no good answer.

## Trade-off Analysis

B and C bracket A from opposite sides. B shows why removing the model doesn't help: the tedious edits are tedious *because* they encode semantic judgment, and mechanizing them without judgment auto-approves drift. C shows why strengthening the model's role doesn't help either: the registry's value is that its checks are mechanical and final, and inserting probabilistic judgment into the blocking path trades a tedium problem for a trust problem. A keeps judgment where it can be reviewed (a proposed patch, an advisory report) and mechanics where they are final (the unchanged checker).

This is also the right *first* shipped consumer of the agentic stack: one file, bounded prompts, a checker that immediately re-validates every proposal, and value measurable as "minutes saved per doc PR".

## Consequences

- Easier: doc editing stops being registry-archaeology; promise registration becomes a reviewed suggestion instead of a remembered chore.
- Easier: a concrete, low-stakes arena to observe agent-proposal quality before higher-stakes uses (ADR-0004).
- Harder: PR jobs gain optional model dependencies (mocked in this repo's own CI per ADR-0001's example pattern); advisory-report fatigue is a real failure mode to watch.
- Revisit: blocking discovery (Option C) only if precision proves high over a long advisory period; mechanical pre-filtering (B's matching as a *hint inside* A's prompt, not a decider).

## Action Items

1. [ ] Define the repair agent's prompt + policy: inputs are checker stderr, doc diff, and `tests/claims.json`; output is a unified diff against the registry only.
2. [ ] Wire propose-only output through the ADR-0004 `fixes/` path (or a standalone equivalent until 0004 lands).
3. [ ] Build `claims-scout` as a PR-job task emitting an advisory report; reuse the preview job's comment machinery.
4. [ ] Measure: proposal acceptance rate and scout precision against a quarter of real PRs before any scope expansion.
5. [ ] Register claims for whatever ships (propose-only boundary, advisory-never-blocking) with `PROMISE:` tests; CHANGELOG entry.
