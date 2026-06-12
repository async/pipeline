import { definePipeline, job, sh, source, task, trigger } from "@async/pipeline";

export default definePipeline({
  name: "design-system",
  cache: "file:local",

  triggers: {
    pr: trigger.github({ events: ["pull_request"] }),
    main: trigger.github({ events: ["push"], branches: ["main"] }),
    manual: trigger.manual()
  },

  sync: {
    github: true
  },

  // The dependency map is explicit and reviewable. Nothing here is inferred
  // from lockfiles, npm metadata, or GitHub search.
  //
  // This example commits its dependent repos under repos/ so it runs
  // anywhere, including offline. Real impact runs usually point at git:
  //
  //   storefront: source.git({
  //     url: "https://github.com/acme/storefront.git",
  //     ref: "9a1b2c3d...",   // pin a SHA for reproducible runs
  //     pipeline: "pipeline.mjs",
  //     prepare: [
  //       sh`pnpm install --frozen-lockfile`,
  //       sh((ctx) => sh`pnpm add @acme/design-system@file:${ctx.candidate.dir}`)
  //     ]
  //   })
  sources: {
    storefront: source.path({
      path: "repos/storefront",
      pipeline: "pipeline.mjs",
      writable: true,
      prepare: [
        sh((ctx) => sh`node tools/use-candidate.mjs ${ctx.candidate.dir}`)
      ]
    }),

    admin: source.path({
      path: "repos/admin",
      pipeline: "pipeline.ts",
      writable: true,
      prepare: [
        sh((ctx) => sh`node tools/use-candidate.mjs ${ctx.candidate.dir}`)
      ]
    })
  },

  namedInputs: {
    library: ["src/**/*.js", "package.json"]
  },

  tasks: {
    test: task({
      description: "The design system's own unit tests.",
      inputs: ["library"],
      cache: "file:local",
      run: sh`npm test`
    }),

    impact: task({
      description: "Aggregate: the candidate change must pass every declared dependent repo.",
      dependsOn: ["test", "storefront:test", "admin:test-design-system"]
    })
  },

  jobs: {
    verifyImpact: job({
      target: "impact",
      trigger: ["pr", "main", "manual"]
    })
  }
});
