---
title: "Sync: Choose What GitHub And Package Managers See"
description: "pipeline.ts is the single source of truth. Sync is the explicit, checked boundary that decides what GitHub Actions and package-manager manifests receive."
---

# Sync: Choose What GitHub And Package Managers See

`pipeline.ts` owns the workflow. GitHub Actions and package-manager manifests are read surfaces other tools depend on — so instead of taking them over, `@async/pipeline` generates exactly the pieces you opt into, records ownership, and fails loudly on drift or collision.

```ts
sync: {
  github: true,   // one bootloader workflow + lock
  tasks: true     // job scripts in package.json or tasks in deno.json
}
```

Both are independent. Omit either and that surface is never touched.

## GitHub Actions Gets A Bootloader, Not Your Logic

GitHub decides whether to start a workflow from committed YAML before any of your code runs. That YAML is the only thing sync puts there:

```sh
async-pipeline sync github generate
```

writes two files:

```txt
.github/workflows/async-pipeline.yml   # pinned actions, contents: read, calls the CLI
.github/async-pipeline.lock.json       # hash of the trigger/job metadata it was built from
```

The workflow checks out, sets up the pipeline runtime, restores the task cache, runs `async-pipeline github check` (so a stale workflow fails its own run), and delegates job selection back to the CLI. Task commands, dependency order, caching, and retries never appear in YAML — they stay in `pipeline.ts`, which means changing a task does not require touching CI.

What this deliberately does not do:

- It does not scan, modify, or delete your other workflow files.
- It does not put secrets in the workflow; `env.secret("NAME")` renders as `${{ secrets.NAME }}` references.
- It does not grant permissions; the bootloader is `contents: read` unless a job declares more (for example npm provenance).

## Package Scripts And Deno Tasks Stay Yours

`sync.tasks` writes package-manager aliases for the jobs you pick — and nothing else:

```ts
sync: {
  tasks: {
    prefix: "pipeline",
    jobs: ["verify"],
    tasks: ["claims.report"],
    scripts: { "sync:check": "sync check" }
  }
}
```

```json
{
  "scripts": {
    "pipeline:verify": "async-pipeline run verify",
    "pipeline:task:claims.report": "async-pipeline run-task claims.report",
    "pipeline:sync:check": "async-pipeline sync check"
  }
}
```

Every generated script is namespaced under your chosen prefix and recorded in `.async-pipeline/tasks.lock.json`. That lock is the ownership boundary: sync only ever rewrites scripts the lock claims. If a generated name collides with a script it does not own, generation fails with `ASYNC_PIPELINE_SYNC_CONFLICT` instead of overwriting your work. Your hand-written scripts are never rewritten, reordered, or removed.

Deno-only repos can omit `package.json`: with `deno.json` or `deno.jsonc` at the root, generated tasks default to `deno run -A npm:@async/pipeline/cli`.

## Drift Is An Error, Not A Surprise

The generated files are committed, so they are reviewable in every PR — and checkable:

```sh
async-pipeline sync check     # all synced surfaces match pipeline.ts, or non-zero
async-pipeline sync generate  # regenerate everything that is stale
```

Run `sync check` in the pipeline itself (this repo does) and a hand-edited workflow or script fails CI with a diffable reason. The boundary stays honest in both directions: `pipeline.ts` cannot silently diverge from what GitHub runs, and nobody can quietly move logic into YAML.

## Leaving Is Cheap

The exit test for any tool that generates files: what happens when you remove it?

1. Delete the `sync` block from `pipeline.ts`.
2. Delete `.github/workflows/async-pipeline.yml`, the lock files, and the `pipeline:*` scripts.

That is the whole list. The generated workflow, scripts, and tasks are plain artifacts with no runtime hook back into the package — until that day, they are simply the parts of your pipeline you chose to publish to GitHub and package managers.

## Where To Go Next

- [GitHub Actions setup](github-actions.md) — triggers, runner selection, env and secrets, self-hosted Tart runners.
- [API reference](api.md#sync) — every `sync` field.
- [Getting started](getting-started.md) — what to commit and what to gitignore.
