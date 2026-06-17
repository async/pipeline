import { definePipeline, job, sh, task, trigger } from "@async/pipeline";

export default definePipeline({
  name: "deno-only-pipeline",
  cache: "file:local",

  triggers: {
    pr: trigger.github({ events: ["pull_request"] }),
    main: trigger.github({ events: ["push"], branches: ["main"] }),
    manual: trigger.manual()
  },

  sync: {
    command: "deno run -A ../../packages/pipeline/dist/cli.js",
    github: {
      runtime: "deno@2"
    },
    tasks: {
      runners: ["deno"],
      targets: "root",
      jobs: ["verify"],
      scripts: {
        "sync:check": "sync check"
      }
    }
  },

  namedInputs: {
    source: ["deno.json", "pipeline.ts", "src/**/*.ts"]
  },

  tasks: {
    check: task({
      description: "Typecheck the Deno-only project and pipeline config without Node.",
      inputs: ["source"],
      cache: "file:local",
      requires: { runtime: "deno" },
      run: sh`deno check pipeline.ts src/check.ts`
    }),

    test: task({
      description: "Run Deno tests through the Deno runtime.",
      dependsOn: ["check"],
      inputs: ["source"],
      cache: "file:local",
      requires: { runtime: "deno" },
      run: sh`deno test src/check_test.ts`
    })
  },

  jobs: {
    verify: job({
      target: "test",
      trigger: ["pr", "main", "manual"]
    })
  }
});
