# @async/pipeline

Local-first TypeScript pipelines for projects that want one task graph to run on a laptop, in GitHub Actions, and eventually on isolated or remote runners.

`@async/pipeline` is intentionally small: a typed `pipeline.ts`, a task graph, a local run/cache store under `.async/`, and runner adapters for host and Lima execution.

## What You Get

- Typed pipeline definitions with `definePipeline`, `task`, `job`, `trigger`, and `sh`.
- Task fields for `dependsOn`, `inputs`, `outputs`, `cache`, `retry`, `timeout`, `requires`, `environment`, `steps`, and `run`.
- Local execution records in `.async/runs/<run-id>/`.
- Local task cache in `.async/cache/tasks/`.
- CLI commands for running jobs, running one task, listing, graphing, explaining, and doctor checks.
- Thin GitHub Actions setup that runs the same pipeline used locally.

## Package Split

| Package | Purpose |
| --- | --- |
| `@async/pipeline` | Public convenience package and CLI bin. |
| `@async/pipeline-core` | Pipeline, task, job, graph, and type contracts. |
| `@async/pipeline-node` | CLI, filesystem store, scheduler, host runner, and doctor checks. |
| `@async/pipeline-adapter-lima` | Lima runner adapter using `limactl`. |

## Get Started In This Repo

```sh
cd /Users/patrickjs/code/async-framework/async-pipeline
pnpm install --frozen-lockfile
pnpm build
pnpm async-pipeline list
pnpm async-pipeline run verify
```

Inspect the run that was created:

```sh
ls .async/runs
cat .async/runs/<run-id>/summary.md
cat .async/runs/<run-id>/execution.json
```

Run local health checks:

```sh
pnpm async-pipeline doctor
```

The self pipeline lives in [pipeline.ts](pipeline.ts). It defines `typecheck`, `test`, `build`, `pack`, and the `verify` job.

## Use It In Another Project

After the packages are published, install the public package:

```sh
pnpm add -D @async/pipeline
```

Add a `pipeline.ts`:

```ts
import { definePipeline, job, sh, task } from "@async/pipeline";

export default definePipeline({
  name: "app",
  namedInputs: {
    source: ["src/**/*.ts", "package.json", "pnpm-lock.yaml", "tsconfig.json"]
  },
  tasks: {
    typecheck: task({
      inputs: ["source"],
      cache: true,
      run: sh`pnpm typecheck`
    }),
    build: task({
      dependsOn: ["typecheck"],
      inputs: ["source"],
      outputs: ["dist/**"],
      cache: true,
      timeout: "2m",
      run: sh`pnpm build`
    })
  },
  jobs: {
    verify: job({ target: "build" })
  }
});
```

Add package scripts:

```json
{
  "scripts": {
    "async-pipeline": "async-pipeline",
    "verify": "async-pipeline run verify"
  }
}
```

Then run:

```sh
pnpm async-pipeline run verify
```

Node 24 is the current recommended runtime for `pipeline.ts` because the CLI imports TypeScript config files directly. Node 20+ can use `pipeline.mjs` or `pipeline.js`.

## CLI

Use `async-pipeline` as the explicit command in CI and docs.

```sh
async-pipeline run <job>
async-pipeline run-task <task>
async-pipeline list
async-pipeline graph --format json
async-pipeline graph --format dot
async-pipeline explain <task>
async-pipeline doctor
```

Short aliases and smart runner dispatch belong in `@async/run`, not this package.

## GitHub Actions

The workflow should stay thin: install dependencies, build the CLI, and invoke the same pipeline you run locally.

```yaml
permissions:
  contents: read

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<pinned-sha>
      - uses: actions/setup-node@<pinned-sha>
        with:
          node-version: 24
          cache: pnpm
      - run: corepack enable
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - run: pnpm async-pipeline run verify
        env:
          CI: true
```

The checked-in workflow is [.github/workflows/ci.yml](.github/workflows/ci.yml).

## Docs

- [Getting started](docs/getting-started.md)
- [How it works](docs/how-it-works.md)
- [Running locally](docs/local-runs.md)
- [GitHub Actions setup](docs/github-actions.md)
- [API reference](docs/api.md)

## Current Limits

- Task execution is deterministic and sequential today. Parallel scheduling is part of the next tranche.
- The CLI uses the host runner by default. The Lima adapter is available programmatically and `doctor` checks for `limactl`.
- Cache is local-first only. Remote cache and shared cache backends are not implemented yet.
- Deno and Ollama are optional future requirements, not runtime dependencies.
