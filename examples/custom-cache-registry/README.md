# Custom Cache Registry

A pipeline that overrides the default cache registry with `defineCache(...)`: a tuned file store, a process-local memory store, and a declared-but-not-executable remote (Redis) placeholder.

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
| `remoteEcho` | `redis:session` | Declared metadata. Running it fails; see below. |

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

## Remote Stores Are Declared, Not Faked

`redisCache({ url: { env: "REDIS_URL" } })` registers runtime metadata — useful for future runtimes and for tooling that reads pipeline metadata — but `@async/pipeline` ships no Redis client, and the node runner refuses to pretend otherwise:

```sh
pnpm async-pipeline run remote
```

```txt
Task remoteEcho failed: Cache store "redis" is registered but this runner cannot execute it. Use "file" or "memory", or provide a runtime-specific executor.
```

The failure is loud and immediate rather than a silent fall-through to uncached execution, so a task can never claim remote caching it is not getting. Unknown store names fail earlier still, at normalization, with `ASYNC_PIPELINE_UNKNOWN_CACHE_STORE`.

## Adapting It

- Keep `default` pointing at the store most tasks should use; per-task refs are for exceptions.
- Use `ttlMs` for tasks whose results go stale on a clock (token-adjacent checks, freshness probes) rather than on input changes.
- Treat the remote store entry as a contract for where your team wants caching to go next, not as configuration that does something today.
