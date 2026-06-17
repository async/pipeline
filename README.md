# @async/pipeline

Write the workflow in TypeScript, run it locally, and generate the thin GitHub Actions bootloader from the same `pipeline.ts`.

`@async/pipeline` is a small TypeScript pipeline engine for projects that want their everyday verification flow to be local-first instead of CI-only. Put the task graph in `pipeline.ts`, run it on your laptop with `async-pipeline`, and let GitHub Actions call the same graph with a thin workflow.

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

## Syncs Without Taking Over

`pipeline.ts` is the single source of truth, but GitHub Actions and package-manager manifests are never taken over — they receive only what you opt into through `sync`:

```txt
                 ┌─ run ──────▶  your laptop and CI, evidence under .async/
 pipeline.ts ────┤
 (the source)    └─ sync ─────▶  .github/workflows/async-pipeline.yml   (thin bootloader)
                    opt-in,  ─▶  package scripts or Deno tasks          (namespaced, locked)
                    checked
```

GitHub Actions keeps triggers, runners, permissions, and secrets; it stops being where workflow logic lives. Package scripts and Deno tasks stay readable aliases; sync writes only namespaced, lock-owned entries and fails on collisions instead of overwriting yours. `sync check` fails CI when either surface drifts from `pipeline.ts`, and leaving is two deletions: the `sync` block and the generated files. The full story: [docs/sync.md](docs/sync.md).

## Quick Start

Try the repo's own pipeline (requires Node >= 24 and Deno >= 2 on macOS or Linux; `pipeline.ts` loads natively):

```sh
git clone https://github.com/async/pipeline.git
cd async-pipeline
pnpm install --frozen-lockfile
pnpm run build
pnpm run pipeline:verify
```

Inspect the run:

```sh
ls .async/runs
cat .async/runs/<run-id>/summary.md
cat .async/runs/<run-id>/execution.json
```

The self pipeline lives in [pipeline.ts](pipeline.ts). It runs `build`, `typecheck`, `test`, and `pack` through the `verify` job, and it declares the GitHub triggers used to generate [.github/workflows/async-pipeline.yml](.github/workflows/async-pipeline.yml). The initial `pnpm run build` in the quickstart bootstraps the built CLI that loads `pipeline.ts`; after that, the pipeline owns the task order.

## Examples

See [examples](examples/README.md) for copyable pipeline shapes, all exercised by this repo's own `release:check`: a [basic node package](examples/basic-node-package/README.md), [generated package previews](examples/generated-package-previews/README.md), the [GitHub-native npm preview package workflow](examples/github-native-npm-preview-package/README.md), [monorepo package selection](examples/monorepo-package-selection/README.md), a [Deno-only pipeline](examples/deno-only-pipeline/README.md), a [Deno worker](examples/deno-worker/README.md), a [many-repo impact run](examples/many-repo-impact-run/README.md), a [custom cache registry](examples/custom-cache-registry/README.md), and a [runtime middleware stack](examples/runtime-middleware-stack/README.md).

## How It Compares

`@async/pipeline` sits between package-manager scripts and full monorepo build systems. Use it when the workflow graph itself should be typed, inspectable, local-first, and reusable by CI.

| Tool | Best fit | How `@async/pipeline` differs |
| --- | --- | --- |
| Turborepo / Nx | Mature monorepo task orchestration, affected-package logic, parallel scheduling, and ecosystem integrations. | Smaller and explicit: developers declare the graph and inputs, metadata can be inspected safely, and dependency discovery is not inferred. |
| npm / pnpm scripts | Simple command aliases and package-local workflows. | Adds typed tasks, declared inputs and outputs, cache records, run logs, graph inspection, and generated CI. |
| GitHub Actions | Hosted CI, permissions, environments, platform events, and hosted runners. | Keeps GitHub Actions as a pinned bootloader that invokes the same local graph instead of redefining workflow logic in YAML. |

Choose Turborepo or Nx for large monorepos that need advanced scheduling and affected-project automation. Choose npm or pnpm scripts for one-off aliases. Choose GitHub Actions directly for CI-only workflows. Choose `@async/pipeline` when task graph metadata, local run evidence, and thin generated CI matter most.

## Add A Pipeline

After the package is published, install the public package:

```sh
pnpm add -D @async/pipeline
```

Deno-only repos can omit `package.json` and run the published CLI through Deno's npm compatibility layer:

```sh
deno run -A npm:@async/pipeline/cli run verify
```

Deno support relies on Deno's npm and `node:` compatibility layer for the pipeline package internals; see the [Deno Node/npm compatibility docs](https://docs.deno.com/runtime/fundamentals/node/).

Create `pipeline.ts`:

```ts
import { definePipeline, job, sh, task, trigger } from "@async/pipeline";

export default definePipeline({
  name: "app",
  cache: "file:local",
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
      cache: "file:local",
      run: sh`pnpm run typecheck`
    }),
    test: task({
      dependsOn: ["typecheck"],
      inputs: ["source"],
      cache: "file:local",
      run: sh`pnpm run test`
    }),
    build: task({
      dependsOn: ["test"],
      inputs: ["source"],
      outputs: ["dist/**"],
      cache: "file:local",
      run: sh`pnpm run build`
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

Nested task groups flatten with `.`: `claims.default` runs as `claims`, and `claims.report` runs as `claims.report`. A helper package can return a nested task object and the host pipeline decides where to mount it:

```ts
function claimsTasks({ task, sh }) {
  return {
    default: task({ run: sh`async-claims check` }),
    report: task({ run: sh`async-claims check --format json --no-fail` })
  };
}

export default definePipeline({
  name: "app",
  tasks: {
    claims: claimsTasks({ task, sh })
  },
  jobs: {
    verify: job({ target: "claims" })
  }
});
```

Source namespaces still use `:`, so `storefront:claims.report` means task `claims.report` from source `storefront`.

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
pnpm run pipeline:verify
```

## Useful Commands

```sh
async-pipeline list
async-pipeline run <job> [--concurrency <n>] [--force] [--dry-run] [--format text|json]
async-pipeline run-task <task> [--concurrency <n>] [--force] [--dry-run] [--format text|json]
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
async-pipeline github run [--job <id>] [--concurrency <n>]
async-pipeline cache clear
async-pipeline gc [--keep <n>] [--cache-days <n>]
async-pipeline doctor
```

The scheduler starts ready tasks in deterministic graph order and runs independent tasks in parallel up to the configured concurrency. Use `--concurrency 1` when a run needs strict sequential execution. `--force` re-runs tasks while still recording fresh cache entries, `--dry-run` prints the plan with predicted cache hits without executing, `cache clear` resets the task cache, and `gc` prunes old run records and cache entries unused for `--cache-days` days (20 run records and 30 cache days by default). Runs also auto-prune to the newest 50 records; set `ASYNC_PIPELINE_KEEP_RUNS` to change the limit or `0` to disable. Task output buffers cap at 8 MiB per stream (`ASYNC_PIPELINE_MAX_LOG_BYTES`, `0` = unlimited); stored logs keep the tail. The CLI finds `pipeline.ts`, `pipeline.js`, `pipeline.mjs`, or `pipeline.mts` from any subdirectory by walking up.

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
async-pipeline github run [--concurrency <n>]
```

The checked-in generated workflow is [.github/workflows/async-pipeline.yml](.github/workflows/async-pipeline.yml).

## Package Task Sync

`sync.tasks: true` syncs all pipeline jobs into the root package-manager manifest. It writes package `scripts` in `package.json` and Deno `tasks` in `deno.json` or `deno.jsonc`:

```json
{
  "scripts": {
    "pipeline:verify": "async-pipeline run verify"
  }
}
```

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

That can generate:

```json
{
  "scripts": {
    "pipeline:verify": "async-pipeline run verify",
    "pipeline:task:typecheck": "async-pipeline run-task typecheck",
    "pipeline:task:claims.report": "async-pipeline run-task claims.report",
    "pipeline:sync:check": "async-pipeline sync check"
  }
}
```

Task sync records ownership in `.async-pipeline/tasks.lock.json`. `sync tasks generate` never overwrites an existing unmanaged script or Deno task. If a generated command exists but is not claimed by the lock, it fails with `ASYNC_PIPELINE_SYNC_CONFLICT`.

Deno-only roots with `deno.json` or `deno.jsonc` and no `package.json` default generated task commands to `deno run -A npm:@async/pipeline/cli`; set `sync.command` when you want a local wrapper such as `deno task async-pipeline`.

## Cache Registry

The default pipeline cache registry includes `file` and `memory`. `cache: true` uses the pipeline default, and explicit refs make task behavior easy to read:

```ts
task({ cache: "file:local", run: sh`pnpm run test` })
```

Cache keys are derived from the task config, resolved commands, declared inputs, direct dependency cache fingerprints, and portable source/candidate metadata. Input resolution ignores `.git/`, `.async/`, and `node_modules/` by default, and a task's declared `outputs` are excluded from that task's inputs so build artifacts do not dirty their own cache entry.

When a cached task declares `outputs`, the runner stores a validated output manifest and an output blob next to `result.json`, then restores those files before returning a cache hit. `file` persists those blobs under `.async/cache/tasks`; `memory` keeps them process-local; `customCache({ adapter })` lets callers provide another blob store with only `get` and `put`. `ttlMs` is enforced when present; expired entries rerun.

You can override the registry without adding Redis or remote cache dependencies to this package:

```ts
import { customCache, defineCache, definePipeline, fileCache, job, sh, task } from "@async/pipeline";

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
    file: fileCache({ root: ".async/cache/tasks" }),
    remote: customCache({ adapter: remoteAdapter })
  }
});

export default definePipeline({
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

Adapters are deliberately dumb blob stores: pipeline computes keys, writes manifests, enforces TTL, validates restored outputs, and records hit/miss receipts. `get` and `put` are the only required adapter methods; built-in stores also expose optional `list`, `delete`, `touch`, and `prune` hooks for deeper cache integration. `redisCache(...)` uses a user-supplied `redis://` or `rediss://` URL through Node's built-in socket APIs, so no Redis npm client is required.

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

Pin `ref` to a commit SHA for reproducible impact runs. A branch name like `"main"` is convenient while iterating, but it moves underneath you: two runs of the same pipeline can test different dependent code.

## Platform Support

Node projects default generated GitHub workflows to `node@24`; Deno-only projects with `deno.json` or `deno.jsonc` and no `package.json` default to `deno@2`; mixed projects can set `sync.github.runtime` to both. The checked-in workflow targets GitHub-hosted Linux (`ubuntu-latest`) and macOS (`macos-latest`) runners; self-hosted label sets such as Tart-backed Apple Silicon runners are supported through `runsOn`/`runsOnMatrix` (see [GitHub Actions setup](docs/github-actions.md)). Windows is untested; use WSL.

## Use It When

- You want local verification to be the source of truth.
- CI should invoke, not redefine, your project workflow.
- You need typed task dependencies, cache inputs, retries, timeouts, requirements, and run records.
- You want metadata and graph inspection for humans, tools, and AI agents.
- You own the list of repos that should be checked against a candidate change.

## Not Yet For

- Redis lifecycle management. `redisCache(...)` can use a Redis instance you provide, but it does not start, migrate, or prune Redis for you.
- Automatic dependency discovery. Sources are explicit by design.
- Automatic sandbox routing. Isolation is opt-in: select it with `--sandbox`, `--execution`, or programmatic run options; `sandbox.container(...)` is portable OCI image intent, while Docker, Apple container, and Lima are provider choices.
- Ollama runtime integration. It can be declared as an optional tool requirement, but it is not a package dependency.

## Releases, Snapshots, And The npm Fallback

Publishing runs through the same `pipeline.ts` that verifies the repo. PR preview publishing is generated from `sync.github.packagePreviews`, while main snapshots and stable releases use explicit lifecycle tasks. The model is PatrickJS's [GitHub-native npm preview packages Gist](https://gist.github.com/PatrickJS/3fa2925713fcdf75a27a505ce2cd0d80), dogfooded (the standalone generated-preview example lives in [examples/generated-package-previews](examples/generated-package-previews)):

- Stable releases publish to GitHub Packages as `@async/pipeline` before npm, so a stable version exists on the fallback registry even when npm publishing has an issue.
- Stable release jobs create or verify the matching `v<version>` Git tag and GitHub Release before package publishing, and refuse to move an existing tag.
- Pushes to `main` that pass the verify chain publish an immutable `0.0.0-main.sha.<sha>` snapshot to GitHub Packages and move the `main` dist-tag.
- Same-repo pull requests publish an immutable `0.0.0-pr.<n>.sha.<sha>` preview and move the `pr-<number>` dist-tag; fork pull requests never publish previews. Previews build the PR merge commit and are stamped with the PR head SHA.
- Republishing an existing version skips cleanly instead of failing, so re-dispatched publish jobs stay green.

GitHub Packages requires the package scope to match the repo owner, so the mirror is `@async/pipeline` on `npm.pkg.github.com` while npm publishes the same package name on `registry.npmjs.org`:

```sh
# One-time GitHub Packages auth (classic PAT with read:packages), plus
# @async:registry=https://npm.pkg.github.com in your npm config.
npm login --scope=@async --auth-type=legacy --registry=https://npm.pkg.github.com

# Stable fallback when npm is unavailable:
pnpm add @async/pipeline@latest

# Latest main snapshot, or a PR preview:
pnpm add @async/pipeline@main
pnpm add @async/pipeline@pr-123
```

## Docs

- [Docs home](docs/index.md)
- [Sync: choose what GitHub and package managers see](docs/sync.md)
- [Getting started](docs/getting-started.md)
- [How it works](docs/how-it-works.md)
- [Running locally](docs/local-runs.md)
- [GitHub Actions setup](docs/github-actions.md)
- [API reference](docs/api.md)
- [Many-repo impact runs](docs/many-repo-impact-runs.md)
- [Path to 1.0](docs/path-to-1.0.md)

## Runtime Primitives

The MVP remains `pipeline.ts`, local runs, and generated GitHub Actions. The package also exposes additive runtime primitives under `@async/pipeline/runtime` for embeddable workflows:

```ts
import { compose, createRuntime, defineRuntime, parallel, task } from "@async/pipeline/runtime";

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
    ])
  ))
]);

const runtime = createRuntime(work);
await runtime.run();
```

`compose(...)` is public for reusable runtime flows. `task(...)` remains the opinionated boundary for ids, dependencies, cache, inspection, and structured failures.
