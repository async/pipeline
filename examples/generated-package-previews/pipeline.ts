import { definePipeline, job, sh, task, trigger } from "@async/pipeline";

export default definePipeline({
  name: "generated-package-previews",

  triggers: {
    pr: trigger.github({ events: ["pull_request"] }),
    main: trigger.github({ events: ["push"], branches: ["main"] }),
    manual: trigger.manual()
  },

  sync: {
    github: {
      dependabotAutoMerge: true,
      packagePreviews: true
    },
    tasks: true
  },

  namedInputs: {
    source: ["src/**/*.js", "scripts/**/*.js", "package.json"]
  },

  tasks: {
    test: task({
      inputs: ["source"],
      cache: true,
      run: sh`pnpm run test`
    }),

    build: task({
      dependsOn: ["test"],
      inputs: ["source"],
      outputs: ["dist/**"],
      cache: true,
      run: sh`pnpm run build`
    }),

    pack: task({
      dependsOn: ["build"],
      inputs: ["source"],
      cache: false,
      run: sh`npm pack --dry-run --ignore-scripts`
    })
  },

  jobs: {
    verify: job({
      target: "pack",
      trigger: ["pr", "main", "manual"]
    })
  }
});

