---
title: "@async/pipeline"
description: "One typed pipeline.ts as the single source of truth. GitHub Actions and package scripts or Deno tasks receive only what you choose to sync."
---

# @async/pipeline

One typed `pipeline.ts` is the single source of truth for your verification workflow. It runs on your laptop first — and GitHub Actions, package scripts, or Deno tasks receive only what you explicitly sync to them.

```txt
                 ┌─ run ──────▶  your laptop and CI, evidence under .async/
 pipeline.ts ────┤
 (the source)    └─ sync ─────▶  .github/workflows/async-pipeline.yml   (thin bootloader)
                    opt-in,  ─▶  package scripts or Deno tasks          (namespaced, locked)
                    checked
```

## One Source, No Takeover

Most workflow tools want to own your CI or package-manager manifests. `@async/pipeline` inverts that. Everything is defined once, in `pipeline.ts`. The surfaces other tools read are generated allowlists you opt into per surface:

| Surface | What sync writes | What it never touches |
| --- | --- | --- |
| GitHub Actions | One pinned, low-permission bootloader workflow plus a lock file. It re-checks itself for drift and delegates job selection back to the CLI. | Your other workflows. Task logic never moves into YAML. |
| Package scripts and Deno tasks | Only the namespaced `pipeline:*` commands you select, recorded in an ownership lock. | Your existing scripts and tasks. A name collision fails with `ASYNC_PIPELINE_SYNC_CONFLICT` instead of overwriting. |
| Your machine | Run records, logs, and the task cache under `.async/` (gitignored). | Anything outside `.async/`. |

GitHub Actions stays what it is good at — triggers, runners, permissions, secrets — and stops being where workflow logic lives. Package scripts and Deno tasks stay readable aliases. The graph, caching, retries, and evidence live in one typed file.

Leaving is cheap by design: delete the `sync` block and the generated files, and your repo still works — the workflow and scripts are plain, readable artifacts, not hooks into a framework.

The full story: [Sync: choose what GitHub and package managers see](sync.md).

## Sixty-Second Start

```sh
pnpm add -D @async/pipeline
```

```ts
// pipeline.ts
import { definePipeline, job, sh, task, trigger } from "@async/pipeline";

export default definePipeline({
  name: "app",
  cache: "file:local",
  triggers: {
    pr: trigger.github({ events: ["pull_request"] }),
    main: trigger.github({ events: ["push"], branches: ["main"] })
  },
  sync: {
    github: true,   // generate the bootloader workflow
    tasks: true     // sync job scripts or Deno tasks
  },
  namedInputs: {
    source: ["src/**/*.ts", "package.json", "pnpm-lock.yaml", "tsconfig.json"]
  },
  tasks: {
    typecheck: task({ inputs: ["source"], cache: true, run: sh`pnpm typecheck` }),
    test: task({ dependsOn: ["typecheck"], inputs: ["source"], cache: true, run: sh`pnpm run test` }),
    build: task({ dependsOn: ["test"], inputs: ["source"], outputs: ["dist/**"], cache: true, run: sh`pnpm run build` })
  },
  jobs: {
    verify: job({ target: "build", trigger: ["pr", "main"] })
  }
});
```

```sh
async-pipeline run verify        # run the graph locally, cached and parallel
async-pipeline sync generate     # write the workflow + scripts you opted into
async-pipeline sync check        # fail when any synced surface is stale
```

Inspect what happened:

```sh
ls .async/runs
cat .async/runs/<run-id>/summary.md
```

## The Mental Model

```txt
tasks     = what can run
jobs      = named entrypoints
triggers  = when jobs should run
sync      = generated files to keep current
```

Tasks, jobs, and triggers describe your workflow. Sync is the explicit boundary: it lists exactly which generated files exist outside `pipeline.ts`, and `sync check` fails when they drift.

## Docs

- [Getting started](getting-started.md) — install, first pipeline, what to commit.
- [npm release MVP](npm-release-mvp.md) — the smallest Pipeline setup for publishing one package to npm.
- [Preview packages MVP](preview-packages-mvp.md) — the smallest generated PR package preview setup.
- [GitHub Pages MVP](github-pages-mvp.md) — the smallest generated Pages build and deploy setup.
- [Package repo MVP](package-repo-mvp.md) — releases, preview packages, and Pages together.
- [Sync: choose what GitHub and package managers see](sync.md) — the boundary explained.
- [How it works](how-it-works.md) — define, generate, resolve, run, record.
- [Running locally](local-runs.md) — commands, cache behavior, `gc`, retries.
- [GitHub Actions setup](github-actions.md) — triggers, runners, env, Tart.
- [Many-repo impact runs](many-repo-impact-runs.md) — explicit dependent repos.
- [API reference](api.md) — every config field, exit codes, environment variables.
- [Path to 1.0](path-to-1.0.md) — what freezes, what must be true first.
- [Design decisions: agentic features](adr/index.md) — proposed ADRs for agent steps, an MCP surface, failure context packs, and more.

The package is MIT-licensed and ships from [github.com/async/pipeline](https://github.com/async/pipeline) with zero runtime dependencies.
