import { definePipeline, job, sh, task, trigger } from "@async/pipeline";

export default definePipeline({
  name: "monorepo-package-selection",
  cache: "file:local",

  triggers: {
    pr: trigger.github({ events: ["pull_request"] }),
    main: trigger.github({ events: ["push"], branches: ["main"] }),
    manual: trigger.manual()
  },

  // Task sync writes scripts into *selected* workspace packages, matched by
  // package.json#name. internal-tools is deliberately not selected: it is
  // tested by the pipeline but receives no generated scripts.
  sync: {
    github: true,
    tasks: {
      prefix: "pipeline",
      runners: ["package"],
      targets: [
        { package: "@async-framework/example-monorepo-app" },
        { package: "@async-framework/example-monorepo-api" }
      ],
      jobs: ["verify"],
      scripts: {
        "sync:check": "sync check"
      }
    }
  },

  namedInputs: {
    app: ["packages/app/src/**/*.js", "packages/app/package.json"],
    api: ["packages/api/src/**/*.js", "packages/api/package.json"],
    tools: ["packages/internal-tools/src/**/*.js", "packages/internal-tools/package.json"]
  },

  tasks: {
    "test-app": task({
      description: "Unit tests for the user-facing app package.",
      inputs: ["app"],
      cache: "file:local",
      run: sh`node --test packages/app/src`
    }),

    "test-api": task({
      description: "Unit tests for the API package.",
      inputs: ["api"],
      cache: "file:local",
      run: sh`node --test packages/api/src`
    }),

    "test-internal-tools": task({
      description: "Unit tests for the internal tooling package.",
      inputs: ["tools"],
      cache: "file:local",
      run: sh`node --test packages/internal-tools/src`
    })
  },

  jobs: {
    verify: job({
      // A job target can be a list: all three packages are verified even
      // though only two of them receive synced scripts.
      target: ["test-app", "test-api", "test-internal-tools"],
      trigger: ["pr", "main", "manual"]
    })
  }
});
