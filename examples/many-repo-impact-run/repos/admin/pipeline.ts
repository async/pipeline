import { definePipeline, job, sh, task } from "@async/pipeline";

// Source pipelines can be TypeScript too; the loader strips types natively on
// Node >= 24. This repo names its task "test-design-system" to show that
// namespaced refs use the source's own task ids.
export default definePipeline({
  name: "admin",
  cache: "file:local",
  tasks: {
    "test-design-system": task({
      inputs: ["src/**/*.js", "package.json", "candidate.json"],
      cache: "file:local",
      run: sh`node --test src/refunds.test.js`
    })
  },
  jobs: {
    verify: job({ target: "test-design-system" })
  }
});
