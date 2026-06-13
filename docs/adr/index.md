# Design Decisions: Agentic Features

Architecture decision records for adding AI-agent features to `@async/pipeline`. All six are **Proposed** — nothing in these documents is a shipped claim. Per [AGENTS.md](../../AGENTS.md) rule 2, a behavior enters [tests/claims.json](../../tests/claims.json) only together with the implementation and tests that enforce it.

The records share one thesis: the repo already has the right primitives — [command policy](../api.md#command-policy), [metadata-safe inspection](../api.md#metadata), [run evidence under `.async/`](../how-it-works.md#5-write-records-and-cache), and [opt-in sandboxes](../how-it-works.md#sandboxes-and-executors). Agentic features should compose these primitives, not bypass them.

## The Records

| ADR | Title | Status | Depends on |
| --- | --- | --- | --- |
| [ADR-0001](0001-agent-step-type.md) | `agent()` as a first-class task step | Accepted (v1 in 0.2.2) | — |
| [ADR-0002](0002-mcp-server.md) | An MCP server surface for the CLI | Accepted (v1 in 0.2.3) | — |
| [ADR-0003](0003-failure-context-packs.md) | Failure context packs and per-file input digests | Accepted (v1 in 0.2.3) | — |
| [ADR-0004](0004-self-healing.md) | Bounded self-healing via `onFail` agent hooks | Proposed | 0001, 0003 |
| [ADR-0005](0005-adversarial-review.md) | Adversarial review as a pipeline pattern | Proposed | 0001 |
| [ADR-0006](0006-claims-triage.md) | Claims triage automation | Accepted (repair in 0.2.4; scout open) | 0001, 0003 |

## Suggested Order

ADR-0002 (MCP server) and ADR-0003 (context packs) are read-only surfaces with no model in the loop; they are useful to every agent immediately and carry the least risk. ADR-0001 (the `agent()` step) is the load-bearing decision the rest build on. ADR-0006 (claims triage) is the smallest end-to-end consumer and the right first proof. ADR-0005 (adversarial review) productizes an existing manual discipline. ADR-0004 (self-healing) is deliberately last: it has the largest blast radius and should not land before the others have proven the boundaries.

## Cross-Cutting Constraints

Every record inherits these non-negotiables from the existing product promises:

- **Secret redaction extends to transcripts.** Resolved secret values never appear in echoed output or stored run logs today; agent transcripts and context packs are new output channels and must flow through the same redaction.
- **Cache purity.** Agent involvement must never make a cache key depend on anything outside the documented key composition (own declared inputs, dependency cache keys, resolved steps). Nondeterministic model output is an artifact, never key material.
- **Metadata stays inert.** Importing a pipeline or reading metadata must not invoke a model, exactly as it must not clone repos or evaluate deferred shell callbacks today.
- **Local-first.** Agents run where the pipeline runs. CI invokes the same graph; no feature may require a hosted service to function.
- **Zero runtime dependencies.** Any protocol or adapter code ships dependency-free or in an optional package, never as a mandatory dependency of `@async/pipeline`.
- **Definition of done applies.** Each feature lands with registered claims, enforcing tests, a CHANGELOG entry, and regenerated sync surfaces — see [AGENTS.md](../../AGENTS.md).
