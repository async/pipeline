# How It Works

`@async/pipeline` separates definition, scheduling, execution, and storage. The goal is to keep project workflow logic local-first while making the execution backend replaceable.

## Core Objects

| Object | Owns |
| --- | --- |
| Pipeline | Graph shape, named tasks, jobs, triggers, named inputs, and defaults. |
| Task | Work unit, `dependsOn`, `inputs`, `outputs`, cache, retry, timeout, requirements, environment, and steps. |
| Job | Named entrypoint, trigger binding, target task or tasks, and execution mode. |
| Execution | One run, status timeline, task results, timings, logs, metadata, cache hits, and artifacts. |
| Scheduler | Graph resolution, deterministic task order, cache decisions, retries, timeout handling, and fail-fast behavior. |
| Runner | Actual command execution on the host, Lima, GitHub runner, or a future backend. |
| Store | `.async/cache`, `.async/runs`, task logs, summaries, and execution metadata. |
| Adapter | Backend-specific behavior such as host shell, Lima shell, GitHub runner, Ollama, or future remote runners. |

## Definition Flow

The CLI loads one config file from the project root:

```txt
pipeline.ts
pipeline.mjs
pipeline.js
```

The config must default-export `definePipeline(...)`.

```ts
import { definePipeline, job, sh, task } from "@async/pipeline";

export default definePipeline({
  name: "app",
  tasks: {
    build: task({ run: sh`pnpm build` })
  },
  jobs: {
    verify: job({ target: "build" })
  }
});
```

`definePipeline` normalizes the graph and validates:

- missing task dependencies
- missing job targets
- dependency cycles
- deterministic task ordering
- retry and timeout defaults

## Scheduling Flow

When you run:

```sh
async-pipeline run verify
```

the scheduler:

1. Loads and validates the pipeline config.
2. Expands the job target into the full dependency graph.
3. Computes a deterministic execution order.
4. Creates `.async/runs/<run-id>/execution.json`.
5. For each task, computes a cache key.
6. Replays a cached task result when the local cache has a passing result.
7. Runs shell or function steps for dirty tasks.
8. Applies retry and timeout policy.
9. Writes task logs and updates the execution record.
10. Stops on first failed task.

Task execution is sequential in this tranche. Parallel scheduling is planned next.

## Cache Keys

A task cache key includes:

- pipeline name
- task id
- `dependsOn`
- declared `inputs`
- declared `outputs`
- cache config
- retry config
- timeout config
- requirements
- environment declaration
- shell step commands
- contents of resolved input files

Input patterns support common glob shapes such as:

```txt
src/**/*.ts
packages/*/package.json
!src/**/*.test.ts
```

Cache is local only:

```txt
.async/cache/tasks/<cache-key>/result.json
```

To make a task dirty when a file changes, include that file or glob in `inputs`.

## Execution Records

Each run writes:

```txt
.async/runs/<run-id>/execution.json
.async/runs/<run-id>/summary.md
.async/runs/<run-id>/logs/<task>.log
```

`execution.json` is the durable machine-readable record. `summary.md` is the quick human-readable view.

## Runners And Adapters

The CLI uses the host runner by default. It executes shell steps with the current working directory and environment.

The Lima adapter is exported from `@async/pipeline/lima` and can be used programmatically with `runJob`:

```ts
import { LimaRunnerAdapter, runJob } from "@async/pipeline";
import pipeline from "./pipeline.js";

await runJob(pipeline, {
  cwd: process.cwd(),
  jobId: "verify",
  adapter: new LimaRunnerAdapter("async-pipeline")
});
```

The current CLI does not automatically route tasks to Lima based on `environment.backend`. That routing is a future scheduler feature.
