# Running Locally

Local runs are the primary workflow. GitHub Actions should invoke the same pipeline command you already use on your machine.

Use `async-pipeline` when the command should be explicit. Short aliases and smart runner dispatch belong in `@async/run`.

## Common Commands

List jobs, tasks, and sources:

```sh
pnpm async-pipeline list
```

Run a job and its dependencies:

```sh
pnpm async-pipeline run verify
pnpm async-pipeline run verify --concurrency 2
```

Run one task and its dependencies through a synthetic job:

```sh
pnpm async-pipeline run-task test
pnpm async-pipeline run-task test --concurrency 1
```

The scheduler starts ready tasks in deterministic graph order and runs independent tasks in parallel up to the configured concurrency. Use `--concurrency 1` to force a sequential run when debugging task interactions.

Explain a task:

```sh
pnpm async-pipeline explain build
```

Render the graph:

```sh
pnpm async-pipeline graph --format json
pnpm async-pipeline graph --format dot
```

Read pipeline metadata without running anything:

```sh
pnpm async-pipeline metadata --format json
pnpm async-pipeline metadata --format json --include-sources
```

List and sync declared sources:

```sh
pnpm async-pipeline sources list
pnpm async-pipeline sources sync
```

Run a source task:

```sh
pnpm async-pipeline run-task storefront:test
```

Generate a GitHub matrix for source tasks in a job:

```sh
pnpm async-pipeline matrix verifyImpact --format github
```

Generate or check the GitHub Actions bootloader:

```sh
pnpm async-pipeline github generate
pnpm async-pipeline github check
pnpm async-pipeline sync github generate
pnpm async-pipeline sync github check
```

Generate or check package-manager tasks from `sync.tasks`:

```sh
pnpm async-pipeline sync tasks generate
pnpm async-pipeline sync tasks check
```

Use `--workflow <path>` and `--lock <path>` when you want to render/check generated files outside `.github/`, such as in tests.

Run environment checks:

```sh
pnpm async-pipeline doctor
```

Clear local task cache and prune local state:

```sh
pnpm async-pipeline cache clear
pnpm async-pipeline gc --keep 20 --cache-days 30
```

`gc` keeps the newest run records and prunes task-cache entries unused for `--cache-days` days. Cache hits refresh their last-used time, and `--cache-days 0` disables cache pruning.

## Inspect A Run

After `async-pipeline run verify`, inspect `.async/runs`:

```sh
ls .async/runs
cat .async/runs/<run-id>/summary.md
cat .async/runs/<run-id>/execution.json
cat .async/runs/<run-id>/graph.json
ls .async/runs/<run-id>/logs
```

`graph.json` records the selected job's execution order and node fingerprints. Per-task cache receipts under `.async/runs/<run-id>/cache/` explain whether each task was a cache hit, cache miss, cache-disabled run, or forced bypass, including dependency fingerprints without recording input file contents or secret values.

The execution record includes:

- run id
- pipeline name
- job id
- mode
- start and finish time
- overall status
- task statuses
- task attempts
- cache keys
- cache hit flags
- errors
- source metadata
- task metadata

Use `async-pipeline explain --run latest` to read the latest execution record, graph snapshot, cache receipts, logs, and failure context packs together.

## Cache Behavior

Enable cache per task:

```ts
task({
  inputs: ["src/**/*.ts", "package.json", "pnpm-lock.yaml"],
  outputs: ["dist/**"],
  cache: "file:local",
  run: sh`pnpm run build`
})
```

`cache: true` uses the pipeline cache default. Explicit refs such as `file:local` make task behavior clearer in examples and metadata.

On the next run, the task can be skipped when:

- the task config is the same
- resolved shell commands are the same
- declared input file contents are the same
- direct dependency cache fingerprints are the same
- source context is the same for source tasks
- the previous cached result passed
- `ttlMs`, when configured, has not expired

Task cache lives under:

```txt
.async/cache/tasks
```

Input resolution ignores `.git/`, `.async/`, and `node_modules/` by default. A task's declared `outputs` are also excluded from that task's input files, so `dist/**` or `packages/*/dist/**` cannot make a build dirty after it writes its own artifacts.

For file-cache tasks with declared outputs, cache entries include `result.json`, `outputs.json`, and copied output files. On a hit, outputs are restored before the task returns `cached`. Existing result-only entries for output-producing tasks are treated as misses and repopulated on the next successful run. Memory cache cannot restore files; it only honors output-producing hits while the output files from the previous run still exist.

Warm source checkouts live under:

```txt
.async/sources
```

Keep local run state out of git:

```gitignore
.async/
*.tgz
.tmp/
```

`.async/` contains run records, logs, task cache, source checkouts, and repo-local npm cache used by pack checks. `*.tgz` catches tarballs from pack commands. `.tmp/` is a good place for custom `github generate --workflow ... --lock ...` experiments.

When you deliberately want a clean local pipeline state:

```sh
rm -rf .async
```

## Retry And Timeout

Retry a flaky command:

```ts
task({
  retry: { attempts: 3, delayMs: 1000 },
  run: sh`pnpm run test`
})
```

Set a timeout:

```ts
task({
  timeout: "5m",
  run: sh`pnpm run build`
})
```

Supported timeout units:

```txt
ms
s
m
h
```

## Requirements

Declare required tools:

```ts
task({
  requires: {
    tools: ["node", "pnpm", "ollama"]
  },
  run: sh`ollama list`
})
```

The host runner checks tools with `command -v`. Ollama is an optional requirement declaration, not a package dependency.

## Config Files

The CLI searches the project root in this order:

```txt
pipeline.ts
pipeline.js
pipeline.mjs
pipeline.mts
```

Use `pipeline.ts` or `pipeline.mts` on Node 24. Use `pipeline.js` or `pipeline.mjs` when you want a plain JavaScript config.
