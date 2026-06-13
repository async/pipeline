# ADR-0001: `agent()` as a First-Class Task Step

**Status:** Accepted (v1 subset shipped in 0.2.2)
**Date:** 2026-06-12
**Deciders:** PatrickJS
**Index:** [Design decisions](index.md)

> Shipped in 0.2.2: the `agents` profile block, the `agent()` step, prompt/transcript evidence under `.async/runs/<run-id>/agents/` with secret redaction, artifact cache semantics (profile id + model + prompt in the key, command path excluded), and `env.var(...)` selection — see [api.md](../api.md#agents) for the reference and registered claims. Shipped in 0.2.4: `stdoutTo` propose-only artifacts, the `doctor` missing-outputs warning (decision 5, second half, surfaced through doctor rather than definePipeline so metadata reads stay silent), and the canonical mocked example, [examples/agent-claims-repair](../../examples/agent-claims-repair/README.md) (action item 5).
>
> **Boundary amendment (decision 3):** the per-step default-deny policy for an agent's *own* tool calls is not enforceable from outside the adapter — the pipeline governs the adapter *spawn* (executor, env, redaction, evidence), but another program's internal tool use can only be restricted by that program's own permission surface (e.g. `claude -p` print mode denying writes, or explicit `--allowedTools` flags in the profile command). The honest contract: declare permission flags in the profile command where the adapter supports them, prefer propose-only outputs (`stdoutTo`) over agent-side writes, and treat sandbox selection as the hard isolation boundary. Decision 3's original wording overstated what a runner can promise; this record now claims only what it enforces.

## Context

Task steps today are `sh` template strings, deferred `sh((ctx) => ...)` callbacks, and runtime function steps. Nothing in the step model knows what an "agent" is. Teams that want a model in the loop (generate a migration, draft a fix, summarize a diff) shell out via plain `sh`, which silently bypasses three things this project otherwise guarantees:

- [Command policy](../api.md#command-policy) is the declared boundary for CLI/tool/agent commands — allow, deny, mock, record, redact, bound output. A `sh`-wrapped agent invocation is just another shell step; the agent's *own* tool calls are invisible to policy.
- Run evidence: an agent's transcript is the only record of why it did what it did, and today it lands nowhere under `.async/runs/`.
- Cache semantics: a task's cache key depends on its declared inputs, dependency fingerprints, and resolved steps. A nondeterministic model behind an opaque `sh` step satisfies the letter of this and defeats its purpose — two identical runs produce different artifacts with identical keys, and nothing marks the task as model-derived.

Forces: keep `definePipeline` metadata-only (importing a pipeline must never invoke a model); keep zero runtime dependencies; keep secrets out of stored output; stay agent-CLI-agnostic (Claude Code today, anything tomorrow).

## Decision

Add an `agent()` step constructor to the config surface, executed through an **agent adapter port** with command policy enforcement and transcript capture. Sketch (illustrative, not final API):

```ts
import { agent, definePipeline, sh, task } from "@async/pipeline";

export default definePipeline({
  name: "app",
  agents: {
    claude: { command: ["claude", "-p"], model: "claude-sonnet-4-6" }
  },
  tasks: {
    "draft-migration": task({
      inputs: ["schema/**/*.sql"],
      outputs: ["migrations/next.sql"],
      cache: true,
      run: agent({
        use: "claude",
        prompt: "Write the SQL migration that reconciles schema/ with migrations/.",
        commands: { fallback: "deny", rules: [/* explicit allows */] }
      })
    }),
    "verify-migration": task({
      dependsOn: ["draft-migration"],
      run: sh`pnpm migrate:dry-run`
    })
  }
});
```

Decisions bundled here:

1. **Metadata-only definition.** `agent()` creates step metadata. `metadata`, `list`, `graph`, and `explain` describe agent steps without invoking anything, exactly like deferred `sh` callbacks today.
2. **Adapter port, not SDK.** The pipeline defines an agent as a command template plus declared capabilities. Executing it spawns the user's agent CLI through the run's command executor. No model SDK enters the dependency tree.
3. **Default-deny command policy for agent steps.** Plain tasks keep `fallback: allow`; an `agent()` step with no `commands` block gets `fallback: deny` plus the adapter command itself. The asymmetry is deliberate: a human wrote the shell step, a model improvises its tool calls.
4. **Transcript as run evidence.** The adapter's stdout/stderr/tool-call stream is written to `.async/runs/<run-id>/agents/<task>.jsonl`, bounded and redacted by the same machinery as task logs.
5. **Cache treats agent output as artifact.** The cache key includes the prompt text, adapter id, and declared model id — never the transcript or sampled output. A cache hit replays declared outputs without invoking the model. Agent tasks SHOULD declare `outputs`; validation warns when they do not (an agent task without outputs is unverifiable side effects).
6. **Verifier convention, documented not enforced.** A deterministic dependent task (`verify-migration` above) is the recommended consumer of any agent task. Enforcement (e.g. requiring it) is deferred until real usage shows where it helps versus annoys.
7. **Per-environment selection through existing `env` sources.** Profile fields and the `use:` selection accept `env.var(...)` like any env value — resolved at run time from `process.env` locally and rendered as `${{ vars.NAME }}` in generated workflows. The recommended pattern selects among *declared* profiles (`use: env.var("ASYNC_AGENT", { default: "claude" })`, or a `--agent` flag mirroring `--sandbox`) rather than injecting raw command strings, so every candidate stays inspectable in metadata. The resolved adapter id and model id enter the cache key; the adapter's binary path never does, consistent with the rule that cache keys exclude absolute machine paths. A mock profile (`model: "mock"`) therefore keys separately from a real one — a CI mock can neither replay nor poison real artifacts. Credentials ride `env.secret(...)` in task env, never the command line, inheriting the existing redaction promise.

## Options Considered

### Option A: `agent()` step + adapter port (proposed)

| Dimension | Assessment |
| --- | --- |
| Complexity | Medium — new step kind, adapter port, policy default flip |
| Dependency cost | None — adapters are command templates |
| Safety | Policy-enforced, transcripted, sandboxable per existing `--sandbox` |
| Cache semantics | Explicit and documented |

**Pros:** agent execution inherits every existing boundary; evidence model extends naturally; agent-CLI-agnostic.
**Cons:** grows the frozen-at-1.0 config surface; cache-key composition for prompts needs careful spec (prompt templates referencing ctx must resolve before keying, like deferred `sh`).

### Option B: Status quo — agents via plain `sh`

| Dimension | Assessment |
| --- | --- |
| Complexity | Zero |
| Dependency cost | Zero |
| Safety | Policy sees the launch command only; agent tool calls unbounded |
| Cache semantics | Accidental — nondeterminism hidden behind a normal-looking step |

**Pros:** works today; no API growth.
**Cons:** every guarantee this package markets (inspectable boundaries, evidence, explicit cache) is silently absent exactly where it matters most; no transcript; no redaction of model output.

### Option C: Separate `@async/pipeline-agent` package wrapping a model SDK

| Dimension | Assessment |
| --- | --- |
| Complexity | High — SDK version churn, per-vendor surface |
| Dependency cost | Contained to opt-in package, but real |
| Safety | Strong (API-level tool gating) but vendor-coupled |
| Cache semantics | Same questions as A |

**Pros:** richer control than CLI spawning (structured tool calls, token budgets).
**Cons:** picks vendors; duplicates what agent CLIs already do; the core still needs the step type for metadata, so this is A plus an SDK, not instead of A.

## Trade-off Analysis

The real decision is B versus A: whether agent invocation is *visible to the model of the pipeline*. Everything this project claims — inspectable commands, evidence under `.async/`, explicit cache behavior — argues that an execution class with different trust properties must be a different step kind. Option C is a later refinement of A's adapter port, not a competitor: if a team wants SDK-level control, the adapter interface is where it plugs in.

The riskiest piece of A is cache semantics. Replaying a cached artifact that a model produced is correct under this package's own definition (key = inputs + steps + dependencies), but humans may expect "agent task" to mean "fresh thinking each run". The mitigation is the explicit rule plus `--force` already existing for exactly this intent.

## Consequences

- Easier: ADR-0004 (self-healing), ADR-0005 (review), and ADR-0006 (claims triage) all become "an `agent()` task with a particular prompt and policy" instead of bespoke machinery.
- Easier: auditing — "what did the model touch" is answerable from the run record.
- Harder: the 1.0 freeze — `agent()`, `agents`, and adapter config join the surface that must stop moving; see [Path to 1.0](../path-to-1.0.md).
- Revisit: default-deny ergonomics after first real pipelines; verifier enforcement; per-step token/cost budgets.

## Action Items

1. [ ] Spec the adapter port interface and `agents` config block in `pipeline-core` (types + validation, no execution).
2. [ ] Implement execution in `pipeline-node`: spawn through command executor, transcript capture, redaction, policy default flip.
3. [ ] Extend cache-key composition spec in [docs/api.md](../api.md) and `computeTaskCacheKey` for agent steps.
4. [ ] Register claims (policy default-deny, transcript location, cache-replay rule) in `tests/claims.json` with `PROMISE:` tests; CHANGELOG entry; regenerate sync surfaces.
5. [ ] Ship one example under `examples/` exercised by `release:check`, mocking the agent CLI via `command.mock(...)` so CI needs no model.
