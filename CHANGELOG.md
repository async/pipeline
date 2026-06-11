# Changelog

## 0.2.0 - 2026-06-11

### Breaking

- Require Node `>= 24`. `pipeline.ts` loads through native type stripping; the loader reports a clear error on older Node versions. (`engines` on 0.1.x incorrectly claimed `>=20`.)
- Remove the inert task fields `with` and `continuous` from `TaskDefinition`.
- `async-pipeline github run` on `workflow_dispatch` now runs only jobs with a `manual` trigger instead of every job. Select other jobs explicitly with `github run --job <id>`.
- Docker workspaces now forward only pipeline-defined env, `ASYNC_PIPELINE_*` context, declared `requires.secrets`, and `CI` into containers instead of the entire host environment.
- `command.requireEnvironment(...)` is enforced: the command fails unless `ASYNC_PIPELINE_ENVIRONMENT` matches the required name. Previously it silently allowed.

### Features

- Restore `.async/cache` in generated GitHub workflows through a pinned `actions/cache` step (`sync.github.cache`, default on), so unchanged tasks resolve as `cached` in CI.
- Make the generated workflow Node version configurable with `sync.github.nodeVersion` (default `24`).
- Add `run`/`run-task` `--force` (bypass cache reads while still writing fresh entries) and `--dry-run` (print the plan with predicted cache hits without executing).
- Add `async-pipeline cache clear` and `async-pipeline gc [--keep <n>] [--cache-days <n>]` for task-cache and run-record maintenance.
- Prefix live task output lines with `[task-id]` so parallel runs stay readable.
- Stream CLI progress (plan and per-task status) while a run is executing instead of buffering it until the end.
- Add `run --format json` and `run-task --format json` emitting the full execution record (and the plan under `--dry-run`).
- Auto-prune run records to the newest 50 after each run; configure with `ASYNC_PIPELINE_KEEP_RUNS` (`0` disables).
- Find `pipeline.ts` from subdirectories by walking up to the config root.
- Add product-promise invariant tests (`tests/invariants.test.js`), release-drift checks (`scripts/check-release-drift.mjs`, wired into `release:check` and the self pipeline's `drift` task), and `AGENTS.md` definition-of-done rules for coding agents.
- Add an executable claim -> test coverage map: `tests/claims.json` registers documented claims with the tests that enforce them, and `scripts/check-claims.mjs` (wired into `release:check` and the self pipeline's `claims` task) fails on stale claim anchors, claims pointing at missing tests, and unregistered `PROMISE:` tests.
- Add `github.runsOn` and `github.runsOnMatrix` job options so generated GitHub Actions jobs can target hosted runners, self-hosted label sets, or a runner matrix.
- Have `doctor` warn about unreadable run directories and stale `"running"` records.

### Fixes

- Serialize local runs with `.async/run.lock`, reclaim stale locks from dead processes, and fail concurrent runs with `ASYNC_PIPELINE_RUN_ACTIVE`.
- Record `schemaVersion` and owner `pid` on execution records so local tools can reason about record format and stale owners.
- Refresh task-cache mtimes on cache hits and let `gc --cache-days <n>` prune cold entries.
- Prune `.git/`, `.async/`, and `node_modules/` at any path depth during input resolution, not only at the repo root.
- Redact resolved `env.secret(...)` and `requires.secrets` values from echoed task output and stored run logs.
- Reuse existing source checkouts during runs without refetching or force-checkout when the declared ref is already resolved; `sources sync` remains the explicit refresh that discards local edits.
- Never leave an execution record in `"running"`: unexpected scheduler errors finalize the record as failed.
- Kill the whole process tree on task timeout (process-group SIGTERM, then SIGKILL) instead of only the wrapping shell.
- Make the `publish` pipeline task idempotent: republishing an already-published version skips cleanly instead of failing.
- Forward SIGINT/SIGTERM to running task process groups (escalating to SIGKILL), skip retries, finalize the execution record, and exit `130`/`143`, so interrupting the CLI never orphans task processes or leaves a record `"running"`.
- Write execution records, cache results, output manifests, and logs atomically (write, fsync, then rename) so a crash cannot leave truncated state files.
- Cap in-memory task output buffers at 8 MiB per stream, byte-accurate (override with `ASYNC_PIPELINE_MAX_LOG_BYTES`, `0` = unlimited); logs keep the tail with a truncation marker instead of exhausting memory.
- Fail fast with `ASYNC_PIPELINE_INPUT_CYCLE` on `namedInputs` cycles instead of overflowing the call stack.
- Hash input files through streams so accidentally huge inputs cannot exhaust memory during cache-key computation.
- Terminate running tasks, finalize the run record, and exit `141` (128 + SIGPIPE) when CLI output is piped to a closed reader (EPIPE), instead of crashing or orphaning task processes.

### API Changes

- Export `planJob(...)` returning the execution order and predicted cache behavior for a job.
- Add `.npmrc` with `engine-strict=true` so installs enforce the Node floor.
- Pre-1.0 semver policy (see AGENTS.md): breaking changes bump the minor version; 0.1.5's breaking cache-ref rename in a patch is the counterexample this rule exists to prevent.

### Operational Changes

- License the repository and the published `@async/pipeline` package under MIT.
- Verify packaging before pack/publish: `scripts/check-exports.mjs` (wired into `release:check` and the self pipeline's `pack` task) fails when exports, bin, types, license, or files targets are missing from the built package.

## 0.1.5 - 2026-06-10

### API Changes

- Replace the legacy cache strategy API: cache refs now use store-prefixed policies such as `"file:local"` and `"memory:session"` instead of `"file:cache-first"`. This is a breaking change for pipeline configs that used strategy-style refs.

## 0.1.4 - 2026-06-10

### Features

- Run independent ready tasks in parallel with a deterministic scheduler and `--concurrency <n>` (default: min of 4 and available cores).
- Snapshot declared task `outputs` into the file cache with a sha256 manifest and restore them on cache hits; missing or corrupted outputs downgrade to a recorded cache miss.
- Chain dependency cache keys into dependents so upstream changes invalidate downstream tasks without global fingerprint coupling.
- Enforce task cache `ttlMs` when reading cache entries.
- Add named `workspaces` config with `--workspace <id>` selection and pipeline-level command policies applied to CLI invocations.

### Fixes

- Stop hashing the global candidate fingerprint and absolute paths into per-task cache keys, so unrelated input changes no longer invalidate every task.
- Exclude a task's own declared outputs from its input hashing to prevent self-invalidation.

## 0.1.3 - 2026-06-10

### Features

- Generate one GitHub Actions job per pipeline `job(...)` so job-level CI environment and permissions can be expressed from `pipeline.ts`.
- Add agnostic pipeline/job `env` config with `env.secret(...)` and overloaded `env.var(...)` values.
- Resolve env before task execution so missing secrets, missing variables, or unmapped variable values fail before shell commands run.

### Operational Changes

- Dogfood npm publishing through the generated async-pipeline workflow with an `npm-publish` GitHub environment and `NPM_TOKEN` org secret.

## 0.1.2 - 2026-06-10

### API Changes

- Change `parallel(...)` to optional config-first calling style: `parallel(items)` or `parallel(options, items)`.
- Reject second-argument runtime parallel options so config placement stays consistent.

## 0.1.1 - 2026-06-10

### Features

- Add Throwback-style runtime composition with public `compose(...)`, sequential array groups, explicit `parallel(...)`, and `branch(...)`.

### API Changes

- Export `compose`, `series`, `parallel`, and `branch` from `@async/pipeline/runtime`.
- Add structured runtime task and node failure reporting for task, series, parallel, branch, cache, and middleware boundaries.

## 0.1.0 - 2026-06-10

First public release candidate for `@async/pipeline`.

### Features

- Publish only `@async/pipeline`; the core, node, and Lima workspace packages are private implementation packages bundled into the public package.
- Add metadata-safe cache registry primitives with built-in `file` and `memory` stores, default pipeline cache refs, and validation for unknown stores or strategies.
- Add task run-array composition with static directives such as `cache.use(...)` and `dependsOn(...)`.
- Add `@async/pipeline/runtime` with `defineRuntime`, `createRuntime`, runtime `task`, cache directives, dependency ordering, and start/stop hooks.
- Generate a thin GitHub Actions bootloader from `pipeline.ts` with committed workflow and lock files.
- Add unified `sync` config for generated GitHub Actions files and package-manager task commands.
- Add `async-pipeline github generate`, `async-pipeline github check`, and `async-pipeline github run`.
- Add `async-pipeline sync list`, `sync generate`, `sync check`, `sync github ...`, and `sync tasks ...`.
- Support custom GitHub workflow and lock output paths for tests and local experiments.
- Sync package `scripts` and Deno `tasks` from pipeline jobs, with opt-in raw task commands under `pipeline:task:<id>`.
- Dogfood the generated GitHub workflow for pull requests, pushes to `main`, manual dispatch, and GitHub release events.
- Rewrite the README and docs around the MVP flow: define one `pipeline.ts`, run it locally, inspect it, generate GitHub Actions, and keep runtime primitives advanced.

### API Changes

- Add `defineCache`, `memoryCache`, `fileCache`, `redisCache`, `customCache`, `cache.use`, and cache ref parsing such as `"file:cache-first"`.
- Add pipeline-level `cache` config and task-level cache refs.
- Add `trigger.cron(...)`; keep `trigger.schedule(...)` as a compatibility alias.
- Extend `trigger.github(...)` with `branches`, `paths`, and `tags`.
- Add top-level `sync.github` and `sync.tasks` pipeline config.
- Add the `dependsOn(...)` directive while keeping task `dependsOn` as the canonical graph field.
- Add `task(config, run)` and `task(config, [runOrDirective, ...])` overloads.
- Throw `ASYNC_PIPELINE_TASK_ARGUMENT_CONFLICT` when `config.run` is combined with a second task argument.
- Export runtime primitives from `@async/pipeline/runtime`.

### Operational Changes

- Replace the hand-written CI workflow with generated `.github/workflows/async-pipeline.yml`.
- Add `.github/async-pipeline.lock.json` so CI can fail when generated GitHub Actions files are stale.
- Add `.async-pipeline/tasks.lock.json` so package-manager task sync can detect stale files and avoid overwriting unmanaged commands.
- Keep the generated GitHub workflow pinned to full action SHAs with tag comments and `contents: read` permissions.
- Keep `.async/` as local runtime state; GitHub generation state lives under `.github/` and task sync state lives under `.async-pipeline/`.
