import { definePipeline, job, sh, task, trigger } from "@async/pipeline";

export default definePipeline({
  name: "generated-update-train",
  triggers: {
    release: trigger.github({ events: ["release"], types: ["published"] }),
    manual: trigger.manual()
  },
  sync: {
    github: {
      setup: "async",
      updateTrain: {
        package: ".",
        repositories: ["async/flow", "async/framework"],
        event: "async-dep-bump",
        tokenEnv: "ASYNC_RELEASE_TRAIN_TOKEN",
        after: "publish"
      },
      dependencyBump: {
        packages: ["@async/pipeline"],
        verify: ["pnpm async-pipeline sync generate", "pnpm test"],
        success: "push",
        failure: "pull-request"
      }
    },
    tasks: true
  },
  tasks: {
    verify: task({ run: sh`pnpm test` }),
    publish: task({ dependsOn: ["verify"], run: sh`node -e "console.log('publish placeholder')"` })
  },
  jobs: {
    verify: job({ target: "verify" }),
    publish: job({ target: "publish", trigger: ["release", "manual"] })
  }
});
