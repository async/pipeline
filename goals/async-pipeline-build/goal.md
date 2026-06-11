# Build `@async/pipeline`

## Original Request

Implement the planned `@async/pipeline` repo as a pnpm monorepo that dogfoods itself with typed local-first workflows.

## Outcome

Create `/Users/patrickjs/code/async-framework/async-pipeline` with core task/pipeline/job/execution primitives, local cache/store, scheduler, Node CLI, host runner, Lima adapter, self `pipeline.ts`, thin GitHub Actions workflow, and verification that the repo can run its own `verify` job.

## Input Shape

existing_plan

## Goal Oracle

The tranche is complete when these commands pass from the repo root:

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm async-pipeline run verify
pnpm pack:check
```

The final audit must also confirm the expected package split, public API surface, `.async/` local run/cache paths, and thin pinned GitHub workflow exist.

## Constraints

- Use pnpm, Node ESM, TypeScript, Node `>=20`, and exact dev dependency versions.
- Keep runtime dependencies minimal and integrations optional.
- Keep task primitives in the same repo/package family; do not create a separate `@async/task` package.
- Treat GitHub Actions as a thin runner invocation layer.
- Recheck npm name availability before any future publishing.

## Likely Misfire

Stopping after a scaffold or planning artifact instead of proving the package can build, test, and run its own pipeline.

## Current Tranche

Build the first usable local-first implementation and prove it with self-dogfood verification.
