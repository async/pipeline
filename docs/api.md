# API Reference

This is the first public API surface for `@async/pipeline`.

## Imports

Use the public package for normal authoring:

```ts
import { cache, defineCache, definePipeline, dependsOn, env, fileCache, job, memoryCache, redisCache, sh, source, task, trigger } from "@async/pipeline";
```

Subpaths are available for advanced use:

```ts
import { definePipeline } from "@async/pipeline/core";
import { hostWorkspace, runJob } from "@async/pipeline/node";
import { LimaCommandExecutor } from "@async/pipeline/lima";
import { createRuntime, defineRuntime } from "@async/pipeline/runtime";
```

## definePipeline

```ts
definePipeline({
  name: "app",
  env: {},
  cache: "file:cache-first",
  namedInputs: {},
  taskDefaults: {},
  triggers: {},
  sync: {},
  sources: {},
  tasks: {},
  jobs: {}
});
```

Fields:

| Field | Purpose |
| --- | --- |
| `name` | Pipeline name written into execution records. |
| `env` | Runtime environment inherited by every job. Values can be literals, `env.secret(...)`, or `env.var(...)`. |
| `cache` | Optional cache registry or default cache ref. Built-in stores are `file` and `memory`. |
| `namedInputs` | Reusable input groups referenced by task `inputs`. |
| `taskDefaults` | Defaults applied by exact task id or task name segment. |
| `triggers` | Named trigger declarations. |
| `sync` | Generated files that should stay current. |
| `sources` | Explicit local or git repos whose pipeline can be composed into this graph. |
| `tasks` | Task map. |
| `jobs` | Job map. |

Pipeline definitions are metadata. Importing a pipeline, calling `definePipeline`, using directives, or reading metadata does not execute tasks, open cache connections, start cron, clone repos, or evaluate function steps.

## env

`env` is the runtime process environment for a pipeline job. Pipeline-level env is inherited by every job. Job-level env overrides pipeline-level env by key.

```ts
import { definePipeline, env, job, sh, task } from "@async/pipeline";

export default definePipeline({
  name: "app",
  env: {
    NODE_ENV: env.var("NODE_ENV", { default: "dev" })
  },
  tasks: {
    deploy: task({
      run: sh`deploy --target "$API_URL"`
    })
  },
  jobs: {
    deploy: job({
      target: "deploy",
      env: {
        API_URL: env.var("NODE_ENV", {
          prod: "https://api.example.com",
          dev: "http://localhost:3000"
        }, {
          default: "dev"
        }),
        NODE_AUTH_TOKEN: env.secret("NPM_TOKEN")
      }
    })
  }
});
```

Env values:

| Value | Runtime behavior |
| --- | --- |
| `"literal"` | Uses the literal string. |
| `env.secret("NAME")` | Reads a secret source. Locally this is `process.env.NAME`; generated GitHub Actions renders `${{ secrets.NAME }}` into the destination env key. |
| `env.var("NAME")` | Reads a variable source. Locally this is `process.env.NAME`; generated GitHub Actions renders `${{ vars.NAME }}` into the destination env key. |
| `env.var("NAME", { default: "dev" })` | Reads `NAME`, or uses the default when missing. |
| `env.var("NAME", { prod, dev }, { default })` | Reads `NAME`, optionally defaults the selector, then maps it to a runtime value. |

Missing secrets, missing vars without defaults, and unmapped variable values fail before the task command runs. Error messages name the env key and source, but do not print secret values.

Generated GitHub Actions uses `environment` and `requires` for portable job metadata. Runtime env still belongs in `env`:

```ts
job({
  target: "publish",
  environment: {
    name: "npm-publish",
    url: "https://www.npmjs.com/package/@async/pipeline"
  },
  requires: {
    provenance: true
  },
  env: {
    NODE_AUTH_TOKEN: env.secret("NPM_TOKEN")
  }
});
```

The generated workflow renders:

```yaml
environment: "npm-publish"
permissions:
  contents: read
  id-token: write
steps:
  - name: Run pipeline job
    run: pnpm async-pipeline run publish
    env:
      CI: true
      NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

Local tests can mock the same job without GitHub Actions by passing a workspace env into `runJob(...)`:

```ts
import assert from "node:assert/strict";
import { hostWorkspace, runJob } from "@async/pipeline/node";
import pipeline from "../pipeline.js";

const record = await runJob(pipeline, {
  id: "publish",
  mode: "ci",
  workspace: hostWorkspace({
    cwd: process.cwd(),
    env: {
      ...process.env,
      NPM_TOKEN: "fake-token"
    }
  })
});

assert.equal(record.status, "passed");
```

To test the already-rendered GitHub shape, set the destination key instead:

```ts
process.env.NODE_AUTH_TOKEN = "fake-token";
```

For `env: { NODE_AUTH_TOKEN: env.secret("NPM_TOKEN") }`, the runner accepts either the source key (`NPM_TOKEN`) or the rendered destination key (`NODE_AUTH_TOKEN`). This lets tests cover the same runtime step locally and in CI.

The core model is:

```txt
tasks     = what can run
jobs      = named entrypoints
triggers  = when jobs should run
sync      = generated files to keep current
```

Triggers describe when jobs should run. Sync describes which generated files should be kept current.

## task

```ts
task({
  description: "Build the app",
  dependsOn: ["typecheck"],
  inputs: ["src/**/*.ts", "package.json"],
  outputs: ["dist/**"],
  cache: "file:cache-first",
  retry: { attempts: 2, delayMs: 500 },
  timeout: "2m",
  requires: { tools: ["node", "pnpm"] },
  environment: { backend: "host" },
  run: sh`pnpm build`
})
```

Task overloads:

```ts
task(config);
task(config, sh`pnpm test`);
task(config, [cache.use("file:cache-first"), sh`pnpm test`]);
```

If `config.run` is set and a second argument is also passed, `task` throws `ASYNC_PIPELINE_TASK_ARGUMENT_CONFLICT`.

Fields:

| Field | Purpose |
| --- | --- |
| `dependsOn` | Task ids that must run first. Use `<source>:<task>` for declared source tasks. |
| `inputs` | Files or named input groups that affect cache keys. |
| `outputs` | Files produced by the task. Included in metadata and cache config. |
| `cache` | `true`, `false`, a cache ref such as `"file:cache-first"`, or cache options. |
| `retry` | Number of attempts or `{ attempts, delayMs }`. |
| `timeout` | Milliseconds or a duration string such as `500ms`, `30s`, `5m`, `1h`. |
| `requires` | Tool, secret, or runtime declarations. |
| `environment` | Backend declaration such as host or Lima. CLI routing to Lima is not automatic today. |
| `run` | One shell command/function step or an array of steps/directives. |
| `steps` | Multiple shell commands, function steps, or static directives. |

`dependsOn` is the author-facing dependency keyword.

Directive form is available for reusable stacks:

```ts
task({}, [
  dependsOn("build"),
  cache.use("file:cache-first"),
  sh`pnpm test`
])
```

Normalization lifts directives into task metadata. Metadata readers inspect directives but never invoke user functions.

## defineCache

```ts
const caches = defineCache({
  default: "file:cache-first",
  stores: {
    memory: memoryCache(),
    file: fileCache({ root: ".async/cache/tasks" }),
    redis: redisCache({ url: { env: "REDIS_URL" } })
  }
});
```

Use the registry at pipeline level:

```ts
definePipeline({
  name: "app",
  cache: caches,
  tasks: {
    test: task({ cache: "file:cache-first", run: sh`pnpm test` })
  },
  jobs: {
    verify: job({ target: "test" })
  }
});
```

Built-in runner support:

| Store | Behavior |
| --- | --- |
| `file` | Persistent local task cache under `.async/cache/tasks` by default. |
| `memory` | Process-local task cache. |

Remote stores can be declared as runtime metadata, but `@async/pipeline` does not ship a Redis dependency.

## source

```ts
source.path({
  path: "../admin",
  pipeline: "pipeline.ts",
  writable: true,
  prepare: [sh`pnpm install --frozen-lockfile`]
});

source.git({
  url: "https://github.com/acme/storefront.git",
  ref: "main",
  pipeline: "pipeline.ts",
  prepare: [
    sh`pnpm install --frozen-lockfile`,
    sh((ctx) => sh`pnpm add @acme/design-system@file:${ctx.candidate.dir}`)
  ]
});
```

Sources are explicit. `@async/pipeline` does not infer reverse dependencies from package manifests, lockfiles, npm metadata, or GitHub search.

Use namespaced refs from root tasks:

```ts
task({
  dependsOn: ["storefront:test", "admin:test-design-system"]
})
```

Path sources with `prepare` require `writable: true` in v1. Git sources use warm checkouts under `.async/sources`.

## sh

```ts
task({
  run: sh`pnpm test`
})
```

`sh` creates a shell step. The host runner executes it from the task working directory.

Use deferred `sh` only when runtime context is needed:

```ts
sh((ctx) => sh`pnpm add @acme/design-system@file:${ctx.candidate.dir}`)
```

Deferred shell callbacks are metadata-safe. They are not evaluated when a pipeline is imported or read through `metadata`.

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
| `cwd` | Current task working directory. Root tasks use the root repo; source tasks use the source checkout. |
| `env` | Process environment. |
| `root.dir` | Root pipeline directory. |
| `candidate` | Candidate repo context: `dir`, `fingerprint`, optional git facts. |
| `source` | Source repo context for namespaced source tasks and `prepare` steps. |
| `meta` | Add task metadata to the execution record. |
| `log` | Append to the task log. |
| `sh` | Create shell command values. |

## job

```ts
job({
  description: "Full verification",
  target: "build",
  trigger: ["push"],
  environment: {
    name: "npm-publish",
    url: "https://www.npmjs.com/package/@async/pipeline"
  },
  requires: {
    provenance: true
  },
  env: {
    NODE_AUTH_TOKEN: env.secret("NPM_TOKEN"),
    API_URL: env.var("NODE_ENV", {
      prod: "https://api.example.com",
      dev: "http://localhost:3000"
    }, {
      default: "dev"
    })
  }
})
```

Fields:

| Field | Purpose |
| --- | --- |
| `target` | Task id or task ids used as the job entrypoint. |
| `trigger` | Trigger ids attached to the job. |
| `environment` | Optional deployment/environment metadata, either a string name or `{ name, url }`. GitHub lowers this to job `environment`. |
| `requires` | Optional portable job requirements. `requires.provenance` lowers to GitHub `id-token: write`. |
| `env` | Job runtime environment. Overrides pipeline env by key. |
| `github` | GitHub-specific escape hatch for platform fields not covered by portable metadata. |
| `mode` | Optional `manual` or `ci` mode. |
| `env` | Runtime environment for this job. Job env overrides pipeline env by key. |
| `github` | Optional generated GitHub Actions job config for platform environment and permissions. |

See [`env`](#env) for local, GitHub Actions, and test behavior.

## trigger

```ts
trigger.manual();
trigger.github({ events: ["push", "pull_request"], branches: ["main"] });
trigger.cron("0 9 * * 1");
trigger.schedule("0 9 * * 1"); // compatibility alias
```

Triggers are declarations. Use `async-pipeline github generate` to render them into committed GitHub Actions YAML. GitHub cannot start a cron or push workflow from TypeScript alone.

## sync

```ts
definePipeline({
  name: "app",
  sync: {
    github: true,
    tasks: true
  },
  tasks: {},
  jobs: {}
});
```

`sync.github: true` uses the default generated paths:

```txt
.github/workflows/async-pipeline.yml
.github/async-pipeline.lock.json
```

Use object form to render elsewhere, which is useful in tests:

```ts
sync: {
  github: {
    workflow: ".tmp/async-pipeline.yml",
    lock: ".tmp/async-pipeline.lock.json"
  }
}
```

`sync.tasks: true` syncs all jobs, not raw tasks, into the root package-manager manifest with the `pipeline` prefix. Package manifests receive `scripts`; Deno manifests receive `tasks`.

```json
{
  "scripts": {
    "pipeline:verify": "async-pipeline run verify"
  }
}
```

Use object form for explicit targets:

```ts
sync: {
  tasks: {
    prefix: "pipeline",
    runners: ["package"],
    targets: [
      { package: "@acme/app" },
      { path: "tools/worker/deno.json" }
    ],
    jobs: ["verify"],
    tasks: ["typecheck"],
    scripts: {
      "sync:check": "sync check"
    }
  }
}
```

Package targets match `package.json#name`. Path targets must point at `package.json`, `deno.json`, or `deno.jsonc`. Raw task sync is opt-in and generates names like `pipeline:task:typecheck`.

Task sync writes `.async-pipeline/tasks.lock.json`. The lock records the generator version, config path, prefix, runners, targets, resolved manifest paths, generated command names and values, and a rendered hash. Existing unmanaged scripts or Deno tasks are never overwritten; conflicts throw `ASYNC_PIPELINE_SYNC_CONFLICT`.

## GitHub Commands

```sh
async-pipeline sync list
async-pipeline sync generate
async-pipeline sync check
async-pipeline sync github list
async-pipeline sync github generate [--workflow <path>] [--lock <path>]
async-pipeline sync github check [--workflow <path>] [--lock <path>]
async-pipeline sync tasks list
async-pipeline sync tasks generate
async-pipeline sync tasks check
async-pipeline github generate [--workflow <path>] [--lock <path>]
async-pipeline github check [--workflow <path>] [--lock <path>]
async-pipeline github run
```

`github generate` and `github check` are compatibility aliases for the GitHub sync implementation.

`github generate` writes `.github/workflows/async-pipeline.yml` and `.github/async-pipeline.lock.json` unless paths are overridden.

`github check` fails when generated files are stale.

`github run` reads the GitHub event context and runs matching jobs.

## Runtime Subpath

The runtime API is additive and advanced. It is for embeddable workflows, not the primary `pipeline.ts` MVP path:

```ts
import { branch, cache, compose, createRuntime, defineRuntime, parallel, task } from "@async/pipeline/runtime";

const work = defineRuntime([
  task({ id: "verify" }, compose(
    async (ctx, next) => {
      ctx.state.started = true;
      return next();
    },
    [
      async (_ctx, next) => next(),
      async (_ctx, next) => next()
    ],
    parallel([
      async () => "typecheck",
      async () => "test"
    ]),
    branch(
      (ctx) => Boolean(ctx.input),
      async () => "with-input",
      async () => "without-input"
    )
  )),
  task({ id: "sync", dependsOn: ["verify"] }, [
    cache.use("memory:cache-first"),
    async (ctx, next) => {
      ctx.state.synced = true;
      return next();
    }
  ])
]);

const runtime = createRuntime(work);
const result = await runtime.run();
await runtime.start();
await runtime.stop();
```

`compose(...)` is the low-level runtime primitive: functions receive `(ctx, next)`, nested arrays are sequential groups, and `parallel(items)` or `parallel(options, items)` is explicit fan-out. `task(...)` is the opinionated runtime boundary for ids, dependencies, cache directives, inspection, and structured error results.

## runJob

`runJob(...)` executes one job from a normalized pipeline. The job id is `id`; `target` stays inside the job definition and points at the requested task graph endpoint.

```ts
import { hostWorkspace, runJob } from "@async/pipeline/node";
import pipeline from "./pipeline.js";

const record = await runJob(pipeline, {
  id: "verify",
  workspace: hostWorkspace({
    cwd: process.cwd(),
    env: process.env
  })
});
```

If `workspace` is omitted, the runner uses `hostWorkspace({ cwd: process.cwd(), env: process.env })`.

```ts
interface RunOptions {
  id: string;
  mode?: "manual" | "ci";
  workspace?: PipelineWorkspace;
}

interface PipelineWorkspace {
  cwd: string;
  env: NodeJS.ProcessEnv;
  fs: PipelineFileSystem;
  executor: CommandExecutor;
  commands?: WorkspaceCommands;
}

interface CommandExecutor {
  name: string;
  runShell(command: string, options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    task: NormalizedTask;
    timeoutMs?: number;
  }): Promise<CommandResult>;
  checkTool?(tool: string): Promise<boolean>;
}
```

The host workspace uses the real filesystem and shell. Tests can provide a custom `env`, `CommandExecutor`, or command policy without touching global process state.

## workspaces

Declare inspectable workspace profiles in `definePipeline(...)`:

```ts
import { definePipeline, workspace } from "@async/pipeline";

export default definePipeline({
  name: "app",
  workspaces: {
    lima: workspace.lima({ vm: "async-pipeline" }),
    docker: workspace.docker({ image: "node:24" })
  },
  tasks: {},
  jobs: {}
});
```

Run a job with a selected workspace:

```sh
async-pipeline run verify --workspace docker
async-pipeline run verify --workspace lima
```

Programmatic factories are available for host, Lima, and Docker:

```ts
import { dockerWorkspace, limaWorkspace, runJob } from "@async/pipeline";

await runJob(pipeline, {
  id: "verify",
  workspace: dockerWorkspace({
    image: "node:24",
    cwd: process.cwd()
  })
});

await runJob(pipeline, {
  id: "verify",
  workspace: limaWorkspace({
    vm: "async-pipeline",
    cwd: process.cwd()
  })
});
```

`memory`, `ssh`, and `github` workspace definitions are inspectable placeholders in this tranche. Full execution for those requires moving store, cache, and source IO behind `workspace.fs`.

## command policy

`commands` governs CLI/tool/agent command boundaries. It is separate from task shell execution, which still uses `workspace.executor`.

```ts
import { command, definePipeline } from "@async/pipeline";

export default definePipeline({
  name: "app",
  commands: command.policy({
    rules: [
      command.rule({
        prefix: ["npm", "publish"],
        action: command.deny()
      }),
      command.rule({
        exact: ["async-pipeline", "github", "check"],
        action: command.mock({
          code: 0,
          stdout: "GitHub workflow is current.\n"
        })
      })
    ],
    fallback: command.allow(),
    record: true,
    output: {
      maxBytes: 20_000,
      redactSecrets: true
    }
  }),
  tasks: {},
  jobs: {}
});
```

Use `runPipelineCli(...)` to exercise the CLI without spawning a subprocess:

```ts
import { runPipelineCli } from "@async/pipeline";

const result = await runPipelineCli({
  args: ["github", "check"],
  workspace: hostWorkspace({ cwd: process.cwd() })
});
```

Rules only affect matching commands. Unmatched commands use `fallback`, and `fallback` defaults to `command.allow()`.

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
  sources?: Record<string, ExecutionSourceRecord>;
}
```

Task results include status, attempts, cache key, cache hit, timings, error, and metadata.

## Metadata

Read metadata without running anything:

```sh
async-pipeline metadata --format json
async-pipeline metadata --format json --include-sources
```

Metadata reads do not clone sources, run source `prepare`, execute tasks, or evaluate deferred shell callbacks. `--include-sources` only loads source pipeline metadata from already-available path sources or previously synced git checkouts.
