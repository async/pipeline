# Changelog

## 0.1.0 - 2026-06-10

First public release candidate for `@async/pipeline`.

### Features

- Publish only `@async/pipeline`; the core, node, and Lima workspace packages are private implementation packages bundled into the public package.
- Add metadata-safe cache registry primitives with built-in `file` and `memory` stores, default pipeline cache refs, and validation for unknown stores or strategies.
- Add task run-array composition with static directives such as `cache.use(...)` and `dependsOn(...)`.
- Add `@async/pipeline/runtime` with `defineRuntime`, `createRuntime`, runtime `task`, cache directives, dependency ordering, and start/stop hooks.
- Generate a thin GitHub Actions bootloader from `pipeline.ts` with committed workflow and lock files.
- Add `async-pipeline github generate`, `async-pipeline github check`, and `async-pipeline github run`.
- Support custom GitHub workflow and lock output paths for tests and local experiments.
- Dogfood the generated GitHub workflow for pull requests, pushes to `main`, manual dispatch, and GitHub release events.
- Rewrite the README and docs around the MVP flow: define one `pipeline.ts`, run it locally, inspect it, generate GitHub Actions, and keep runtime primitives advanced.

### API Changes

- Add `defineCache`, `memoryCache`, `fileCache`, `redisCache`, `customCache`, `cache.use`, and cache ref parsing such as `"file:cache-first"`.
- Add pipeline-level `cache` config and task-level cache refs.
- Add `trigger.cron(...)`; keep `trigger.schedule(...)` as a compatibility alias.
- Extend `trigger.github(...)` with `branches`, `paths`, and `tags`.
- Add the `dependsOn(...)` directive while keeping task `dependsOn` as the canonical graph field.
- Add `task(config, run)` and `task(config, [runOrDirective, ...])` overloads.
- Throw `ASYNC_PIPELINE_TASK_ARGUMENT_CONFLICT` when `config.run` is combined with a second task argument.
- Export runtime primitives from `@async/pipeline/runtime`.

### Operational Changes

- Replace the hand-written CI workflow with generated `.github/workflows/async-pipeline.yml`.
- Add `.github/async-pipeline.lock.json` so CI can fail when generated GitHub Actions files are stale.
- Keep the generated GitHub workflow pinned to full action SHAs with tag comments and `contents: read` permissions.
- Keep `.async/` as local runtime state; GitHub generation state lives under `.github/`.
