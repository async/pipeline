# API Reference

This is the first public API surface for `@async/pipeline`.

## Imports

```ts
import { definePipeline, job, sh, task, trigger } from "@async/pipeline";
```

Subpaths are available for advanced use:

```ts
import { definePipeline } from "@async/pipeline/core";
import { runJob } from "@async/pipeline/node";
import { LimaRunnerAdapter } from "@async/pipeline/lima";
```

## definePipeline

```ts
definePipeline({
  name: "app",
  namedInputs: {},
  taskDefaults: {},
  triggers: {},
  tasks: {},
  jobs: {}
});
```

Fields:

| Field | Purpose |
| --- | --- |
| `name` | Pipeline name written into execution records. |
| `namedInputs` | Reusable input groups referenced by task `inputs`. |
| `taskDefaults` | Defaults applied by exact task id or task name segment. |
| `triggers` | Named trigger declarations. |
| `tasks` | Task map. |
| `jobs` | Job map. |

## task

```ts
task({
  description: "Build the app",
  dependsOn: ["typecheck"],
  inputs: ["src/**/*.ts", "package.json"],
  outputs: ["dist/**"],
  cache: true,
  retry: { attempts: 2, delayMs: 500 },
  timeout: "2m",
  requires: { tools: ["node", "pnpm"] },
  environment: { backend: "host" },
  run: sh`pnpm build`
})
```

Fields:

| Field | Purpose |
| --- | --- |
| `dependsOn` | Task ids that must run before this task. |
| `inputs` | Files or named input groups that affect cache keys. |
| `outputs` | Files produced by the task. Included in metadata and cache config. |
| `cache` | `true`, `false`, or cache options. |
| `retry` | Number of attempts or `{ attempts, delayMs }`. |
| `timeout` | Milliseconds or a duration string such as `500ms`, `30s`, `5m`, `1h`. |
| `requires` | Tool, secret, or runtime declarations. |
| `environment` | Backend declaration such as host or Lima. |
| `run` | One shell command or function step. |
| `steps` | Multiple shell commands or function steps. |

## sh

```ts
task({
  run: sh`pnpm test`
})
```

`sh` creates a shell step. The host runner executes it with `shell: true` from the project root.

## Function Steps

```ts
task({
  async run(ctx) {
    ctx.log(`running ${ctx.taskId}`);
    ctx.meta({ checked: true });
  }
})
```

Function steps receive:

| Field | Purpose |
| --- | --- |
| `taskId` | Current task id. |
| `runId` | Current execution id. |
| `cwd` | Project root. |
| `env` | Process environment. |
| `meta` | Add task metadata to the execution record. |
| `log` | Append to the task log. |
| `sh` | Create shell command values. |

## job

```ts
job({
  description: "Full verification",
  target: "build",
  trigger: ["push"],
  mode: "ci"
})
```

Fields:

| Field | Purpose |
| --- | --- |
| `target` | Task id or task ids used as the job entrypoint. |
| `trigger` | Trigger ids attached to the job. |
| `mode` | Optional `manual` or `ci` mode. |

## trigger

```ts
trigger.manual();
trigger.github({ events: ["push", "pull_request"] });
trigger.schedule("0 9 * * 1");
```

Triggers are declarations today. GitHub Actions still invokes the CLI explicitly with `async-pipeline run <job>`.

## Execution Record Shape

Runs are written to:

```txt
.async/runs/<run-id>/execution.json
```

The record includes:

```ts
interface ExecutionRecord {
  id: string;
  pipelineName: string;
  jobId: string;
  cwd: string;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "passed" | "failed";
  mode: "manual" | "ci";
  tasks: TaskResult[];
}
```

Task results include status, attempts, cache key, cache hit, timings, error, and metadata.
