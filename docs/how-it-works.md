# How It Works

`@async/pipeline` keeps workflow logic local-first by separating five jobs:

```txt
define -> generate GitHub bootloader -> resolve graph -> run tasks -> write records/cache
```

The pipeline definition is data. The runner decides what must run, schedules ready tasks with bounded concurrency, and writes durable local evidence under `.async/`.

## 1. Define

The CLI loads one config file from the project root:

```txt
pipeline.ts
pipeline.js
pipeline.mjs
pipeline.mts
```

The config default-exports `definePipeline(...)`:

```ts
import { definePipeline, job, sh, task } from "@async/pipeline";

export default definePipeline({
  name: "app",
  tasks: {
    build: task({ run: sh`pnpm run build` })
  },
  jobs: {
    verify: job({ target: "build" })
  }
});
```

`definePipeline`, `task`, `job`, `trigger`, `source`, `sh`, cache directives, `dependsOn(...)`, and deferred `sh((ctx) => ...)` create metadata only. Importing a pipeline does not clone repos, run commands, open cache stores, start cron, or evaluate deferred shell callbacks.

## 2. Generate GitHub Bootloader

GitHub Actions starts workflows from YAML, so TypeScript cannot dynamically register `push`, `pull_request`, or cron triggers after the fact.

`async-pipeline github generate` renders trigger/job metadata into:

```txt
.github/workflows/async-pipeline.yml
.locks/pipeline/github-workflow.lock.json
```

`async-pipeline github check` recomputes the same metadata hash and fails if the generated workflow or lock is stale.

The generated workflow is a pinned, low-permission bootloader. It installs dependencies, checks the generated files, and calls `async-pipeline github run`. The CLI then reads the GitHub event context and runs matching jobs from `pipeline.ts`.

## 3. Resolve Graph

Tasks name their dependencies with `dependsOn`:

```ts
task({
  dependsOn: ["typecheck"],
  run: sh`pnpm run test`
})
```

When you run:

```sh
async-pipeline run verify
```

the scheduler:

1. Loads and validates the pipeline.
2. Expands the job target into the required dependency graph.
3. Detects missing tasks, missing job targets, and dependency cycles.
4. Sorts tasks into a deterministic execution order.
5. Starts tasks whose dependencies have passed, up to the configured concurrency.

Source tasks use namespaced refs such as `storefront:test`. The source map is explicit; `@async/pipeline` does not infer dependents from package manifests, lockfiles, npm metadata, or GitHub search.

## 4. Run Tasks

The Node runner creates a run plan, prepares declared sources when needed, then executes ready tasks in dependency order. Independent tasks can run in parallel; dependents wait until their direct dependencies have passed.

For each task it:

1. Resolves shell and function steps.
2. Checks declared tools.
3. Computes a cache key from task config, cache ref, declared inputs, resolved commands, direct dependency fingerprints, and portable source context.
4. Replays a passing local cache result when the key matches, the entry is fresh, and declared outputs can be restored or validated.
5. Runs dirty tasks with retry and timeout policy.
6. Stops scheduling new tasks on the first failure. Tasks already running are allowed to finish so the run record stays complete.

## 5. Write Records And Cache

Each run writes:

```txt
.async/runs/<run-id>/execution.json
.async/runs/<run-id>/graph.json
.async/runs/<run-id>/summary.md
.async/runs/<run-id>/cache/<task>.json
.async/runs/<run-id>/logs/<task>.log
```

`execution.json` is the machine-readable record. `graph.json` is the selected job's graph snapshot. It records execution order, graph nodes, dependency edges, effect kinds, and structural node fingerprints without storing file contents or secret values. Cache receipts under `.async/runs/<run-id>/cache/` record hit, miss, disabled, or forced-bypass decisions with the task cache key, dependency fingerprints, and graph node fingerprint, without storing file contents or secret values. `summary.md` is the quick human-readable view. Task logs keep command output for inspection.

The default file task cache is local:

```txt
.async/cache/tasks/<cache-key>/
  result.json
  outputs.json
  outputs.blob
```

That path layout is specific to the file store. Custom adapters and Redis stores receive logical blob keys such as `<cache-key>/outputs.blob` and choose their own backing layout.

To make a task dirty when a file changes, include that file or glob in `inputs`. Input resolution ignores `.git/`, `.async/`, and `node_modules/` by default. A task's declared `outputs` are excluded from its own input files so generated artifacts do not dirty the task that produced them.

If a cached task declares outputs, the runner snapshots those output files after a successful run, stores a manifest plus output blob through the selected cache store, and restores the files before returning a cache hit. Result-only cache entries remain usable for tasks without outputs; output-producing tasks rerun once when an old entry has no output snapshot. `ttlMs` expires otherwise valid entries.

Cache refs are normalized during definition:

```ts
task({ cache: "file:local", run: sh`pnpm run test` })
```

`memory` and `file` are registered by default. `customCache({ adapter })` registers an executable blob store with required `get` and `put` methods plus optional lifecycle hooks for `list`, `delete`, `touch`, and `prune`. `redisCache(...)` uses a user-supplied `redis://` or `rediss://` URL and the runner's built-in RESP client, so no Redis npm dependency is required.

Many-repo impact runs can also reuse warm git checkouts under:

```txt
.async/sources
```

## Core Objects

| Object | Owns |
| --- | --- |
| Pipeline | Graph shape, named tasks, jobs, triggers, cache registry, named inputs, sources, and defaults. |
| Task | Work unit, `dependsOn`, inputs, outputs, cache, retry, timeout, requirements, environment, and steps. |
| Job | Named entrypoint, trigger binding, target task or tasks, env, environment metadata, and requirements. |
| Source | Explicit local or git repo with its own pipeline and optional `prepare` steps. |
| Scheduler | Graph resolution, deterministic order, cache decisions, retries, timeouts, and fail-fast behavior. |
| Workspace | Current directory, env, filesystem identity, and command executor. |
| Store | `.async/cache`, `.async/runs`, logs, summaries, source checkouts, and execution metadata. |

## Source Composition

A root pipeline can declare known dependent repos:

```ts
import { definePipeline, job, sh, source, task } from "@async/pipeline";

export default definePipeline({
  name: "design-system",
  sources: {
    storefront: source.git({
      url: "https://github.com/acme/storefront.git",
      ref: "main",
      prepare: [
        sh`pnpm install --frozen-lockfile`,
        sh((ctx) => sh`pnpm add @acme/design-system@file:${ctx.candidate.dir}`)
      ]
    })
  },
  tasks: {
    impact: task({ dependsOn: ["storefront:test"] })
  },
  jobs: {
    verifyImpact: job({ target: "impact" })
  }
});
```

During execution, the runner resolves or fetches the source, loads its pipeline metadata, namespaces its tasks, runs `prepare` in the source checkout, and runs source tasks with `cwd` set to that checkout.

Path sources with `prepare` require `writable: true` in v1. Git sources use warm checkouts under `.async/sources`.

## Sandboxes And Executors

The CLI runs on the host by default. Declared sandboxes are opt-in isolation backends (Lima VMs, Docker containers) that a run selects explicitly; each resolves to an execution context owning the current directory, env, filesystem identity, and command executor.

Use named sandboxes for local isolation:

```ts
import { definePipeline, job, sandbox, sh, task } from "@async/pipeline";

export default definePipeline({
  name: "app",
  sandboxes: {
    lima: sandbox.lima({ vm: "async-pipeline" }),
    docker: sandbox.docker({ image: "node:24" })
  },
  tasks: {
    verify: task({ run: sh`pnpm run test` })
  },
  jobs: {
    verify: job({ target: "verify" })
  }
});
```

```sh
async-pipeline run verify --sandbox lima
async-pipeline run verify --sandbox docker
```

Programmatic runs select sandboxes the same way:

```ts
import { runJob, sandbox } from "@async/pipeline";
import pipeline from "./pipeline.js";

await runJob(pipeline, { id: "verify", sandbox: "lima" });

await runJob(pipeline, {
  id: "verify",
  sandbox: sandbox.lima({ vm: "async-pipeline" }),
  cwd: process.cwd(),
  env: process.env
});
```

Command policy is a separate execution port for CLI/tool/agent boundaries. It can allow, deny, mock, record, redact, and bound output for commands such as `async-pipeline github check` or `npm publish`. Task shell steps still run through the resolved command executor.

The current CLI does not automatically route tasks based on `task.environment.backend`. Explicit `--sandbox` selection is the supported local testing path.
