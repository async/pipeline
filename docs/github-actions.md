# GitHub Actions Setup

GitHub Actions is the bootloader. `pipeline.ts` owns the workflow logic.

GitHub decides whether to start a workflow from committed YAML before `@async/pipeline` code runs. That means `push`, `pull_request`, `schedule`, `release`, and `workflow_dispatch` must exist in `.github/workflows/*.yml`. The pipeline CLI generates that YAML from metadata-safe trigger declarations.

## Author Triggers In TypeScript

```ts
import { definePipeline, job, sh, task, trigger } from "@async/pipeline";

export default definePipeline({
  name: "app",
  triggers: {
    pr: trigger.github({ events: ["pull_request"] }),
    main: trigger.github({ events: ["push"], branches: ["main"] }),
    nightly: trigger.cron("17 2 * * *")
  },
  tasks: {
    verify: task({ run: sh`pnpm test` })
  },
  jobs: {
    verify: job({ target: "verify", trigger: ["pr", "main"] }),
    nightly: job({ target: "verify", trigger: ["nightly"] })
  }
});
```

## Generate The Bootloader

```sh
async-pipeline github generate
```

This writes:

```txt
.github/workflows/async-pipeline.yml
.github/async-pipeline.lock.json
```

The generated workflow is intentionally thin:

- checkout with a pinned action SHA
- setup Node with a pinned action SHA
- enable pnpm
- install dependencies
- build the CLI when the project dogfoods it from source
- run `async-pipeline github check`
- run `async-pipeline github run`

The lock file records the generator version, config path, workflow path, hash, rendered triggers, rendered jobs, package manager, and bootloader options.

For tests or scratch generation, override both generated paths:

```sh
async-pipeline github generate --workflow .tmp/async-pipeline.yml --lock .tmp/async-pipeline.lock.json
async-pipeline github check --workflow .tmp/async-pipeline.yml --lock .tmp/async-pipeline.lock.json
```

## Check For Drift

Use this locally and in CI:

```sh
async-pipeline github check
```

The command loads `pipeline.ts`, recomputes the GitHub-relevant metadata hash, renders the workflow again, and fails if either generated file is stale.

Task command changes do not force workflow regeneration unless they affect jobs, triggers, package-manager bootstrapping, or the generated workflow shape.

## Run In GitHub

The generated workflow calls:

```sh
async-pipeline github run
```

`github run` reads GitHub event context from environment variables and the event payload, then runs matching pipeline jobs:

- `push` and `pull_request` match `trigger.github(...)`.
- `release` can match `trigger.github({ events: ["release"] })`.
- `schedule` matches `trigger.cron(...)`.
- `workflow_dispatch` runs the pipeline jobs manually.

The execution records still go under `.async/runs` inside the runner workspace.

## Cache

The generated workflow does not persist `.async/cache` by default. The built-in task cache is runner-local unless you explicitly add a separate GitHub cache step or a future remote cache adapter.

Keep package-manager caching separate from `@async/pipeline` task caching.

## Permissions

For verification-only pipelines, the generated workflow uses:

```yaml
permissions:
  contents: read
```

Add write permissions only when a pipeline publishes, comments, deploys, or uploads privileged artifacts.

## Many-Repo Matrix

GitHub triggers still come from YAML, but dynamic matrices can be produced after the workflow starts:

```sh
async-pipeline matrix verifyImpact --format github
```

Use that output in a planning job, then run namespaced tasks with:

```sh
async-pipeline run-task "$TASK"
```

This keeps impact runs explicit and metadata-safe. v1 does not dispatch workflows in consumer repos.
