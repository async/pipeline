import { definePipeline, job, sh, task, trigger } from "@async/pipeline";

// The runtime flows above are app code; this pipeline is how the repo
// verifies them. Both surfaces come from the same package, and sync is
// entirely optional — this example opts out of generated files.
export default definePipeline({
  name: "runtime-middleware-stack",
  cache: "file:local",

  triggers: {
    manual: trigger.manual()
  },

  namedInputs: {
    source: ["src/**/*.mjs", "package.json"]
  },

  tasks: {
    test: task({
      inputs: ["source"],
      cache: "file:local",
      run: sh`npm test`
    }),

    demo: task({
      description: "Run both demo entrypoints so their output stays honest.",
      dependsOn: ["test"],
      inputs: ["source"],
      cache: "file:local",
      run: [sh`node src/app.mjs`, sh`node src/worker.mjs`]
    })
  },

  jobs: {
    verify: job({
      target: "demo",
      trigger: ["manual"]
    })
  }
});
