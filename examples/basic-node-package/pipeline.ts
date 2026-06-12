import { definePipeline, job, sh, task, trigger } from "@async/pipeline";

export default definePipeline({
  name: "basic-node-package",
  cache: "file:local",

  triggers: {
    pr: trigger.github({ events: ["pull_request"] }),
    main: trigger.github({ events: ["push"], branches: ["main"] }),
    nightly: trigger.cron("17 2 * * *"),
    manual: trigger.manual()
  },

  // The two opt-in sync surfaces, both in their simplest form:
  // - github: true   generates .github/workflows/async-pipeline.yml + lock
  // - tasks: true    syncs every job into package.json scripts as pipeline:<job>
  sync: {
    github: true,
    tasks: true
  },

  namedInputs: {
    source: ["src/**/*.ts", "package.json", "tsconfig.json"]
  },

  tasks: {
    typecheck: task({
      inputs: ["source"],
      cache: "file:local",
      run: sh`npm run typecheck`
    }),

    test: task({
      dependsOn: ["typecheck"],
      inputs: ["source"],
      cache: "file:local",
      run: sh`npm test`
    }),

    build: task({
      dependsOn: ["test"],
      inputs: ["source"],
      outputs: ["dist/**"],
      cache: "file:local",
      run: sh`npm run build`
    }),

    pack: task({
      description: "Prove the package tarball stays publishable.",
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
    }),

    nightly: job({
      target: "build",
      trigger: ["nightly"]
    })
  }
});
