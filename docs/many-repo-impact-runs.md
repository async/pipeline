# Many-Repo Impact Runs

Use many-repo impact runs when one repo owns a candidate change and you want to run explicitly declared dependent repos against it.

The dependency map is developer-owned. `@async/pipeline` does not scan package manifests, lockfiles, npm metadata, or GitHub to infer dependents.

## Define Sources

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
    }),
    admin: source.path({
      path: "../admin",
      pipeline: "pipeline.ts",
      writable: true,
      prepare: [sh`pnpm install --frozen-lockfile`]
    })
  },
  tasks: {
    impact: task({
      dependsOn: ["storefront:test", "admin:test-design-system"]
    })
  },
  jobs: {
    verifyImpact: job({ target: "impact" })
  }
});
```

Each source repo must have its own pipeline file. Root tasks reference source tasks with `<source>:<task>`.

## Prepare Sources

`prepare` runs inside the source checkout before source tasks run. The root pipeline owns candidate wiring, so it can install dependencies, link a local package, or write config required by the dependent repo.

Static shell steps stay simple:

```ts
sh`pnpm install --frozen-lockfile`
```

Use deferred shell only when runtime context is needed:

```ts
sh((ctx) => sh`pnpm add @acme/design-system@file:${ctx.candidate.dir}`)
```

Deferred shell callbacks are not evaluated during metadata reads.

Path sources with `prepare` require `writable: true` in v1. Git sources use warm checkouts under `.async/sources`.

## Run Locally

List source declarations:

```sh
async-pipeline sources list
```

Sync declared sources:

```sh
async-pipeline sources sync
```

Run the impact job:

```sh
async-pipeline run verifyImpact
```

Run one dependent task:

```sh
async-pipeline run-task storefront:test
```

Repeated runs can reuse source checkouts, dependency/build caches inside those checkouts, and `.async/cache/tasks`.

## Read Metadata

```sh
async-pipeline metadata --format json
async-pipeline metadata --format json --include-sources
```

Metadata reads do not clone, prepare, run, or evaluate deferred shell callbacks. `--include-sources` only loads source pipeline metadata from already-available source paths or synced checkouts.

## GitHub Actions

Generate a matrix from the declared source task refs:

```sh
async-pipeline matrix verifyImpact --format github
```

The command prints:

```json
{"include":[{"task":"storefront:test","source":"storefront","taskId":"test","type":"git","url":"https://github.com/acme/storefront.git","ref":"main"}]}
```

A workflow can use that matrix and run:

```sh
async-pipeline run-task "$TASK"
```

This runs dependent repo tasks in the current repo's CI runner. `async-pipeline github generate` can generate the bootloader workflow for the current repo, but v1 does not dispatch workflows in consumer repos.

## Why It Stays Explicit

Explicit sources make the review surface clear:

- which repos are being checked
- which ref each repo starts from
- which pipeline file is trusted
- which `prepare` steps mutate a source checkout
- which namespaced tasks are required before the root job passes

That is less magical than automatic dependency discovery, but it keeps impact checks inspectable and metadata-safe.
