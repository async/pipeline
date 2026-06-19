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

The generated workflow uses the pinned `pnpm/setup` provider by default to install pnpm plus the requested runtime for the current pipeline CLI. Repos can opt into the shared Async setup action with `setup: "async"` when they want one generated setup step for Node, pnpm, npm, optional Deno/Bun runtimes, registry auth, dependency cache, and dependency install. When task caching is enabled, the workflow writes a pipeline-owned cache manifest and delegates restore/save receipts to `async/actions/cache`. These knobs live in `sync.github`:

```ts
sync: {
  github: {
    setup: "auto",
    nodeVersion: 24,
    runtime: ["node@24", "deno@2"],
    cache: true,
    dependencyCache: true,
    dependabotAutoMerge: true,
    packagePreviews: true,
    evidence: true,
    sourceImpact: true,
    attest: true,
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

`setup: "auto"` currently resolves to the default pinned `pnpm/setup` provider. Explicit `setup: "async"` selects `async/actions/setup`. Package projects default to `node@<nodeVersion>`; Deno-only projects with `deno.json` or `deno.jsonc` and no `package.json` default to `deno@2`; explicit `runtime` accepts a string or array such as `["node@24", "deno@2"]`. Use `setup: "node"` when you explicitly want the older `actions/setup-node` + Corepack bootloader for a single Node runtime. `cache` controls the task cache manifest and generated `async/actions/cache` steps. `dependencyCache` controls dependency-store cache settings: with the default pnpm setup, the generated workflow passes the recognized lockfile to `pnpm/setup`; with `setup: "async"`, it passes the recognized lockfile to `async/actions/setup`. Set it to `false` when you need a fully cold dependency install.

All generated remote `uses:` references, including `async/actions/*`, are resolved from the central action manifest and emitted as full 40-character SHAs with a trailing human label. Tags such as `v0` remain compatibility labels for readers and hand-written consumers, but generated privileged workflows execute the reviewed SHA recorded by `@async/pipeline`.

### Runtime Setup Notes For Agents

`async/actions/setup` accepts a newline runtime list, so repos that opt into `setup: "async"` can use one shared Async setup step instead of splitting runtime setup across `pnpm/setup` and `denoland/setup-deno`.

The default `pnpm/setup` provider still has the historical single-runtime constraint: it installs one primary runtime through `pnpm/setup`, then renders separate setup for additional runtimes. This remains the default until the Async setup action is tested broadly enough to become the generated default.

Each generated job calls `async/actions/run` to run the pipeline command, explain failures, and upload `.async/runs` as evidence. GitHub Actions stays a bootloader for the same task graph; the uploaded evidence is the local run record, graph snapshot, cache receipts, logs, and context packs from the normal runner.

`sync.github.evidence: true` adds a `Collect evidence manifest` step to generated jobs and an `evidence` fan-in job that downloads `async-evidence-*` artifacts, merges their manifests through `async/actions/evidence`, and uploads a bounded index artifact. Manifest entries record paths, kinds, byte counts, and SHA-256 digests; receipt metadata is sanitized before inclusion and raw file contents are not copied into the manifest.

Generated jobs with agent steps call `async/actions/agent-evidence` after the pipeline run. Pipeline owns the agent profile declarations, task outputs, generated permissions, and comment policy; the action packages prompt files, redacted transcripts, context packs, and explicit task outputs into metadata-only bundles and receipts for evidence fan-in. When the job grants pull request or issue write permission, the generated workflow can hand a bounded summary body to `async/actions/comment` behind the same same-repo PR guard used for package preview comments.

`sync.github.sourceImpact: true` adds generated `<job>-source-plan` and `<job>-sources` jobs for source-backed pipeline jobs while leaving the original job in place. The plan job writes reviewed source metadata into the workflow, `async/actions/source-impact` emits the source matrix, and each matrix row validates checkout and representable prepare commands before running the namespaced source task. Prepare callbacks or unrepresentable steps stay out of the lowered path and are recorded as skip reasons; the normal job still runs through `async/actions/run`.

`sync.github.attest: true` adds attestation evidence steps to generated release lifecycle jobs. Pipeline still owns the release job graph, package subjects, OIDC grants, trusted-publishing setting, and release ordering; `async/actions/attest` only computes subject digests, writes SBOM evidence, scans explicit npm tarball subjects, and records bounded provenance or attestation receipts. Digest and SBOM evidence does not grant OIDC by itself. `id-token: write` is rendered only when the job declares `requires.provenance: true` or `sync.github.attest.githubAttestation: true`.

Generated release lifecycle jobs add `async/actions/doctor` steps for `@async/release` package planning, package inspection, changelog checks, release-note rendering, and final doctor evidence under `.async/release`. The GitHub Release publish step uses `.async/release/release-notes.md`, and registry or GitHub writes still run through `async/actions/publish`. Pipeline owns the release job graph, package path, action command, and secret routing; `@async/release` owns deterministic package evidence and doctor checks.

Generated comment and annotation steps call `async/actions/comment`. Pipeline owns whether a job may comment, the target issue or pull request number, the marker id, fork pull request policy, and the explicit token expression. The comment action owns marker upserts, markdown body loading, summary appends, annotation rendering, bounded bodies, and comment id/url outputs.

Lifecycle lowering only happens for exact, whole-command publish, preview, release, or doctor lifecycle steps with representable semantics. Compound shell syntax, unmodeled flags, retries, and timeouts stay in the normal `async/actions/run` path so the pipeline runtime keeps ownership of task semantics. Generated lifecycle publish, preview, and release doctor steps pass secret env only to the exact Async action step that needs it.

## Generated Package Previews And Dependabot Merge

`sync.github.packagePreviews: true` generates a `package-preview` job on pull requests. The generator finds the public root package, or the single public `packages/*` workspace package when the root package is private. It runs the `pack` task when present, falls back to `build`, then calls `async/actions/preview` with the selected package path and GitHub Packages registry. Same-repo PRs publish immutable `0.0.0-pr.<n>.sha.<sha>` previews and update one install comment through `async/actions/comment`; fork PRs skip publish inside the preview action and skip the generated comment step through an explicit same-repo guard.

Use object form when inference is ambiguous or a repo publishes previews somewhere else:

```ts
sync: {
  github: {
    packagePreviews: {
      package: "packages/pipeline",
      target: "pack",
      registry: "https://npm.pkg.github.com",
      namespace: "async",
      tokenEnv: "GITHUB_TOKEN"
    }
  }
}
```

`sync.github.dependabotAutoMerge: true` generates a separate `dependabot-auto-merge` job on `pull_request_target`. It only runs for `dependabot[bot]`, fetches Dependabot metadata, then calls `async/actions/dependabot-merge` with the allowed ecosystems. The action approves, waits for non-self checks, then schedules a squash merge with branch deletion.

## Generated Actions Bridge

`sync.github.bridge` generates an `async-bridge` job that can pull approved Async change sets, enforce the configured branch prefix and path allowlist, and apply them through `@async/github-app`.

```ts
sync: {
  github: {
    bridge: {
      mode: "actions",
      schedule: "*/15 * * * *",
      pullRequest: true,
      branchPrefix: "async/bridge/",
      allowedPaths: ["pipeline.ts", "package.json", "docs/**"],
      endpointVar: "ASYNC_PROJECT_URL",
      tokenEnv: "ASYNC_PROJECT_TOKEN",
      packageVersion: "latest"
    }
  }
}
```

The generated bridge job adds `workflow_dispatch` plus the configured schedule, requests only `contents: write` and `pull-requests: write`, uses one writer concurrency group per repository, runs `async-pipeline github check` without project credentials, then passes the Async project URL, project token, repository, and `GITHUB_TOKEN` only to the bridge pull step. Actions-primary mode requires a non-empty `allowedPaths` list, and `.github/workflows/**` writes are rejected so workflow changes go through `pipeline.ts` plus regeneration.

## GitHub Pages

Use `sync.github.pages` to generate GitHub Pages build and deploy jobs from an existing docs/site task without declaring a local Pages job:

```ts
sync: {
  github: {
    pages: {
      target: "docs.site",
      build: { kind: "static", path: ".async/pages" }
    }
  }
}
```

`sync.github.pages: true` infers a target from `pages`, `docs.site`, `docs`, then `build-pages`, uploads `.async/pages` as a static artifact, builds on pull requests, and deploys from `main` or selected manual dispatch. Object form can set `target`, `job`, `build`, `artifactName`, `environment`, and trigger settings. `build.kind` supports `static`, `jekyll`, and `prerender`; prerender means the pipeline task produced static files for GitHub Pages, not a long-running SSR server.

Use lower-level `github.pages` on a job only when the generated sync-level Pages job is not enough:

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

The generated sync-level build job runs `async-pipeline run-task <target>` first; lower-level job Pages runs `async-pipeline run <job-id>`. Both forms call `async/actions/pages` to configure Pages, build or select the static/prerender artifact, validate it, and upload it. The paired `<job-id>-deploy` job is skipped on pull requests and deploys the uploaded artifact through `async/actions/pages` with the `github-pages` environment and Pages token permissions on non-PR events.

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
3. Register the runner against the repository or organization with the labels `self-hosted`, `macos`, and `tart`. The VM image needs to run the generated setup action; by default `pnpm/setup` installs pnpm and the Node `>= 24` runtime for the pipeline CLI.

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

The lock file records the generator version, config path, workflow path, hash, resolved action refs and SHAs, rendered triggers, rendered jobs, package manager, and bootloader options.

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

The command loads `pipeline.ts`, recomputes the GitHub-relevant metadata hash, renders the workflow again, and fails if either generated file is stale. The drift check also fails if a committed generated workflow contains any mutable remote action ref instead of a full SHA.

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
- `release` can match `trigger.github({ events: ["release"], types: ["published"] })`.
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

For npm releases, pair `requires.provenance: true` with either npm trusted publishing on the package or an `NPM_TOKEN` secret. Generated release workflows should call `async/actions/publish`, which creates temporary npm auth only when a token is present; tokenless runs stay clean so npm can use trusted publishing/OIDC.

Release evidence can opt into attestation receipts without changing publish ownership:

```ts
sync: {
  github: {
    attest: {
      artifacts: ["dist/*.tgz", ".async/evidence/index.json"],
      subjectManifest: ".async/attest/release-subjects.json",
      sbomPath: ".async/attest/release-sbom.json",
      requireNpmProvenance: true,
      tarballScan: true,
      githubAttestation: true
    }
  }
}
```

Generated attestation receipts land under `.async/actions/receipts/` by default,
so `sync.github.evidence` fan-in includes the digest, SBOM, and attestation
status without copying package bytes or raw logs into the manifest.

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

The generated workflow writes an Async task-cache manifest and calls `async/actions/cache` to restore declared `.async/cache/tasks/<key>` paths when `sync.github.cache` is true. Cache saves run only after a successful trusted non-PR job and use the same generated manifest with read-write trust. The generated workflow also enables dependency-store caching through `pnpm/setup` when `sync.github.dependencyCache` is true and the package manager has a recognized lockfile. Deno-only generated workflows run `deno install` instead of package-manager install. The run evidence artifact uploads `.async/runs`; it is diagnostic evidence, not a remote task-cache adapter.

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

This keeps impact runs explicit and metadata-safe. `sync.github.sourceImpact: true` is the generated version of that pattern: it writes a reviewed source plan, runs `<job>-source-plan` to produce the matrix, and runs `<job>-sources` for source-backed task refs while preserving the original job. v1 does not dispatch workflows in consumer repos.
