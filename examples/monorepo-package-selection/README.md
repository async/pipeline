# Monorepo Package Selection

One `pipeline.ts` at the workspace root verifies three packages, while task sync writes generated scripts into only the two packages selected by `package.json#name`:

```ts
sync: {
  tasks: {
    prefix: "pipeline",
    runners: ["package"],
    targets: [
      { package: "@async-framework/example-monorepo-app" },
      { package: "@async-framework/example-monorepo-api" }
    ],
    jobs: ["verify"],
    scripts: { "sync:check": "sync check" }
  }
}
```

Package selectors are resolved by scanning the repo for a `package.json` whose `name` matches — not by package-manager workspace config — so selection works the same under pnpm, npm, or yarn. A selector that matches nothing fails with `ASYNC_PIPELINE_SYNC_TARGET_NOT_FOUND`; one that matches twice fails with `ASYNC_PIPELINE_SYNC_AMBIGUOUS_TARGET` unless you set `allowMultiple`.

## Files

```txt
package.json                     workspace root ("workspaces" field), owns the @async/pipeline devDependency
pipeline.ts
packages/app/                    selected: receives pipeline:* scripts
packages/api/                    selected: receives pipeline:* scripts
packages/internal-tools/         verified by the pipeline, but never synced
```

Inside this repo the example deliberately ships no `pnpm-workspace.yaml` of its own — pnpm resolves the nearest workspace file, and a nested one would cut the example off from the `workspace:*` dependency it needs. When you copy the example out as a standalone pnpm monorepo, add a `pnpm-workspace.yaml` with `packages: ["packages/*"]` and install `@async/pipeline` from the registry.

## Pipeline Model

```txt
tasks     = test-app, test-api, test-internal-tools (independent, run in parallel)
jobs      = verify -> all three tasks (a job target can be a list)
triggers  = pull_request, push to main, manual
sync      = github bootloader + scripts in the two selected packages
```

Each task declares only its own package's files as inputs, so editing `packages/api/` re-runs `test-api` while the other two stay `cached`.

## Try It Locally

From this example directory:

```sh
pnpm install
pnpm async-pipeline run verify
pnpm async-pipeline sync generate
```

Sync writes `pipeline:verify` and `pipeline:sync:check` into `packages/app/package.json` and `packages/api/package.json`, records ownership in `.locks/pipeline/tasks.lock.json`, and leaves `packages/internal-tools/package.json` alone.

The generated scripts work from inside the packages because the CLI finds `pipeline.ts` by walking up:

```sh
cd packages/app
pnpm run pipeline:verify   # runs the workspace-root verify job
```

## Why Select Packages At All?

The root pipeline stays the single source of truth, but people working inside `packages/app` get a local `pnpm run pipeline:verify` without knowing where the pipeline lives. Packages that should not advertise pipeline entrypoints — internal tooling, fixtures, generated code — simply are not listed as targets, and `sync check` will never complain about them.
