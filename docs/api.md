# API Reference

This is the first public API surface for `@async/pipeline`.

## Imports

Use the public package for normal authoring:

```ts
import { cache, customCache, defineCache, definePipeline, dependsOn, env, fileCache, job, memoryCache, redisCache, sh, source, task, trigger } from "@async/pipeline";
```

Subpaths are available for advanced use:

```ts
import { definePipeline } from "@async/pipeline/core";
import { runJob } from "@async/pipeline/node";
import { LimaCommandExecutor } from "@async/pipeline/lima";
import { createRuntime, defineRuntime } from "@async/pipeline/runtime";
```

## definePipeline

```ts
definePipeline({
  name: "app",
  env: {},
  cache: "file:local",
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

The API boundary is split deliberately: `define*` helpers declare inert, inspectable configuration; `create*` helpers bind a definition to runtime behavior; `run*` APIs and CLI commands execute through a chosen context.

Unknown fields in the pipeline, tasks, taskDefaults, jobs, or a job's `github` config are rejected with `ASYNC_PIPELINE_UNKNOWN_FIELD`, so a typo such as `timout` fails loudly instead of silently changing behavior. Fields that are accepted but only declare metadata are documented as such on this page.

Declaration helpers attach non-enumerable metadata under `Symbol.for("@async/pipeline.declaration")`, so JSON output and enumerable config shape stay unchanged.

The declaration brand is a discriminator, not trust: branded task, shell, and agent nodes are still validated, and unknown fields are still rejected.

Optional section factories such as `tasks({ ... })`, `jobs({ ... })`, and `sources({ ... })` are accepted without double wrapping; plain top-level section objects remain the default authoring style.

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

Local tests can mock the same job without GitHub Actions by passing an env into `runJob(...)`:

```ts
import assert from "node:assert/strict";
import { runJob } from "@async/pipeline/node";
import pipeline from "../pipeline.js";

const record = await runJob(pipeline, {
  id: "publish",
  mode: "ci",
  cwd: process.cwd(),
  env: {
    ...process.env,
    NPM_TOKEN: "fake-token"
  }
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

## Package Lifecycle Actions

Package lifecycle networking is executed by generated GitHub Actions through `async/actions/publish` and `async/actions/preview`, not by the `@async/pipeline` npm tarball.

Generated preview jobs call `async/actions/preview` for same-repo PR and main preview packages on GitHub Packages. Generated publish jobs should call `async/actions/publish` for npm publish, GitHub Packages mirrors, GitHub Releases, release doctor checks, dist-tags, and unauthenticated `npm view` verification.

The published `@async/pipeline` package keeps workflow generation local and does not ship release lifecycle GitHub API networking code. This keeps normal installs free of lifecycle `fetch` code; release jobs make networking explicit in GitHub Actions steps.

## task

```ts
task({
  description: "Build the app",
  dependsOn: ["typecheck"],
  inputs: ["src/**/*.ts", "package.json"],
  outputs: ["dist/**"],
  cache: "file:local",
  retry: { attempts: 2, delayMs: 500 },
  timeout: "2m",
  requires: { tools: ["node", "pnpm"] },
  run: sh`pnpm run build`
})
```

Task overloads:

```ts
task(config);
task(config, sh`pnpm run test`);
task(config, [cache.use("file:local"), sh`pnpm run test`]);
```

If `config.run` is set and a second argument is also passed, `task` throws `ASYNC_PIPELINE_TASK_ARGUMENT_CONFLICT`.

Fields:

| Field | Purpose |
| --- | --- |
| `dependsOn` | Task ids that must run first. Use `<source>:<task>` for declared source tasks. |
| `inputs` | Files or named input groups that affect cache keys. `.git/`, `.async/`, `node_modules/`, and this task's declared outputs are ignored by input resolution. |
| `outputs` | Files produced by the task. File cache snapshots and restores these files on a cache hit. |
| `cache` | `true`, `false`, a cache ref such as `"file:local"`, or cache options. Agent tasks default to uncached unless the task itself opts in. |
| `retry` | Total attempts as a number, or `{ attempts, delayMs }`. `retry: 2` means at most two attempts (one retry); `retry: 1` or omitting it disables retries. |
| `timeout` | Milliseconds or a duration string such as `500ms`, `30s`, `5m`, `1h`. |
| `requires` | Tool, secret, or runtime declarations. |
| `run` | One shell command/function step or an array of steps/directives. |
| `steps` | Multiple shell commands, function steps, or static directives. |

`requires.runtime` enforces declared `node` and `deno` runtimes before task commands execute; `shell` remains a generic runtime declaration.

`dependsOn` is the author-facing dependency keyword.

Nested task groups flatten with `.`. A child named `default` is the group default, so `tasks.claims.default` normalizes to task id `claims`, while `tasks.claims.report` normalizes to `claims.report`. `index` remains accepted as a compatibility alias for older task groups.

Within a task group, a dependency like `dependsOn: ["report"]` resolves to the group-local task `claims.report` when that task exists; source refs such as `storefront:claims.report` keep using `:` for the source namespace.

Raw task objects still work, but branded `task({})` removes the empty-task ambiguity inside a group.

Directive form is available for reusable stacks:

```ts
task({}, [
  dependsOn("build"),
  cache.use("file:local"),
  sh`pnpm run test`
])
```

Normalization lifts directives into task metadata. Metadata readers inspect directives but never invoke user functions.

## defineCache

```ts
const remoteAdapter = {
  async get(key) {
    return await readFromRemoteCache(key);
  },
  async put(key, value) {
    await writeToRemoteCache(key, value);
  }
};

const caches = defineCache({
  default: "file:local",
  stores: {
    memory: memoryCache(),
    file: fileCache({ root: ".async/cache/tasks" }),
    remote: customCache({ adapter: remoteAdapter }),
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
    test: task({ cache: "file:local", run: sh`pnpm run test` })
  },
  jobs: {
    verify: job({ target: "test" })
  }
});
```

Built-in runner support:

| Store | Behavior |
| --- | --- |
| `file` | Persistent local task cache under `.async/cache/tasks` by default. Output-producing tasks store `outputs.json` and an output blob next to `result.json`. |
| `memory` | Process-local blob cache. Output-producing hits can restore declared outputs while the process is alive. |
| `customCache({ adapter })` | Executable blob store supplied by the caller. The adapter persists opaque blobs; pipeline still owns cache keys, manifests, TTL checks, and output validation. |
| `redisCache(...)` | Executable Redis blob store. Supply `url` as a string, `env.var(...)`, or `{ env: "REDIS_URL" }`; the runner uses Node sockets and does not depend on a Redis npm package. |

The adapter surface keeps `get` and `put` as the only required methods. Lifecycle methods are optional management hooks that deeper integrations can use for listing, single-key deletion, last-used refreshes, and bounded pruning:

```ts
interface CacheStoreEntry {
  key: string;
  sizeBytes?: number;
  createdAt?: string;
  lastUsedAt?: string;
}

interface CacheStoreAdapter {
  get(key: string, context: CacheStoreContext): Promise<CacheBlob | null>;
  put(key: string, value: CacheBlob, context: CacheStoreContext): Promise<void>;
  touch?(key: string, context: CacheStoreContext): Promise<void>;
  delete?(key: string, context: CacheStoreContext): Promise<void>;
  list?(prefix: string, context: CacheStoreContext): AsyncIterable<CacheStoreEntry>;
  prune?(options: {
    prefix?: string;
    maxAgeMs?: number;
    maxSizeBytes?: number;
  }, context: CacheStoreContext): Promise<{ removed: number; bytesRemoved?: number }>;
}
```

Only `get` and `put` are required. The built-in `file`, `memory`, and `redisCache(...)` adapters implement the optional lifecycle methods; custom adapters can add them when their backing store can support the behavior cheaply. Adapters treat keys as opaque strings and must not inspect source inputs, calculate cache keys, or decide whether an entry is valid. Missing blobs return `null`; backend outages should throw, so the runner fails loudly instead of pretending a remote cache is just cold.

Cache keys include direct dependency cache fingerprints, so changing a dependency invalidates its dependents without hashing every task's inputs into every key. `ttlMs` is enforced by the runner before a cached result is accepted; expired entries rerun. Cache receipts include the selected store and policy but never backend credentials, input file contents, or secret values.

## source

```ts
source.path({
  path: "../admin",
  writable: true,
  prepare: [sh`pnpm install --frozen-lockfile`]
});

source.git({
  url: "https://github.com/acme/storefront.git",
  ref: "main",
  prepare: [
    sh`pnpm install --frozen-lockfile`,
    sh((ctx) => sh`pnpm add @acme/design-system@file:${ctx.candidate.dir}`)
  ]
});
```

When `pipeline` is omitted, the source checkout is searched in this order: `pipeline.ts`, `pipeline.js`, `pipeline.mjs`, `pipeline.mts`. Set `pipeline` explicitly when the repo uses a non-default filename or when multiple default names exist and you want one specific file.

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
  run: sh`pnpm run test`
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

`github.permissions` accepts `contents`, `idToken`, `issues`, `packages`, and `pullRequests` (`pullRequests` renders as `pull-requests`). When a job grants any permission, the generator restates `contents: read` unless you set `contents` yourself, because job-level permissions replace the workflow defaults. Unknown permission fields fail with `ASYNC_PIPELINE_UNKNOWN_FIELD`.

See [`env`](#env) for local, GitHub Actions, and test behavior.

## trigger

```ts
trigger.manual();
trigger.github({ events: ["push", "pull_request"], branches: ["main"] });
trigger.github({ events: ["release"], types: ["published"] });
trigger.cron("0 9 * * 1");
trigger.schedule("0 9 * * 1"); // compatibility alias
```

Triggers are declarations. `trigger.github` supports GitHub event `types` plus `branches`, `paths`, and `tags` filters, and `async-pipeline github generate` renders them into committed GitHub Actions YAML. GitHub cannot start a cron or push workflow from TypeScript alone.

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

Use object form to render elsewhere or tune the generated workflow:

```ts
sync: {
  command: "async-pipeline",
  github: {
    workflow: ".tmp/async-pipeline.yml",
    lock: ".tmp/async-pipeline.lock.json",
    setup: "auto",
    nodeVersion: 24,
    runtime: ["node@24", "deno@2"],
    cache: true,
    dependencyCache: true,
    dependabotAutoMerge: true,
    packagePreviews: true,
    evidence: true,
    sourceImpact: true,
    bridge: {
      mode: "actions",
      schedule: "*/15 * * * *",
      branchPrefix: "async/bridge/",
      allowedPaths: ["pipeline.ts", "package.json", "docs/**"]
    },
    pages: { target: "docs.site" }
  }
}
```

`sync.command` defaults to `async-pipeline` and is used by generated task commands and generated GitHub workflow commands. `setup: "auto"` currently resolves to the default pinned `pnpm/setup` provider; explicit `setup: "async"` selects `async/actions/setup`. Package projects default generated GitHub workflows to `node@<nodeVersion>`; Deno-only projects with `deno.json` or `deno.jsonc` and no `package.json` default to `deno@2`; explicit `runtime` accepts a string or array such as `["node@24", "deno@2"]`. Use `setup: "node"` when you explicitly want the older `actions/setup-node` + Corepack bootloader for a single Node runtime. `nodeVersion` selects the default Node runtime installed by the generated workflow (default `24`). `cache: true` (the default) writes a generated task-cache manifest and calls `async/actions/cache` to restore matching `.async/cache/tasks/<key>` paths; trusted non-PR jobs save with the same manifest after success. `dependencyCache: true` (the default) passes the recognized lockfile to the selected setup provider for dependency-store caching. Set `cache: false` to keep task execution cold, and set `dependencyCache: false` for a fully cold dependency install.

`dependabotAutoMerge: true` generates a guarded Dependabot approval-and-merge job for npm, Deno, and GitHub Actions dependency updates through `async/actions/dependabot-merge`. `packagePreviews: true` generates a pull-request package preview job: it finds the public root package or single public `packages/*` workspace package, runs `pack` or `build`, publishes a GitHub Packages PR preview through `async/actions/preview`, and comments install instructions on same-repo PRs. `evidence: true` adds manifest-backed evidence collection to generated jobs and a fan-in evidence job that merges downloaded manifests through `async/actions/evidence`. `sourceImpact: true` adds generated `<job>-source-plan` and `<job>-sources` jobs for source-backed jobs; the plan job writes static source metadata, `async/actions/source-impact` emits the source matrix, and the matrix job validates checkout and prepare metadata before running namespaced source tasks. `bridge` object form generates an `async-bridge` job that pulls approved Async change sets through `@async/github-app`, enforces the configured branch prefix and path allowlist, and scopes the project token to the bridge pull step. `pages: true` generates GitHub Pages build/deploy jobs from an existing docs task, defaulting to `.async/pages` and pull request, `main`, and manual triggers; `build.kind: "prerender"` validates static prerender output for GitHub Pages.

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

Deno-only roots with `deno.json` or `deno.jsonc` and no `package.json` render generated task and workflow commands through `deno run -A npm:@async/pipeline/cli` unless `sync.command` is set.

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

Package targets match `package.json#name`. Path targets must point at `package.json`, `deno.json`, or `deno.jsonc`. Raw task sync is opt-in and generates names like `pipeline:task:typecheck` and `pipeline:task:claims.report`.

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
async-pipeline github run [--job <id>] [--concurrency <n>]
async-pipeline cache clear
async-pipeline gc [--keep <n>] [--cache-days <n>]
```

`github generate` and `github check` are compatibility aliases for the GitHub sync implementation.

`github generate` writes `.github/workflows/async-pipeline.yml` and `.github/async-pipeline.lock.json` unless paths are overridden.

`github check` fails when generated files are stale.

`github run` reads the GitHub event context and runs matching jobs. On `workflow_dispatch` only jobs with a `manual` trigger run implicitly; select others explicitly with `--job <id>`. Pass `--concurrency <n>` to bound parallel ready-task execution. `run --format json` emits the execution record; `cache clear` resets the task cache; `gc` prunes run records and cache entries unused for `--cache-days` days, and runs auto-prune to `ASYNC_PIPELINE_KEEP_RUNS` (default 50, `0` disables). In-memory task output buffers cap at `ASYNC_PIPELINE_MAX_LOG_BYTES` (default 8 MiB per stream, `0` = unlimited); stored logs keep the tail with a truncation marker.

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
    cache.use("memory:session"),
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
import { runJob } from "@async/pipeline/node";
import pipeline from "./pipeline.js";

const record = await runJob(pipeline, {
  id: "verify",
  concurrency: 2,
  cwd: process.cwd(),
  env: process.env
});
```

`cwd` defaults to `process.cwd()` and `env` to `process.env`. Pass `sandbox` to run inside a declared or inline sandbox.

```ts
interface RunOptions {
  id: string;
  mode?: "manual" | "ci";
  concurrency?: number;
  force?: boolean;
  echo?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  commands?: PipelineCommands;
  executor?: CommandExecutor;
  sandbox?: SandboxId | SandboxDefinition;
  execution?: ExecutionProfileId;
  provider?: "auto" | "docker" | "apple-container" | "lima";
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

When omitted, `concurrency` uses a bounded local default. On the first task failure, the scheduler stops starting new tasks and lets already-running tasks finish before writing the final failed run record.

The host workspace uses the real filesystem and shell. Tests can provide a custom `env`, `CommandExecutor`, or command policy without touching global process state.

## sandboxes

Declare inspectable sandbox profiles in `definePipeline(...)` for opt-in isolated runs. The default is always the host; a sandbox only applies when selected. `sandbox.container(...)` declares OCI-compatible container image intent; OCI is the standard container image format used by Docker, Apple container, Podman, containerd, and registries.

```ts
import { definePipeline, sandbox } from "@async/pipeline";

export default definePipeline({
  name: "app",
  sandboxes: {
    lima: sandbox.lima({ vm: "async-pipeline" }),
    docker: sandbox.docker({ image: "node:24" }),
    node24: sandbox.container({
      image: "node:24",
      workdir: "/workspace",
      volumes: [{ source: ".", target: "/workspace" }]
    })
  },
  tasks: {},
  jobs: {}
});
```

Run a job inside a selected sandbox:

```sh
async-pipeline run verify --sandbox docker
async-pipeline run verify --sandbox lima
async-pipeline run verify --sandbox node24 --provider docker
```

Use `--execution <id>` to select a profile, or `--sandbox <id> --provider docker|apple-container|lima` to choose a provider for `sandbox.container(...)`.

Programmatic runs select sandboxes the same way: by id from the pipeline's `sandboxes`, or with an inline definition.

```ts
import { runJob, sandbox } from "@async/pipeline";

await runJob(pipeline, { id: "verify", sandbox: "docker" });

await runJob(pipeline, {
  id: "verify",
  sandbox: sandbox.docker({
    image: "node:24",
    cwd: process.cwd()
  })
});

await runJob(pipeline, {
  id: "verify",
  sandbox: sandbox.lima({ vm: "async-pipeline" }),
  cwd: process.cwd()
});
```

## execution

Execution profiles connect sandbox intent to a place where tasks run. Local profiles are for explicit local runs; GitHub profiles additionally provide generated workflow runner defaults.

```ts
import { definePipeline, execution, job, sandbox, sh, task } from "@async/pipeline";

export default definePipeline({
  name: "app",
  sandboxes: {
    node24: sandbox.container({ image: "node:24", workdir: "/workspace" })
  },
  execution: {
    local: execution.local({ sandbox: "node24", provider: "auto" }),
    linuxCi: execution.github({
      sandbox: "node24",
      provider: "docker",
      runsOn: "ubuntu-latest"
    }),
    appleCi: execution.github({
      sandbox: "node24",
      provider: "apple-container",
      runsOn: ["self-hosted", "macos", "arm64", "apple-container"]
    })
  },
  tasks: {
    verify: task({ run: sh`pnpm run test` })
  },
  jobs: {
    verify: job({ target: "verify", execution: "linuxCi" })
  }
});
```

`job({ execution: "..." })` selects a profile for local CLI defaults and generated GitHub bootloaders. Raw `job({ github: ... })` fields still override execution-derived GitHub runner defaults when you need direct GitHub Actions control.

## agents

`agents` declares named adapter profiles for `agent(...)` task steps: an argv prefix for an agent CLI plus the model identity. The design is recorded in [ADR-0001](adr/0001-agent-step-type.md).

```ts
import { agent, definePipeline, env, job, sh, task } from "@async/pipeline";

export default definePipeline({
  name: "app",
  agents: {
    claude: {
      command: ["claude", "-p"],
      model: env.var("AGENT_MODEL", { default: "claude-sonnet-4-6" })
    },
    mock: { command: ["node", "scripts/mock-agent.mjs"], model: "mock" }
  },
  tasks: {
    "upgrade-guide": task({
      inputs: ["CHANGELOG.md"],
      outputs: ["docs/upgrade.md"],
      cache: true,
      run: agent({
        use: env.var("ASYNC_AGENT", { default: "claude" }),
        prompt: "Write docs/upgrade.md from the Breaking sections in CHANGELOG.md."
      })
    }),
    "verify-guide": task({
      dependsOn: ["upgrade-guide"],
      inputs: ["docs/upgrade.md", "scripts/check-docs.mjs"],
      run: sh`node scripts/check-docs.mjs`
    })
  },
  jobs: {
    docs: job({ target: "verify-guide" })
  }
});
```

Execution: the resolved prompt is written to `.async/runs/<run-id>/agents/<task>.prompt.txt` and delivered to the adapter on stdin; the adapter runs through the task's command executor (host or selected sandbox) with `ASYNC_PIPELINE_AGENT_PROFILE`, `ASYNC_PIPELINE_AGENT_MODEL`, and `ASYNC_PIPELINE_AGENT_PROMPT_FILE` in its env, from the task's `cwd`. A request/response transcript is written to `.async/runs/<run-id>/agents/<task>.jsonl`. Transcripts and task logs redact resolved secret values.

Propose-only artifacts: `stdoutTo` lands the adapter's stdout as a task artifact after a successful step — a relative path inside the task's cwd (absolute paths and `..` segments are rejected). Declare the path in `outputs` so the cache restores it like any artifact; the transcript keeps the redacted copy of the same stdout. This is the mechanism behind the propose/dispose pattern: an agent emits a patch or report, a human or deterministic task decides — see [examples/agent-claims-repair](../examples/agent-claims-repair/README.md). `doctor` warns when an agent task declares no outputs, because an agent task without declared outputs is unverifiable side effects.

Cache semantics: an agent step's output is an artifact, keyed like any task when caching is explicitly enabled. By default, a task that contains an `agent(...)` step normalizes to `cache: false`; it does not inherit `taskDefaults.cache`. To replay model artifacts, opt in on the task itself with `cache: true`, a cache ref/options object, or a task-owned `cache.use(...)` directive. Agent cache keys include the resolved profile id, model, and prompt — never the adapter's command path. Moving a binary must not dirty the cache; a different profile, model, prompt, or declared input must. A cached agent task replays its declared outputs without invoking the adapter. Use `--force` for a deliberately fresh sample with unchanged inputs.

Selection per environment: both `use` and `model` accept `env.var(...)`, resolved at run time from the task env. A profile that resolves to an undeclared id fails with `ASYNC_PIPELINE_AGENT_UNKNOWN`; statically referencing an undeclared profile fails at `definePipeline` time with the same code. Profiles reject unknown fields with `ASYNC_PIPELINE_UNKNOWN_FIELD`; `command` must be a non-empty argv array and `model` is required, because the model — not the binary location — is the profile's cache identity. Credentials belong in task `env` via `env.secret(...)`, never in the profile command line.

Recommended shape: give agent tasks declared `outputs` and a deterministic dependent verifier task, and keep live agent profiles out of CI-triggered job targets — commit the verified artifact and let CI run the verifier subtree (or select a `mock` profile via repository variables).

## mcp

`async-pipeline mcp` serves the pipeline's inspection surface over MCP (Model Context Protocol): line-delimited JSON-RPC 2.0 on stdio, implemented in this package with no added dependencies. The design is recorded in [ADR-0002](adr/0002-mcp-server.md). Every tool delegates to the same internals as the CLI's `--format json` output, so the two surfaces cannot drift apart.

```sh
async-pipeline mcp               # read-only tools
async-pipeline mcp --allow-run   # also exposes run_job
```

Tools: `list_tasks`, `graph`, `explain_task`, `metadata`, `list_runs`, `read_run` (execution record plus any failure context packs), and `diff_inputs`. All of these are inert in the same sense as `metadata`: they read definitions, records, and files, and execute nothing. The MCP server is read-only by default: `run_job` is exposed only when the server is started with `--allow-run`. `run_job` acquires the same run lock, writes the same records, and replays the same cache as a CLI run; task output stays in task logs and never pollutes the JSON-RPC channel.

Example Claude Code / MCP host configuration:

```json
{
  "mcpServers": {
    "async-pipeline": {
      "command": "pnpm",
      "args": ["dlx", "@async/pipeline", "mcp"]
    }
  }
}
```

## run evidence, cache receipts, and failure context packs

On task failure the runner writes a context pack to `.async/runs/<run-id>/context/<task>.json`: the error, a redacted log tail, the reproduction command, and the input diff against the task's last passing cache entry — content digests only, never file contents. The design is recorded in [ADR-0003](adr/0003-failure-context-packs.md). Packs are bounded for small-context consumption (the log tail is capped at 4 KiB) and flow through the same secret redaction as task logs.

The diff baseline comes from two pieces of persisted state: every cache entry persists a per-file digest manifest (`inputs.json`) for the input state that produced it, and a per-task baseline pointer (`.async/cache/baselines/<task>.json`) tracks the most recent passing entry. A task that has never passed reports `baselineMissing` instead of a diff. When the project keeps a claims registry (`tests/claims.json`), packs also name the claim ids whose registered test titles appear in the failing log. `gc` prunes baseline pointers whose cache entries were removed.

Every run also writes cache receipts under `.async/runs/<run-id>/cache/<task>.json`. A receipt records whether the task was a cache `hit`, cache `miss`, cache-disabled run, or forced bypass, along with the cache store, cache policy, task cache key, graph node fingerprint, dependency fingerprints, and any miss reason. Receipts do not store input file contents, raw cache configuration, backend credentials, or secret values.

Inspect packs and diffs from the CLI:

```sh
async-pipeline explain --run <run-id|latest>      # human summary of run evidence
async-pipeline explain --run <run-id> --format json
async-pipeline explain <task> --diff-inputs       # what changed since the task last passed
async-pipeline explain <task> --diff-inputs --format json
```

`explain <task> --diff-inputs` reports the files that changed since the task last passed, computed from content digests without resolving steps or evaluating deferred callbacks.

## command policy

`commands` governs CLI/tool/agent command boundaries. It is separate from task shell execution, which still uses the run's command executor.

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
  cwd: process.cwd()
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

## Run Lock

`run` and `run-task` hold `.async/run.lock` for the duration of a run. A second run in the same project fails fast with `ASYNC_PIPELINE_RUN_ACTIVE` instead of racing the task cache and run records. A lock whose holder process is dead is reclaimed automatically, so crashed runs never require manual cleanup.

## Execution Record Schema

Execution records (`.async/runs/<run-id>/execution.json`) and stored cache results carry `schemaVersion` (currently `1`), and records include the owning `pid` so `doctor` can tell a crashed run from a live one. Consumers should ignore unknown fields; `schemaVersion` increments only on breaking shape changes.

## Exit Codes

| Code | Meaning |
| --- | --- |
| `0` | Run passed or command succeeded. |
| `1` | Run failed, configuration error, or unexpected error. |
| `130` | Interrupted by SIGINT (Ctrl-C); tasks were terminated and the execution record finalized. |
| `141` | CLI output pipe closed (EPIPE, e.g. piping into `head`); tasks were terminated and the record finalized. |
| `143` | Terminated by SIGTERM; same shutdown path as SIGINT. |

Task-level timeouts surface as command exit code `124` inside the task result; the run itself exits `1`.

## Environment Variables

| Variable | Effect |
| --- | --- |
| `ASYNC_PIPELINE_KEEP_RUNS` | Run-record auto-prune limit applied after each run (default `50`, `0` disables). |
| `ASYNC_PIPELINE_MAX_LOG_BYTES` | Per-stream task output buffer cap in bytes (default 8 MiB, `0` = unlimited, minimum `4096`). |
| `ASYNC_PIPELINE_ENVIRONMENT` | Environment name checked by `command.requireEnvironment(...)`. |
| `CI` | When set, runs record `mode: "ci"`. |
