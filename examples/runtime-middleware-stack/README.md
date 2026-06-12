# Runtime Middleware Stack

`@async/pipeline/runtime` is the embeddable side of the package: `defineRuntime(...)` + `createRuntime(...)` run composed workflows inside your own process — no CLI, no `.async/` evidence, no shell. This example composes two of them:

- an app workflow ([src/app.mjs](src/app.mjs)): a checkout request runs through timing middleware, sequential validation, parallel enrichment, and a branch;
- a background workflow ([src/worker.mjs](src/worker.mjs)): a long-lived runtime drains webhook batches with a memory cache and `dependsOn` ordering.

Both are defined in [src/flows.mjs](src/flows.mjs) from the same five primitives:

```txt
compose(...)   middleware around a flow: (ctx, next) functions, onion-style
[a, b, c]      sequential group
parallel([])   explicit fan-out — concurrency is never inferred
branch(p,a,b)  exactly one side runs
task({...})    the boundary that owns ids, dependsOn, cache, inspection
```

## What The Demos Show

```sh
pnpm install
npm run checkout
```

```txt
checkout desk-lamp x2
  status: passed
  output: {"accepted":true,"sku":"desk-lamp","quantity":2,"totalCents":8500,"elapsedMs":0.223}
checkout monitor-arm x1
  status: passed
  output: {"accepted":false,"reason":"\"monitor-arm\" is out of stock.","elapsedMs":0.088}
inspect: task "handleCheckout" flow kinds: middleware, series, parallel, branch
```

Three things to notice: middleware sees `next()`'s return value and decorates it (`elapsedMs`); after a `parallel([...])` group, `ctx.output` is the array of its results in declaration order, which the `branch` predicate reads; and a rejected order is still `status: "passed"` — the workflow decided, it did not fail. Thrown errors are the failure path, recorded as structured nodes with codes like `ASYNC_PIPELINE_RUNTIME_TASK_FAILED`.

```sh
npm run worker
```

```txt
first drain:  ["drainDeliveries:passed","report:passed"]
second drain: ["drainDeliveries:cached","report:passed"]
partial run of "report" still ordered after its dependency: ["drainDeliveries","report"]
report output: "processed 3 deliveries"
```

`cache.use("memory:session")` makes an identical batch a no-op within the same runtime instance, and `runtime.run(input, { task: "report" })` runs a single task with its dependencies first. `runtime.inspect()` returns the flow tree without executing anything, the same metadata-safety promise `pipeline.ts` makes. `start()`/`stop()`/`close()` are lifecycle markers for embedding hosts; they do not spawn schedulers.

## Where The Pipeline Fits

The flows are app code, so this example's [pipeline.mjs](pipeline.mjs) treats them like any other code under verification: `verify` runs the unit tests, then executes both demo entrypoints, and the repo's example smoke tests pin the key lines quoted above.

```sh
pnpm async-pipeline run verify
```

This example declares no `sync` block at all — no generated workflow, no synced scripts — which is the other thing it demonstrates: sync surfaces are opt-in, and a pipeline without them is just a local task graph.

## When To Reach For The Runtime

Use `pipeline.ts` + the CLI when you want run records, file caching, generated CI, and shell tasks. Use the runtime subpath when the workflow lives inside an application — request handling, queue draining, build tooling — and you still want middleware composition, explicit parallelism, structured failures, and inspectability. `compose(...)` is public exactly so reusable flows can be shared between both worlds.
