# Agent Instructions

Rules for any coding agent (Codex, Claude, or other) working in this repo. They exist because "all checks pass" has shipped broken promises here before: the verification commands proved the code ran, not that the README's claims held. The rules below make the promises executable.

## Definition of done

A change is done only when ALL of these hold:

1. `pnpm release:check` passes. It bootstraps the CLI (`pnpm build`), then the self pipeline runs everything with `--force`: drift, claims, docs, sync checks, build, typecheck, tests, exports, and pack. There is no parallel shell orchestration; the pipeline is the orchestrator.
2. Every behavior you claim in README.md or docs/ is enforced by a test, and the claim -> test mapping is registered in `tests/claims.json`. Product promises belong in `tests/invariants.test.js`. `scripts/check-claims.mjs` (in `release:check` and the self pipeline's `claims` task) fails on stale anchors, claims pointing at missing tests, and unregistered `PROMISE:` tests. When you add a claim, register it; when you reword one, update its anchor; when you drop one, remove the entry. The checker proves the mapping exists, not that a test is sufficient — review still owns sufficiency.
3. Every config field is either enforced at runtime or rejected with a clear error. Fields that exist only as declared metadata must be documented as such in docs/api.md. Unknown fields fail with `ASYNC_PIPELINE_UNKNOWN_FIELD` — a typo like `timout` that is silently ignored changes behavior without warning, which is worse than a loud error.
4. Every API or behavior change has a CHANGELOG.md entry under the version being released. Breaking changes must be labeled as breaking.
5. Version bumps and CHANGELOG entries move together. `scripts/check-release-drift.mjs` enforces this; do not bypass it.
   - Semver pre-1.0: breaking changes bump the **minor** version (0.x.0) and get a `### Breaking` CHANGELOG section. Never ship a breaking change in a patch. The package is live on npm; people install it.
6. Bug fixes land with a regression test that fails before the fix and passes after.
7. Claimed environments are real. The `engines` floor must match across all package.json files, generated workflows must install Node at or above that floor, and anything the quickstart promises must work on the floor version. The drift check enforces the mechanical parts.
8. If you touch `pipeline.ts`, triggers, sync config, or the workflow generator: run `async-pipeline sync check`, and regenerate with `async-pipeline github generate` when stale — including the workflows under `examples/*`.
9. If you touch the scheduler, cache, or CLI output: run a real pipeline twice in a scratch directory and read the actual terminal output. Tests do not see interleaved or misordered output; eyes do.

## Cache semantics you must not break

These are the product's core promise (tested in `tests/invariants.test.js` and `tests/runner.test.js`):

- A task's cache key depends on the content of its own declared inputs, its dependencies' cache keys, and its resolved steps — never on unrelated tasks' inputs, absolute machine paths, or the task's own outputs.
- A second run of an unchanged pipeline is fully `cached`.
- A cache hit restores declared outputs, or downgrades to a recorded miss when it cannot.
- `.git/`, `.async/`, and `node_modules/` are pruned from input walks at any depth.
- Resolved secret values never appear in echoed output or stored run logs.

## Review discipline

Self-verification is not review. Before declaring a tranche complete, run an adversarial pass — a second agent or a fresh session — with this objective: "Find where the implementation betrays README.md and docs/, and prove it empirically with a scratch pipeline." The reviewer's job is to falsify claims, not to confirm that checks pass. A claim that cannot be exercised empirically should be treated as unverified.
