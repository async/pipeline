import { definePipeline, job, sh, task, trigger } from "@async/pipeline";

export default definePipeline({
  name: "deno-worker",
  cache: "file:local",

  triggers: {
    pr: trigger.github({ events: ["pull_request"] }),
    main: trigger.github({ events: ["push"], branches: ["main"] }),
    manual: trigger.manual()
  },

  // Task sync writes into both manifests: package.json receives `scripts`,
  // worker/deno.json receives Deno `tasks` with the same generated commands.
  sync: {
    github: true,
    tasks: {
      prefix: "pipeline",
      runners: ["package", "deno"],
      targets: [
        { path: "package.json" },
        { path: "worker/deno.json" }
      ],
      jobs: ["verify"],
      scripts: {
        "sync:check": "sync check"
      }
    }
  },

  namedInputs: {
    worker: ["worker/**/*.ts", "worker/deno.json"]
  },

  tasks: {
    validateWorkerConfig: task({
      description: "Validate worker/deno.json shape without the Deno binary.",
      inputs: ["worker", "scripts/check-worker-config.mjs"],
      cache: "file:local",
      run: sh`node scripts/check-worker-config.mjs`
    }),

    test: task({
      description: "Route logic is pure TypeScript: node --test runs it via native type stripping.",
      dependsOn: ["validateWorkerConfig"],
      inputs: ["worker"],
      cache: "file:local",
      run: sh`node --test worker/main.test.ts`
    }),

    denoCheck: task({
      description: "Full Deno typecheck. Requires the deno binary, so it lives outside verify.",
      inputs: ["worker"],
      cache: "file:local",
      requires: { tools: ["deno"] },
      run: sh`deno check worker/main.ts`
    })
  },

  jobs: {
    verify: job({
      target: "test",
      trigger: ["pr", "main", "manual"]
    }),

    workerCheck: job({
      description: "Run when Deno is installed; fails fast with a clear error when it is not.",
      target: "denoCheck",
      trigger: ["manual"]
    })
  }
});
