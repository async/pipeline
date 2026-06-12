# Deno Worker

Task sync writes generated commands into Deno manifests, not just `package.json`. This example is a small Deno HTTP worker whose pipeline syncs the same commands into both:

```ts
sync: {
  tasks: {
    prefix: "pipeline",
    runners: ["package", "deno"],
    targets: [
      { path: "package.json" },        // receives "scripts"
      { path: "worker/deno.json" }     // receives "tasks"
    ],
    jobs: ["verify"],
    scripts: { "sync:check": "sync check" }
  }
}
```

After `sync generate`, `worker/deno.json` looks like:

```json
{
  "tasks": {
    "dev": "deno serve --watch --port 8787 main.ts",
    "pipeline:sync:check": "async-pipeline sync check",
    "pipeline:verify": "async-pipeline run verify"
  }
}
```

The hand-written `dev` task is untouched: sync only writes the namespaced commands the lock owns, and an unmanaged `pipeline:*` collision fails with `ASYNC_PIPELINE_SYNC_CONFLICT` instead of overwriting. Path targets must point at `package.json`, `deno.json`, or `deno.jsonc`. Note that `.jsonc` targets are parsed with comments tolerated, but `sync generate` writes the manifest back as plain JSON — keep synced manifests comment-free (like this example's `deno.json`) if you use comments elsewhere.

## The Pipeline Needs Node, Not Deno

`async-pipeline` is an npm CLI, so the verify job is built from tasks that run anywhere Node >= 24 runs:

```txt
validateWorkerConfig   node script checks worker/deno.json shape
test                   node --test worker/main.test.ts (pure routing logic, native TS)
```

The worker's route handling is a pure function, which is what makes it testable from Node while `deno serve` owns the actual HTTP server.

Deno-binary work is declared, not assumed: the `denoCheck` task sets `requires: { tools: ["deno"] }` and lives in its own manual `workerCheck` job. Without Deno installed the run fails fast and names the reason:

```txt
Task denoCheck failed: Required tool "deno" is not available for task "denoCheck".
```

## Try It Locally

From this example directory:

```sh
pnpm install
pnpm async-pipeline run verify
pnpm async-pipeline sync generate
pnpm async-pipeline sync check
```

With Deno installed:

```sh
pnpm async-pipeline run workerCheck     # deno check worker/main.ts
cd worker && deno task dev              # serve http://localhost:8787/health
deno task pipeline:verify               # the synced command, run by Deno
```

`deno task` resolves `async-pipeline` through `node_modules/.bin`, so the synced tasks work in repos that install the CLI from npm.

## Adapting It

- Point extra `{ path: ... }` targets at any other `deno.json`/`deno.jsonc` manifests that should expose pipeline commands.
- Keep Deno-only steps behind `requires: { tools: ["deno"] }` so laptops without Deno get a clear failure instead of a confusing shell error.
