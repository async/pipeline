---
title: "@async/pipeline"
description: "Local-first TypeScript pipelines with one task graph for laptops and GitHub Actions."
---

# @async/pipeline

Write the workflow in TypeScript, run it locally, and generate the thin GitHub Actions bootloader from the same `pipeline.ts`.

`@async/pipeline` is a small TypeScript pipeline engine for projects that want everyday verification to be local-first instead of CI-only. Put the task graph in `pipeline.ts`, run it on your laptop with `async-pipeline`, and let GitHub Actions call the same graph with a generated workflow.

## Why Use It

- Replace duplicated local scripts and CI-only YAML logic with one typed `pipeline.ts`.
- Run the same task graph on a laptop and in GitHub Actions.
- Generate and check a pinned GitHub Actions workflow from `pipeline.ts`.
- Keep run records, logs, summaries, source checkouts, and task cache under `.async/`.
- Make cache behavior explicit through declared task inputs, cache refs, and task config.
- Give people and agents inspectable commands: `list`, `graph`, `explain`, `metadata`, `matrix`, and `doctor`.
- Run many-repo impact checks with explicit dependent repos and namespaced task refs such as `storefront:test`.
- Read pipeline metadata without cloning sources, running `prepare`, executing tasks, or evaluating deferred shell callbacks.
- Keep GitHub Actions pinned, low-permission, and focused on invoking the local pipeline.

## Quick Start

Try the repo's own pipeline:

```sh
git clone https://github.com/async-framework/async-pipeline.git
cd async-pipeline
pnpm install --frozen-lockfile
pnpm build
pnpm async-pipeline run verify
```

Inspect the run:

```sh
ls .async/runs
cat .async/runs/<run-id>/summary.md
cat .async/runs/<run-id>/execution.json
```

The self pipeline lives in [`pipeline.ts`](https://github.com/async-framework/async-pipeline/blob/main/pipeline.ts). It runs `typecheck`, `test`, `build`, and `pack` through the `verify` job, and it declares the GitHub triggers used to generate the checked-in workflow.

## Examples

See [`examples`](https://github.com/async-framework/async-pipeline/tree/main/examples) for copyable pipeline shapes. The first complete example adapts a GitHub-native npm preview package workflow into `@async/pipeline`: [`examples/github-native-npm-preview-package`](https://github.com/async-framework/async-pipeline/tree/main/examples/github-native-npm-preview-package).

## Add A Pipeline

After the package is published, install the public package:

```sh
pnpm add -D @async/pipeline
```

Create `pipeline.ts`:

```ts
import { definePipeline, job, sh, task, trigger } from "@async/pipeline";

export default definePipeline({
  name: "app",
  cache: "file:cache-first",
  triggers: {
    pr: trigger.github({ events: ["pull_request"] }),
    main: trigger.github({ events: ["push"], branches: ["main"] }),
    nightly: trigger.cron("17 2 * * *")
  },
  sync: {
    github: true,
    tasks: true
  },
  namedInputs: {
    source: ["src/**/*.ts", "package.json", "pnpm-lock.yaml", "tsconfig.json"]
  },
  tasks: {
    typecheck: task({
      inputs: ["source"],
      cache: "file:cache-first",
      run: sh`pnpm typecheck`
    }),
    test: task({
      dependsOn: ["typecheck"],
      inputs: ["source"],
      cache: "file:cache-first",
      run: sh`pnpm test`
    }),
    build: task({
      dependsOn: ["test"],
      inputs: ["source"],
      outputs: ["dist/**"],
      cache: "file:cache-first",
      run: sh`pnpm build`
    })
  },
  jobs: {
    verify: job({ target: "build", trigger: ["pr", "main"] }),
    nightly: job({ target: "build", trigger: ["nightly"] })
  }
});
```

The mental model is deliberately small:

```txt
tasks     = what can run
jobs      = named entrypoints
triggers  = when jobs should run
sync      = generated files to keep current
```

Triggers describe when jobs should run. Sync describes which generated files should be kept current.

Add scripts manually, or let task sync write package-manager commands for selected jobs:

```json
{
  "scripts": {
    "async-pipeline": "async-pipeline",
    "verify": "async-pipeline run verify"
  }
}
```

Add local pipeline state to `.gitignore`:

```gitignore
.async/
*.tgz
.tmp/
```

Keep the generated GitHub workflow and lock committed:

```txt
.github/workflows/async-pipeline.yml
.github/async-pipeline.lock.json
.async-pipeline/tasks.lock.json
```

Run the same graph locally:

```sh
pnpm async-pipeline run verify
```

## Useful Commands

```sh
async-pipeline list
async-pipeline run <job>
async-pipeline run-task <task>
async-pipeline graph --format json
async-pipeline graph --format dot
async-pipeline explain <task>
async-pipeline metadata --format json
async-pipeline sources list
async-pipeline sources sync
async-pipeline matrix <job> --format github
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
async-pipeline doctor
```

Use `async-pipeline` as the explicit command in docs and CI. Short aliases and smart runner dispatch belong in `@async/run`, not this package.

## GitHub Actions

GitHub Actions requires committed YAML for `push`, `pull_request`, `schedule`, `release`, and `workflow_dispatch`. `@async/pipeline` keeps that YAML as a generated bootloader:

```sh
async-pipeline github generate
# or
async-pipeline sync github generate
```

That writes:

```txt
.github/workflows/async-pipeline.yml
.github/async-pipeline.lock.json
```

For tests or local experiments, render somewhere else:

```sh
async-pipeline github generate --workflow .tmp/async-pipeline.yml --lock .tmp/async-pipeline.lock.json
async-pipeline github check --workflow .tmp/async-pipeline.yml --lock .tmp/async-pipeline.lock.json
```

The generated workflow installs dependencies, checks that the YAML and lock still match `pipeline.ts`, and delegates job selection back to the CLI:

```sh
async-pipeline github check
async-pipeline github run
```

## Package Task Sync

`sync.tasks: true` syncs all pipeline jobs into the root package-manager manifest. It writes package `scripts` in `package.json` and Deno `tasks` in `deno.json` or `deno.jsonc`.

Raw task commands are opt-in and namespaced:

```ts
sync: {
  tasks: {
    prefix: "pipeline",
    runners: ["package"],
    targets: [{ package: "@acme/app" }],
    jobs: ["verify"],
    tasks: ["typecheck"],
    scripts: {
      "sync:check": "sync check"
    }
  }
}
```

Task sync records ownership in `.async-pipeline/tasks.lock.json`. `sync tasks generate` never overwrites an existing unmanaged script or Deno task. If a generated command exists but is not claimed by the lock, it fails with `ASYNC_PIPELINE_SYNC_CONFLICT`.

## Cache Registry

The default pipeline cache registry includes `file` and `memory`. `cache: true` uses the pipeline default, and explicit refs make task behavior easy to read:

```ts
task({ cache: "file:cache-first", run: sh`pnpm test` })
```

You can override the registry without adding Redis or remote cache dependencies to this package:

```ts
import { defineCache, definePipeline, fileCache, job, sh, task } from "@async/pipeline";

const caches = defineCache({
  default: "file:cache-first",
  stores: {
    file: fileCache({ root: ".async/cache/tasks" })
  }
});

export default definePipeline({
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

Remote cache stores are adapter definitions for future/runtime use; the node runner executes the built-in `file` and `memory` stores today.

## Many-Repo Impact Runs

Declare known dependent repos yourself:

```ts
import { definePipeline, job, sh, source, task } from "@async/pipeline";

export default definePipeline({
  name: "design-system",
  sources: {
    storefront: source.git({
      url: "https://github.com/acme/storefront.git",
      ref: "main",
      pipeline: "pipeline.ts",
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

How it works:

- `source.git(...)` declares the repo, ref, and pipeline file to compose.
- The CLI clones git sources into `.async/sources/<source-id>/<hash>` when you run `async-pipeline sources sync`, `async-pipeline run <job>`, or `async-pipeline run-task <source>:<task>`.
- The hash is derived from the source URL and ref, so repeated runs reuse the same warm checkout.
- `prepare` runs inside that source checkout before source tasks run.
- `ctx.candidate.dir` points back to the root repo being tested, which lets the source checkout install or link the candidate change.
- Use `source.path(...)` instead when you want to point at a specific local checkout yourself.

`@async/pipeline` does not infer reverse dependencies from package manifests, lockfiles, npm metadata, or GitHub search. The dependency map stays explicit and reviewable.

## Use It When

- You want local verification to be the source of truth.
- CI should invoke, not redefine, your project workflow.
- You need typed task dependencies, cache inputs, retries, timeouts, requirements, and run records.
- You want metadata and graph inspection for humans, tools, and AI agents.
- You own the list of repos that should be checked against a candidate change.

## Not Yet For

- Parallel task scheduling. Execution is deterministic and sequential today.
- Built-in Redis or remote task cache execution. Remote stores can be declared, but no Redis dependency is shipped.
- Automatic dependency discovery. Sources are explicit by design.
- Automatic CLI routing to Lima. The Lima adapter is available programmatically, and `doctor` checks for `limactl`.
- Deno or Ollama runtime integration. They can be declared as optional tool requirements, but they are not package dependencies.

## Package Shape

Only `@async/pipeline` is published to npm. The other workspace packages are private implementation packages that are bundled into the public package during build.

| Workspace package | Purpose |
| --- | --- |
| `@async/pipeline` | Public package, `async-pipeline` CLI bin, and bundled dist output. |
| `@async/pipeline-core` | Private pipeline, runtime, cache, task, job, graph, source, and type contracts. |
| `@async/pipeline-node` | Private CLI, filesystem store, scheduler, host runner, source sync, and doctor checks. |
| `@async/pipeline-adapter-lima` | Private programmatic Lima runner adapter using `limactl`. |

## More Docs

- [Getting started](getting-started.md)
- [How it works](how-it-works.md)
- [Running locally](local-runs.md)
- [GitHub Actions setup](github-actions.md)
- [API reference](api.md)
- [Many-repo impact runs](many-repo-impact-runs.md)
- [Changelog](https://github.com/async-framework/async-pipeline/blob/main/CHANGELOG.md)

## Extra Details

These notes go deeper than the README so the GitHub Pages page can stand alone.

### Metadata Safety

`definePipeline(...)` is declarative. Importing a pipeline, running `metadata`, rendering `graph`, or checking generated GitHub files does not:

- run shell commands
- evaluate deferred shell callbacks
- clone sources
- run `prepare`
- start cron jobs
- open remote cache connections

This is what lets tools and agents inspect a repo safely before deciding what to run.

### Cache Defaults

Pipeline tasks default to the `file:cache-first` registry when `cache: true` is used. The built-in file cache lives under:

```txt
.async/cache/tasks
```

Runtime primitives default to `memory:cache-first` because embeddable workflows should not write to disk unless the caller opts in.

### GitHub Generation Files

The generated workflow and lock are source-controlled by design:

```txt
.github/workflows/async-pipeline.yml
.github/async-pipeline.lock.json
```

The workflow is the GitHub trigger bootloader. The lock records the generator version, config path, workflow path, rendered triggers, rendered jobs, package-manager choice, and generation hash. `async-pipeline github check` recomputes that state and fails when either file is stale.

Task sync uses a separate source-controlled lock:

```txt
.async-pipeline/tasks.lock.json
```

That lock records generated package scripts and Deno tasks, so `async-pipeline sync tasks check` can fail on stale or unmanaged command changes.

### Runtime Primitives

The MVP is still `pipeline.ts`, local runs, and generated GitHub Actions. The package also exposes additive runtime primitives under `@async/pipeline/runtime` for embeddable workflows:

```ts
import { cache, createRuntime, defineRuntime, task } from "@async/pipeline/runtime";

const work = defineRuntime([
  task({ id: "sync" }, [
    cache.use("memory:cache-first"),
    async (ctx, next) => {
      ctx.state.synced = true;
      return next();
    }
  ])
]);

const runtime = createRuntime(work);
await runtime.run();
```

Use runtime primitives when you need an in-process async work stack. Use `definePipeline(...)` when you need an inspectable project workflow, GitHub Actions generation, run records, and task graph metadata.

### Release Checklist

Before cutting a release:

```sh
pnpm async-pipeline github check
pnpm release:check
npm view @async/pipeline version --json
gh release view v0.1.0 --repo async-framework/async-pipeline
```

The current release gate builds the workspace, typechecks all packages, runs the test suite, dogfoods `async-pipeline run verify`, and dry-runs the publishable `@async/pipeline` tarball.

### GitHub Pages Setup

To publish this page with GitHub Pages:

1. Open the repository settings on GitHub.
2. Go to Pages.
3. Choose deploy from a branch.
4. Select `main` and the `/docs` folder.
5. Save, then open the generated Pages URL after the first deployment finishes.

No extra static-site build step is required for this basic Markdown page.
