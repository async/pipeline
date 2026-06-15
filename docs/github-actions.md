# GitHub Actions Setup

GitHub Actions is the bootloader. `pipeline.ts` owns the workflow logic.

GitHub decides whether to start a workflow from committed YAML before `@async/pipeline` code runs. That means `push`, `pull_request`, `schedule`, `release`, and `workflow_dispatch` must exist in `.github/workflows/*.yml`. The pipeline CLI generates that YAML from metadata-safe trigger declarations.

Triggers describe when jobs should run. Sync describes which generated files should be kept current.

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
  sync: {
    github: true
  },
  tasks: {
    verify: task({ run: sh`pnpm run test` })
  },
  jobs: {
    verify: job({ target: "verify", trigger: ["pr", "main"] }),
    nightly: job({ target: "verify", trigger: ["nightly"] })
  }
});
```

## Workflow Options

The generated workflow installs Node 24 by default and restores the local task cache (`.async/cache`) through a pinned `actions/cache` step keyed by commit with an OS-prefixed fallback, so unchanged tasks resolve as `cached` in CI. Both knobs live in `sync.github`:

```ts
sync: {
  github: {
    nodeVersion: 24,
    cache: true
  }
}
```

Each generated job also runs `async-pipeline explain --run latest` on failure and uploads `.async/runs` with a pinned `actions/upload-artifact` step. GitHub Actions stays a bootloader for the same task graph; the uploaded evidence is the local run record, graph snapshot, cache receipts, logs, and context packs from the normal runner.

## GitHub Pages

Use `github.pages` on a job whose target verifies or builds docs/site content:

```ts
jobs: {
  pages: job({
    target: "docs",
    trigger: ["pr", "main", "manual"],
    github: {
      pages: {
        build: { kind: "jekyll", source: "./docs", destination: "./_site" }
      }
    }
  })
}
```

GitHub Pages jobs build on pull requests and deploy from `main` or selected manual dispatch through generated build and deploy jobs.

The generated build job still runs `async-pipeline run <job-id>` first, then configures Pages, builds or selects the static artifact, and uploads it. The paired `<job-id>-deploy` job is skipped on pull requests and deploys the uploaded artifact with the `github-pages` environment and Pages token permissions on non-PR events.

## Runner Selection

Generated jobs run on `ubuntu-latest` by default. Use `job({ github: { runsOn } })` to select a hosted runner or self-hosted label set, and `job({ github: { runsOnMatrix } })` to fan a job out across multiple runner label sets:

```ts
jobs: {
  verify: job({
    target: "verify",
    trigger: ["pr", "main"],
    github: {
      runsOnMatrix: [
        "ubuntu-latest",
        ["self-hosted", "macos", "tart"]
      ]
    }
  })
}
```

`runsOn` and `runsOnMatrix` are mutually exclusive; invalid or empty labels fail during pipeline normalization before workflow generation.

## Execution Profiles

Use `execution.github(...)` when you want a named profile to choose both the sandbox provider and the generated GitHub runner default:

```ts
import { definePipeline, execution, job, sandbox, sh, task, trigger } from "@async/pipeline";

export default definePipeline({
  name: "app",
  triggers: {
    pr: trigger.github({ events: ["pull_request"] })
  },
  sandboxes: {
    node24: sandbox.container({ image: "node:24", workdir: "/workspace" })
  },
  execution: {
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
    verify: job({ target: "verify", trigger: ["pr"], execution: "linuxCi" })
  }
});
```

`execution.github(...)` supplies GitHub runner defaults and generated workflows pass `--execution <id>` to the pipeline command. If a job also sets `github.runsOn` or `github.runsOnMatrix`, the raw `github` field wins for runner selection while the execution profile still selects the CLI execution profile.

### macOS Runners With Tart

GitHub hosts the `ubuntu-*` and `macos-*` labels (the self pipeline's `verify` job fans out across `ubuntu-latest` and `macos-latest`). A label set such as `["self-hosted", "macos", "tart"]` instead expects a runner you provide on Apple Silicon using [Tart](https://tart.run) VMs — useful when you want faster runners, controlled images, or you already own the hardware.

A minimal host setup:

1. Install Tart on the Mac host and pull a base image: `tart clone ghcr.io/cirruslabs/macos-sequoia-base:latest runner-base`.
2. Run an ephemeral runner manager such as [Tartelet](https://github.com/shapehq/tartelet) or [ekiden](https://github.com/mirego/ekiden) so every job executes in a fresh VM that is destroyed after one job.
3. Register the runner against the repository or organization with the labels `self-hosted`, `macos`, and `tart`. The VM image needs Node `>= 24`; the generated workflow's setup-node step handles version selection from there.

Confirm managed macOS runner availability before depending on it; self-hosting is the path this repository documents. Two cautions:

- A job that targets labels with no registered runner queues until GitHub times it out. Keep the macOS leg out of your matrix until the host exists, or use a GitHub-hosted label such as `"macos-latest"` instead.
- Self-hosted runners execute pull-request code on your hardware. For public repositories, require approval for workflow runs from outside collaborators (Settings -> Actions), or reserve self-hosted labels for `push` and `release` triggers.

## Generate The Bootloader

```sh
async-pipeline github generate
# or
async-pipeline sync github generate
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
- run one generated pipeline job with `async-pipeline run <job-id>`

The lock file records the generator version, config path, workflow path, hash, rendered triggers, rendered jobs, package manager, and bootloader options.

For tests or scratch generation, override both generated paths:

```sh
async-pipeline github generate --workflow .tmp/async-pipeline.yml --lock .tmp/async-pipeline.lock.json
async-pipeline github check --workflow .tmp/async-pipeline.yml --lock .tmp/async-pipeline.lock.json
async-pipeline sync github generate --workflow .tmp/async-pipeline.yml --lock .tmp/async-pipeline.lock.json
async-pipeline sync github check --workflow .tmp/async-pipeline.yml --lock .tmp/async-pipeline.lock.json
```

## Check For Drift

Use this locally and in CI:

```sh
async-pipeline github check
# or
async-pipeline sync github check
```

The command loads `pipeline.ts`, recomputes the GitHub-relevant metadata hash, renders the workflow again, and fails if either generated file is stale.

Task command changes do not force workflow regeneration unless they affect jobs, triggers, package-manager bootstrapping, or the generated workflow shape.

## Run In GitHub

The generated workflow creates one GitHub Actions job per pipeline `job(...)`. Each generated job calls:

```sh
async-pipeline run <job-id>
```

Jobs with `job({ execution: "..." })` instead call:

```sh
async-pipeline run <job-id> --execution <id>
```

The generated workflow still uses GitHub event conditions from pipeline triggers:

- `push` and `pull_request` match `trigger.github(...)`.
- `release` can match `trigger.github({ events: ["release"] })`.
- `schedule` matches `trigger.cron(...)`.
- `workflow_dispatch` can run manual jobs.

Manual workflow runs require selecting a single pipeline job; generated manual jobs are gated on that selection.

The execution records still go under `.async/runs` inside the runner workspace.

## Runtime Env

Keep platform-specific GitHub settings under `github`, and runtime process env under `env`.

```ts
import { definePipeline, env, job, sh, task, trigger } from "@async/pipeline";

export default definePipeline({
  name: "app",
  env: {
    NODE_ENV: env.var("NODE_ENV", { default: "dev" })
  },
  triggers: {
    manual: trigger.manual()
  },
  tasks: {
    publish: task({
      run: sh`npm publish --access public --provenance`
    })
  },
  jobs: {
    publish: job({
      target: "publish",
      trigger: ["manual"],
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
    })
  }
});
```

The generated GitHub job renders platform config at the job level:

```yaml
environment:
  name: "npm-publish"
  url: "https://www.npmjs.com/package/@async/pipeline"
permissions:
  contents: read
  id-token: write
```

It renders runtime env on the pipeline step:

```yaml
- name: Run pipeline job
  run: pnpm async-pipeline run publish
  env:
    CI: true
    NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

`env.secret("NPM_TOKEN")` means "source this value from the platform secret named `NPM_TOKEN`." The runtime destination is the env key you assign it to, such as `NODE_AUTH_TOKEN`.

`env.var("NAME")` maps to `${{ vars.NAME }}` in generated GitHub Actions. `env.var("NODE_ENV", { prod, dev }, { default: "dev" })` is resolved by `async-pipeline run` before the task command runs.

Missing secrets, missing variables without defaults, and unmapped values fail before the task command runs.

## Local Env Tests

You do not need GitHub Actions to test env behavior. Pass an env in a local test, then call `runJob(...)`.

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

For `env: { NODE_AUTH_TOKEN: env.secret("NPM_TOKEN") }`, the runner accepts either `NPM_TOKEN` or `NODE_AUTH_TOKEN`. This lets local tests cover the same step that GitHub runs.

## Command Policy

Command policy can mock or deny CLI/tool commands during local tests and agent runs:

```ts
import { command, definePipeline } from "@async/pipeline";

export default definePipeline({
  name: "app",
  commands: command.policy({
    rules: [
      command.rule({
        exact: ["async-pipeline", "github", "check"],
        action: command.mock({ code: 0, stdout: "GitHub workflow is current.\n" })
      }),
      command.rule({
        prefix: ["npm", "publish"],
        action: command.deny()
      })
    ],
    fallback: command.allow(),
    record: true,
    output: { maxBytes: 20_000, redactSecrets: true }
  }),
  tasks: {},
  jobs: {}
});
```

Generated GitHub Actions do not install PATH shims yet. Future GitHub workspace/shim work will route selected tools through this policy in CI.

## Cache

The generated workflow persists `.async/cache` through the generated `actions/cache` step when `sync.github.cache` is true. The run evidence artifact uploads `.async/runs`; it is diagnostic evidence, not a remote task-cache adapter.

Keep package-manager caching separate from `@async/pipeline` task caching.

## Permissions

For verification-only pipelines, the generated workflow uses:

```yaml
permissions:
  contents: read
```

Add write permissions only when a pipeline publishes, comments, deploys, or uploads privileged artifacts.

Per-job grants come from `github.permissions` on the job. Supported fields are `contents`, `idToken`, `issues`, `packages`, and `pullRequests`; unknown fields are rejected with `ASYNC_PIPELINE_UNKNOWN_FIELD`:

```ts
job({
  target: "preview",
  trigger: ["pr"],
  env: { GITHUB_TOKEN: env.secret("GITHUB_TOKEN") },
  github: {
    permissions: {
      issues: "write",
      packages: "write",
      pullRequests: "write"
    }
  }
});
```

renders:

```yaml
permissions:
  contents: read
  issues: write
  packages: write
  pull-requests: write
```

Commenting on a pull request with `GITHUB_TOKEN` routes through `pullRequests: "write"` even when the call uses the issues comments API.

Job-level permissions replace the workflow defaults, so the generator restates `contents: read` automatically whenever a job grants anything else; checkout keeps repo access without you remembering to add it.

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
