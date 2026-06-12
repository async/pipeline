import { cache, defineCache, definePipeline, fileCache, job, memoryCache, redisCache, sh, task, trigger } from "@async/pipeline";

// One registry, three store shapes:
// - file:    persistent, restores declared outputs on a hit
// - memory:  process-local, gone when the CLI exits
// - redis:   declared metadata only — the node runner refuses to execute it
const caches = defineCache({
  default: "file:local",
  stores: {
    file: fileCache({ root: ".async/cache/tasks" }),
    memory: memoryCache(),
    redis: redisCache({ url: { env: "REDIS_URL" } })
  }
});

export default definePipeline({
  name: "custom-cache-registry",
  cache: caches,

  triggers: {
    manual: trigger.manual()
  },

  namedInputs: {
    orders: ["data/orders.json", "scripts/build-report.mjs"]
  },

  tasks: {
    report: task({
      description: "File-cached with declared outputs: a hit restores build/report.json without re-running.",
      inputs: ["orders"],
      outputs: ["build/report.json"],
      cache: "file:local",
      run: sh`node scripts/build-report.mjs`
    }),

    checkReport: task({
      description: "Directive form of the same idea: cache.use(...) inside the steps array.",
      dependsOn: ["report"],
      inputs: ["orders", "scripts/check-report.mjs"],
      run: [
        cache.use("file:local"),
        sh`node scripts/check-report.mjs`
      ]
    }),

    sessionEcho: task({
      description: "Memory-cached with a TTL: hits only within the same CLI process, and only for 60s.",
      cache: { ref: "memory:session", ttlMs: 60_000 },
      run: sh`echo "memory-cached step ran at $(date +%s)"`
    }),

    remoteEcho: task({
      description: "References the declared redis store. Running this fails: no runtime executor ships for remote stores.",
      cache: "redis:session",
      run: sh`echo "this never caches through redis"`
    })
  },

  jobs: {
    verify: job({
      target: ["checkReport", "sessionEcho"],
      trigger: ["manual"]
    }),

    remote: job({
      description: "Exists to demonstrate the clear error for declared-only remote stores.",
      target: "remoteEcho",
      trigger: ["manual"]
    })
  }
});
