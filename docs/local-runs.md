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
```

Run one task and its dependencies through a synthetic job:

```sh
pnpm async-pipeline run-task test
```

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
```

Use `--workflow <path>` and `--lock <path>` when you want to render/check generated files outside `.github/`, such as in tests.

Run environment checks:

```sh
pnpm async-pipeline doctor
```

## Inspect A Run

After `async-pipeline run verify`, inspect `.async/runs`:

```sh
ls .async/runs
cat .async/runs/<run-id>/summary.md
cat .async/runs/<run-id>/execution.json
ls .async/runs/<run-id>/logs
```

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

## Cache Behavior

Enable cache per task:

```ts
task({
  inputs: ["src/**/*.ts", "package.json", "pnpm-lock.yaml"],
  outputs: ["dist/**"],
  cache: "file:cache-first",
  run: sh`pnpm build`
})
```

`cache: true` uses the pipeline cache default. Explicit refs such as `file:cache-first` make task behavior clearer in examples and metadata.

On the next run, the task can be skipped when:

- the task config is the same
- resolved shell commands are the same
- declared input file contents are the same
- source context is the same for source tasks
- the previous cached result passed

Task cache lives under:

```txt
.async/cache/tasks
```

Warm source checkouts live under:

```txt
.async/sources
```

When you deliberately want a clean local pipeline state:

```sh
rm -rf .async
```

## Retry And Timeout

Retry a flaky command:

```ts
task({
  retry: { attempts: 3, delayMs: 1000 },
  run: sh`pnpm test`
})
```

Set a timeout:

```ts
task({
  timeout: "5m",
  run: sh`pnpm build`
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
pipeline.mjs
pipeline.js
```

Use `pipeline.ts` on Node 24. Use `pipeline.mjs` or `pipeline.js` for Node 20+.
