# Changelog

## 0.9.12 - 2026-06-19

### Features

- Add `async-pipeline github plan` and a local GitHub manifest harness so generated jobs can be inspected and simulated by event, selected job, matrix, permissions, artifacts, pinned action refs, and mocked network policy before a live GitHub Actions run.

## 0.9.11 - 2026-06-19

### Fixes

- Make the self `sync-check` task depend on `build` so generated release verification cannot race stale `packages/pipeline-node/dist` output.

## 0.9.10 - 2026-06-19

### Features

- Add generated agent evidence bundling through `async/actions/agent-evidence` so agent prompts, redacted transcripts, context packs, explicit outputs, evidence receipts, and optional comment summaries stay outside the published package.

## 0.9.9 - 2026-06-19

### Features

- Route generated package preview install comments through `async/actions/comment` with explicit token inputs, stable markers, bounded bodies, and same-repo pull request guards.

## 0.9.8 - 2026-06-19

### Features

- Add generated release planning, package inspection, changelog, release-note, and doctor evidence steps through `async/actions/doctor` and `@async/release`, while keeping registry and GitHub Release writes in `async/actions/publish`.

## 0.9.7 - 2026-06-19

### Features

- Add `sync.github.attest` so generated release lifecycle jobs can create subject digest manifests, SBOM evidence, tarball-scan receipts, and optional GitHub attestation intent through `async/actions/attest` while keeping publish ownership in `async/actions/publish`.

## 0.9.6 - 2026-06-19

### Features

- Add generated task-cache manifests and `async/actions/cache` restore/save steps so GitHub task-cache keys come from pipeline-declared task inputs while saves stay disabled on pull requests.

## 0.9.5 - 2026-06-19

### Features

- Add `sync.github.sourceImpact` so generated workflows can write static source plans, emit source matrices through `async/actions/source-impact`, validate source checkout and prepare metadata, and collect source receipts through generated evidence artifacts.

## 0.9.4 - 2026-06-18

### Features

- Add `sync.github.evidence` so generated workflows can collect manifest-backed evidence artifacts from each job and merge them through a generated fan-in job using `async/actions/evidence`.

## 0.9.3 - 2026-06-18

### Features

- Add `sync.github.bridge` object form so generated workflows can render an `async-bridge` job that runs on manual dispatch or a configured schedule, enforces branch-prefix and allowed-path constraints through `@async/github-app`, records bridge identity in the generated lock, and scopes the Async project token to the bridge pull step.

## 0.9.2 - 2026-06-18

### Fixes

- Pin every generated remote GitHub Action reference, including `async/actions/*`, to a reviewed full SHA, record the resolved action manifest in `.github/async-pipeline.lock.json`, and fail `github check` when committed generated workflows contain mutable remote action refs.
- Scope generated lifecycle publish and preview secrets to the exact Async action step that needs them, and keep lifecycle commands in `async/actions/run` when shell syntax, flags, retries, or timeouts cannot be lowered with equivalent semantics.

## 0.9.1 - 2026-06-18

### Fixes

- Render pipeline lifecycle publish tasks as `async/actions/preview` and `async/actions/publish` steps in generated GitHub Actions, so downstream repos can keep `pipeline.ts` release/snapshot tasks while the published `@async/pipeline` tarball remains free of release networking code.

## 0.9.0 - 2026-06-18

### Breaking

- Move generated GitHub workflow run evidence, Pages, preview publishing, and Dependabot merge step logic to `async/actions`; `@async/pipeline` now emits reusable `async/actions/*` steps for those phases and the published npm tarball no longer ships release lifecycle GitHub API networking.

### Features

- Add `sync.github.setup: "async"` as an explicit opt-in setup provider backed by `async/actions/setup`, while keeping the generated default on the existing pinned `pnpm/setup` provider until the Async setup action is tested more broadly.
- Add `github.pages.build.kind: "prerender"` for static GitHub Pages deployments that build or prerender SSR output to files before upload.

## 0.8.9 - 2026-06-18

### Fixes

- Restore the setup-node/Corepack fallback for generated workflows when the consuming repo pins a pnpm version without `pnpm runtime`, so pnpm 10 projects do not fail during the setup step before pipeline tasks run.

## 0.8.8 - 2026-06-18

### Features

- Add `sync.github.pages` so generated GitHub Pages build/deploy jobs can be declared at the GitHub sync level from an existing docs task, letting repos remove repetitive local Pages job declarations while keeping `job({ github: { pages } })` as the lower-level compatibility form.

## 0.8.7 - 2026-06-17

### Fixes

- Render generated Deno runtime setup through pinned `denoland/setup-deno` steps instead of `pnpm runtime set deno ...`, while keeping `pnpm/setup` as the package-project Node and pnpm bootloader.

## 0.8.6 - 2026-06-17

### Features

- Add first-class Deno-only pipeline support: export the CLI as `@async/pipeline/cli`, add `sync.command` and `sync.github.runtime`, render Deno-only task and GitHub workflow commands without a `package.json`, enforce declared Node and Deno task runtimes before command execution, and ship a no-`package.json` Deno-only example.

## 0.8.5 - 2026-06-16

### Fixes

- Use the official `pnpm/setup` runtime bootloader in generated pnpm workflows so pnpm and the Node runtime are installed in one step without depending on `actions/setup-node` or a later Corepack step.

## 0.8.4 - 2026-06-16

### Fixes

- Render setup-node/Corepack bootstrapping for generated workflows when the consuming repo pins a pnpm version that does not support `pnpm runtime`, while keeping the pnpm runtime shim for compatible pnpm versions.

## 0.8.3 - 2026-06-16

### Fixes

- Render generated GitHub workflows with the consuming repo's declared pnpm version so `pnpm/setup` does not fail when `packageManager` differs from the pipeline repo's pnpm version.

## 0.8.2 - 2026-06-16

### Fixes

- Stop rendered GitHub Release descriptions at the next level-two changelog heading so non-release sections after a version do not bleed into that release body.

## 0.8.1 - 2026-06-16

### Fixes

- Require changelog release headings to put `## <version> - <date>` on one line so dateless headings are rejected instead of misreading the first bullet as a date.

## 0.8.0 - 2026-06-16

### Breaking

- Treat `CHANGELOG.md` as the canonical source for semver GitHub Release descriptions: `release ensure` now updates existing GitHub Release bodies when they drift, and `release doctor` fails when any semver GitHub Release body does not match its changelog section.

## 0.7.0 - 2026-06-16

### Features

- Add executable cache store adapters through `customCache({ adapter })`. Adapters require only `get` and `put` for opaque blobs while the runner keeps ownership of cache keys, input manifests, TTL checks, output validation, baselines, and cache receipts.
- Add optional cache store lifecycle methods: `list`, `delete`, `touch`, and `prune`, with implementations for the built-in file, memory, and Redis stores.
- Make `redisCache(...)` executable against a user-supplied Redis URL without adding a Redis npm dependency.
- Store declared task outputs as validated output blobs for cache entries, so file, memory, and custom adapter stores use the same restore path while legacy result-only output entries still downgrade to misses.

## 0.6.2 - 2026-06-15

### Features

- Generated GitHub workflows now default `sync.github.setup: "auto"` to the pinned pnpm runtime shim, with `setup: "node"` available for the older setup-node/Corepack bootloader.

### Fixes

- Package preview jobs now only run for pull request events instead of trying to publish PR previews from push or release events.
- GitHub release triggers can now render activity `types`, and the self pipeline listens only for published releases to avoid duplicate publish runs.
- npm package publishing now supports both npm trusted publishing/OIDC and token-backed publishing: token-backed runs create a temporary npmjs auth config, while tokenless runs leave auth to trusted publishing and skip the npm access command that OIDC cannot authenticate.

## 0.6.1 - 2026-06-15

### Features

- Generated GitHub workflows now enable `actions/setup-node` dependency-store caching when `sync.github.dependencyCache` is true and a recognized package-manager lockfile exists.
- Add generated `sync.github.dependabotAutoMerge` and `sync.github.packagePreviews` jobs so repos can opt into guarded Dependabot auto-merge and PR package previews with `true` defaults.
- Replace direct self-hygiene scripts and task ids with `@async/hygiene`, leaving only the `hygiene` pipeline task as the release pack gate.

## 0.6.0 - 2026-06-15

### Breaking

- Change `async-pipeline explain --run <run-id> --format json` from the old context-pack array to a run-evidence object that includes execution, graph, cache receipt, log, and context-pack paths.

### Features

- Add the internal graph IR as the runner scheduling boundary while keeping `buildGraph()` and `tasksForJob()` on the existing public projection shape.
- Write `.async/runs/<run-id>/graph.json` for each run with the selected job's execution order, graph nodes, dependency edges, effect metadata, and structural node fingerprints.
- Write per-task cache receipts under `.async/runs/<run-id>/cache/` and extend `explain --run <run-id|latest>` to summarize execution, graph, cache, logs, and failure context evidence together.
- Generated GitHub workflows now print `async-pipeline explain --run latest` on failure and upload `.async/runs` as pinned run-evidence artifacts.
- Dogfood actionlint, publint, Are The Types Wrong, dependency-cruiser, and Knip in the self pipeline release gate so workflow YAML, publish metadata, package type resolution, dependency boundaries, and unused surface checks run before pack.

## 0.5.0 - 2026-06-14

### Breaking

- Agent tasks now default to uncached by inspection. A task containing `agent(...)` no longer inherits broad `taskDefaults.cache`; cache model output only by opting in on the task itself with `cache: true`, a cache ref/options object, or a task-owned `cache.use(...)` directive.

## 0.4.4 - 2026-06-14

### Fixes

- Prune previously generated task-sync package scripts when they are removed from `pipeline.ts`, and report obsolete managed commands during `async-pipeline sync check`.

## 0.4.3 - 2026-06-14

### Fixes

- Retry release doctor registry checks so GitHub Actions releases tolerate npm and GitHub Packages propagation after a successful publish.

## 0.4.2 - 2026-06-14

### Fixes

- Align quickstart, examples, and MCP host docs with the pnpm task standard: use `pnpm run <task>` for package scripts and `pnpm dlx` where a one-off CLI invocation is intended.
- Fix the GitHub-native preview package example so optional pnpm scripts use `pnpm run --if-present <task>` without forwarding `--if-present` into the script command.
- Add `async-pipeline release ensure --package <path>` so generated GitHub Actions can create or verify the release tag and GitHub Release before package publishing, without local tag or release commands.

## 0.4.1 - 2026-06-14

### Features

- Generated GitHub workflows now expose a required manual job selector for workflow_dispatch runs, and each manual-capable job is gated by the selected job id.
- Generated GitHub workflows can now render GitHub Pages build/deploy jobs from `job({ github: { pages } })`, so Pages builds run on pull requests and deploys run from `main` or selected manual dispatch.
- Add shared package lifecycle CLI commands for GitHub Packages previews/snapshots/releases, npm publishing, and release doctor checks with `--package <path>` package selection.
- Dogfood the shared lifecycle commands in the self pipeline publish chain, including release doctor verification after GitHub Packages and npm publish.
- Ship `@async/pipeline` API surface artifacts (`api-contract.json` and `API_SURFACE.md`) in the published package so the release ledger is available to downstream API contract checks.
- Dogfood `@async/api-contract` in the self pipeline by syncing `pipeline:api-surface` scripts and making the release pack gate validate API surface ledgers.

## 0.4.0 - 2026-06-14

### Breaking

- Change default pipeline config discovery order to `pipeline.ts`, `pipeline.js`, `pipeline.mjs`, `pipeline.mts`. Projects that keep both `pipeline.js` and `pipeline.mjs` in the same config root now select `pipeline.js`.

### Features

- Add `pipeline.mts` as a discovered config filename for root CLI commands, source pipeline loading, and candidate cache fingerprints.
- Source declarations that omit `pipeline` now use the same default discovery order as the root CLI. Keep `pipeline` explicit for non-default filenames or when multiple default names exist and one file must win.

## 0.3.0 - 2026-06-14

### Features

- Branded declaration protocol: helper factories now attach non-enumerable `Symbol.for("@async/pipeline.declaration")` metadata so `definePipeline()` can distinguish inert declaration nodes without changing JSON output or enumerable config shape. The brand is a discriminator only; normal validation still rejects unknown fields and unsupported declaration versions.
- Task groups: nested `tasks` objects flatten with `.` (`claims.default` -> `claims`, `claims.report` -> `claims.report`), group-local dependencies resolve before graph validation, and `:` remains reserved for source namespaces such as `storefront:claims.report`. `index` remains accepted as a compatibility alias for older task groups.
- Optional section factories (`tasks`, `jobs`, `triggers`, `sources`, `taskDefaults`, `agents`, `sandboxes`) support advanced composition without requiring ceremony in normal object-literal configs.

### Fixes

- Wire the publish job to GitHub `release` events as well as manual dispatch, so a tagged stable release runs the GitHub Packages mirror before npm publishing and still enforces release tag/package version parity.
- Keep the private workspace package version in lockstep with the published `@async/pipeline` package during release-drift checks.
- Align the GitHub Packages preview/snapshot/fallback docs, preview install comments, and script defaults with the live `async/pipeline` repo owner scope (`@async/pipeline` on `npm.pkg.github.com`).

## 0.2.4 - 2026-06-13

### Features

- Container sandbox abstraction: `sandbox.container(...)` now declares portable OCI image intent, execution profiles select local or GitHub providers, and generated GitHub workflows pass `--execution <id>` while raw `job.github` runner fields remain the override path.
- Propose-only agent artifacts: `agent({ stdoutTo })` lands the adapter's stdout as a task artifact (relative paths only; declare it in `outputs` to cache and restore it). The transcript keeps the redacted copy; the artifact is the agent's product. `doctor` gains an `agent-outputs` check that warns when an agent task declares no outputs.
- Claims triage (ADR-0006, repair half): the self pipeline's `claims-repair` task drafts `claims.patch` — a unified diff updating stale anchors in `tests/claims.json` to the docs' current wording — via the `claude` profile locally or a deterministic mechanical mock (`ASYNC_AGENT=mock`, `scripts/mock-claims-repair.mjs`). Propose-only: a human reviews and `git apply`s; `claims:check` stays the only authority. The promise-discovery half (claims-scout) is not yet built.
- New example [agent-claims-repair](examples/agent-claims-repair/README.md): the propose/dispose agent pattern end to end — mini checker as deterministic authority, mock adapter profile emitting an applicable unified diff with one line of context per hunk, full circle exercised by the examples suite. Doubles as ADR-0001's canonical `agent()` example.

## 0.2.3 - 2026-06-12

### Features

- MCP server: `async-pipeline mcp` serves the inspection surface (`list_tasks`, `graph`, `explain_task`, `metadata`, `list_runs`, `read_run`, `diff_inputs`) over stdio as line-delimited JSON-RPC 2.0, hand-rolled with zero added dependencies. Read-only by default; `--allow-run` additionally exposes `run_job`, which acquires the same run lock, writes the same records, and replays the same cache as a CLI run. Design: docs/adr/0002-mcp-server.md.
- Failure context packs: failed tasks write `.async/runs/<run-id>/context/<task>.json` with the error, a redacted 4 KiB log tail, the reproduction command, the input diff against the task's last passing cache entry (content digests only), and — when `tests/claims.json` exists — the claim ids whose test titles appear in the log. Backed by per-file digest manifests (`inputs.json`) persisted with every cache entry and per-task baseline pointers pruned by `gc`. Inspect with `explain --run <run-id>` and `explain <task> --diff-inputs` (text or `--format json`). Design: docs/adr/0003-failure-context-packs.md.

## 0.2.2 - 2026-06-12

### Features

- Agent steps: `agent({ use, prompt, model? })` runs a declared adapter profile from the new pipeline `agents` block (`{ command: ["claude", "-p"], model: "..." }`). The prompt is delivered on stdin via a prompt file recorded under `.async/runs/<run-id>/agents/`, and every invocation writes a request/response transcript (`<task>.jsonl`) redacted like task logs. Agent output is cached as an artifact: keys include the resolved profile id, model, and prompt — never the adapter's command path — so a cached agent task replays declared outputs without invoking the adapter. `use` and `model` accept `env.var(...)` for per-environment selection (e.g. a `mock` profile in CI). Profiles reject unknown fields with `ASYNC_PIPELINE_UNKNOWN_FIELD`; undeclared profile references fail with `ASYNC_PIPELINE_AGENT_UNKNOWN`. Design: docs/adr/0001-agent-step-type.md; reference: docs/api.md "agents".

## 0.2.1 - 2026-06-12

### Fixes

- The published bin runs the CLI again: `async-pipeline` invoked through the public package entrypoint (`dist/cli.js`, including npm/pnpm bin shims and `npx async-pipeline`) parsed nothing and exited 0 on 0.2.0, because the wrapper module never satisfied the internal CLI's entrypoint guard. The wrapper now calls the exported `runCliMain()` explicitly, the guard realpath-resolves `argv[1]` so symlinked bin paths count as direct execution, and a regression test drives the public bin both directly and through a symlink.

### Features

- Build out all planned examples — `basic-node-package`, `monorepo-package-selection`, `deno-worker`, `many-repo-impact-run`, `custom-cache-registry`, and `runtime-middleware-stack` — each runnable from its own directory with committed generated sync artifacts where sync is configured.
- Add an `examples` task to the self pipeline (wired into `release:check`): every example's verification job runs green from its own directory through the public CLI, committed sync artifacts are checked for drift, cached re-runs and output restoration are asserted, the many-repo matrix output is asserted, and the declared-only remote cache store is proven to fail with its recorded reason.
- Failed `run`, `run-task`, and `github run` invocations now print each failed task's recorded error to stderr next to the final status line, instead of leaving the reason only inside `.async/runs/<id>/execution.json`.

## 0.2.0 - 2026-06-11

### Breaking

- Require Node `>= 24`. `pipeline.ts` loads through native type stripping; the loader reports a clear error on older Node versions. (`engines` on 0.1.x incorrectly claimed `>=20`.)
- Remove the inert task fields `with` and `continuous` from `TaskDefinition`.
- `async-pipeline github run` on `workflow_dispatch` now runs only jobs with a `manual` trigger instead of every job. Select other jobs explicitly with `github run --job <id>`.
- Docker sandboxes now forward only pipeline-defined env, `ASYNC_PIPELINE_*` context, declared `requires.secrets`, and `CI` into containers instead of the entire host environment.
- `command.requireEnvironment(...)` is enforced: the command fails unless `ASYNC_PIPELINE_ENVIRONMENT` matches the required name. Previously it silently allowed.
- Rename the local isolation concept from workspaces to sandboxes: `workspaces` config is now `sandboxes`, the `workspace.*` helpers are now `sandbox.*`, and `--workspace <id>` is now `--sandbox <id>` (the 0.1.4 names collided with pnpm workspaces and `GITHUB_WORKSPACE`).
- Flatten the programmatic run API: `runJob`, `runSingleTask`, `planJob`, and `runPipelineCli` now take `cwd`, `env`, `commands`, and `sandbox` options directly. `hostWorkspace`, `dockerWorkspace`, `limaWorkspace`, and the `PipelineWorkspace` type are removed; select isolation with `sandbox: "<id>"` or an inline `sandbox.lima(...)`/`sandbox.docker(...)` definition (`resolveExecutionContext` exposes the resolved context).
- Remove the inert task `environment` field (`PipelineEnvironment`, `EnvironmentBackend`, the `linux(...)` helper, and the per-task Lima `vm` override). Sandboxes are the isolation surface. Task cache keys no longer include the field, so existing cache entries invalidate once.
- Remove the declared-only `memory`, `ssh`, and `github` sandbox kinds; a sandbox is `host`, `lima`, or `docker`. New kinds return when they can actually execute.
- Reject unknown config fields in `definePipeline`, tasks, `taskDefaults`, jobs, and job `github` config with `ASYNC_PIPELINE_UNKNOWN_FIELD`, so typos like `timout` fail loudly instead of being silently ignored (found when async-webapps carried an inert `mode` field for its whole life).

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
- Add `github.permissions.issues`, `github.permissions.packages`, and `github.permissions.pullRequests` job options for generated GitHub Actions jobs that publish packages or comment on PRs. When a job grants any permission, the generator restates `contents: read` automatically (job-level permissions replace the workflow defaults). Unknown permission fields fail with `ASYNC_PIPELINE_UNKNOWN_FIELD`.
- Dogfood GitHub Packages publishing through the self pipeline (`scripts/publish-github.mjs`, adapted from the GitHub-native npm preview packages Gist that `examples/github-native-npm-preview-package` is based on): stable releases mirror to GitHub Packages under the repository-owner scope before npm publishes, green pushes to `main` publish immutable `0.0.0-main.sha.<sha>` snapshots behind a moving `main` dist-tag, and same-repo PRs publish `0.0.0-pr.<n>.sha.<sha>` previews with a `pr-<number>` dist-tag and one upserted install-instructions PR comment. Fork PRs never publish, and republishing an existing immutable version skips cleanly. The publish script refuses to treat registry availability failures as a missing version, enforces release tag/package.json version parity on `release` events, and derives its GitHub Packages auth config from the registry URL (GHES-compatible).
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
- Run the self pipeline's `verify` job on a runner matrix of GitHub-hosted `ubuntu-latest` and `macos-latest`; self-hosted Tart-backed Apple Silicon runners remain supported via `runsOn`/`runsOnMatrix` (setup guide in docs/github-actions.md).
- Document the exit-code contract, environment variables, run lock, execution record schema, platform support, source SHA pinning, and the path to 1.0.
- Build the docs site through an explicit GitHub Pages workflow (`.github/workflows/pages.yml`): docs stay plain markdown that renders on GitHub, and Jekyll runs as a CI build step instead of branch magic.
- Check docs drift in the pipeline: `scripts/check-docs.mjs` (the self pipeline's `docs` task, wired into `release:check`) fails on broken relative links or anchors in README.md and docs/.
- Move internal agent goal state from `docs/goals/` to `goals/` so the published docs tree is only documentation.
- Dogfood release verification end to end: `release:check` is now `pnpm run build && async-pipeline run verify --force`, with a `sync-check` task gating `pack` — the shell chain that duplicated the pipeline's orchestration is gone.

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
