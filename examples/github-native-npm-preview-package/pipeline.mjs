import { definePipeline, job, sh, task, trigger } from "@async/pipeline";

export default definePipeline({
  name: "github-native-npm-preview-package",

  triggers: {
    pr: trigger.github({ events: ["pull_request"] }),
    main: trigger.github({ events: ["push"], branches: ["main"] }),
    release: trigger.github({ events: ["release"] }),
    manual: trigger.manual()
  },

  sync: {
    github: true,
    tasks: {
      prefix: "pipeline",
      runners: ["package"],
      targets: "root",
      jobs: "all",
      scripts: {
        "sync:check": "sync check"
      }
    }
  },

  tasks: {
    validatePackage: task({
      inputs: ["package.json"],
      run: sh`node scripts/validate-package-metadata.mjs`
    }),

    verifyPackage: task({
      dependsOn: ["validatePackage"],
      inputs: ["package.json", "src/**/*.js", "scripts/**/*.mjs"],
      run: sh`npm test --if-present && npm run build --if-present && npm pack --dry-run --ignore-scripts`
    }),

    prPreviewPlan: task({
      dependsOn: ["verifyPackage"],
      run: sh`node scripts/print-publish-plan.mjs pr`
    }),

    mainSnapshotPlan: task({
      dependsOn: ["verifyPackage"],
      run: sh`node scripts/print-publish-plan.mjs main`
    }),

    stableReleasePlan: task({
      dependsOn: ["verifyPackage"],
      run: sh`node scripts/print-publish-plan.mjs release`
    })
  },

  jobs: {
    prPreview: job({
      target: "prPreviewPlan",
      trigger: ["pr", "manual"]
    }),

    mainSnapshot: job({
      target: "mainSnapshotPlan",
      trigger: ["main", "manual"]
    }),

    stableRelease: job({
      target: "stableReleasePlan",
      trigger: ["release", "manual"]
    })
  }
});
