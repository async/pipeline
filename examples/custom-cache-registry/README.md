# Custom Cache Registry

A pipeline that overrides the default cache registry with `defineCache(...)`: a tuned file store, a process-local memory store, and a Redis store backed by an instance you provide.

```ts
const caches = defineCache({
  default: "file:local",
  stores: {
    file: fileCache({ root: ".async/cache/tasks" }),
    memory: memoryCache(),
    redis: redisCache({ url: { env: "REDIS_URL" } })
  }
});
```

Cache refs are `store:policy` (`file:local`, `memory:session`). Tasks pick a ref, options object, or directive:

```ts
cache: "file:local"                          // ref form
cache: { ref: "memory:session", ttlMs: 60_000 }   // options form, with TTL
run: [cache.use("file:local"), sh`...`]      // directive form inside steps
```

## What Each Store Does Here

| Task | Store | Behavior you can observe |
| --- | --- | --- |
| `report` | `file:local` | Declares `outputs: ["build/report.json"]`. Delete the file and re-run: the hit restores it without executing the script. |
| `checkReport` | `file:local` (directive form) | Cached across CLI invocations like any file-store task. |
| `sessionEcho` | `memory:session` + `ttlMs` | Hits only within one CLI process. Every new `run` invocation re-executes it — that is the file-vs-memory difference, on display. |
| `remoteEcho` | `redis:session` | Runs against the Redis instance from `REDIS_URL`; without that variable, it fails before execution with a clear configuration error. |

## Try It Locally

From this example directory:

```sh
pnpm install
pnpm async-pipeline run verify
pnpm async-pipeline run verify    # report/checkReport: cached. sessionEcho: runs again (new process)
rm build/report.json
pnpm async-pipeline run-task report   # cached, and build/report.json is restored
```

Cache keys follow declared inputs: edit `data/orders.json` and the chain re-runs; edit this README and nothing does. `pnpm async-pipeline explain report` shows the resolved cache ref and inputs, and `pnpm async-pipeline cache clear` resets the file store.

## Redis Stores Need An Instance

`redisCache({ url: { env: "REDIS_URL" } })` uses the Redis instance you provide. `@async/pipeline` does not depend on a Redis npm client; the node runner uses built-in sockets for the minimal `GET` and `SET` commands its v1 blob cache needs.

```sh
REDIS_URL=redis://localhost:6379/0 pnpm async-pipeline run remote
```

Without `REDIS_URL`, the remote job fails before running the task:

```sh
pnpm async-pipeline run remote
```

```txt
Task remoteEcho failed: Redis cache store requires variable "REDIS_URL".
```

The failure is loud and immediate rather than a silent fall-through to uncached execution, so a task can never claim Redis caching it is not getting. Unknown store names fail earlier still, at normalization, with `ASYNC_PIPELINE_UNKNOWN_CACHE_STORE`.

## Adapting It

- Keep `default` pointing at the store most tasks should use; per-task refs are for exceptions.
- Use `ttlMs` for tasks whose results go stale on a clock (token-adjacent checks, freshness probes) rather than on input changes.
- Use `customCache({ adapter })` for non-Redis remote stores. The adapter only implements `get` and `put`; pipeline still owns cache keys, manifests, TTL checks, output validation, and receipts.
