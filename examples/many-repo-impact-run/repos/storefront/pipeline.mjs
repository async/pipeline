import { definePipeline, job, sh, task } from "@async/pipeline";

// The dependent repo's own pipeline. The design-system pipeline composes it
// through sources, then depends on "storefront:test".
export default definePipeline({
  name: "storefront",
  cache: "file:local",
  tasks: {
    test: task({
      inputs: ["src/**/*.js", "package.json", "candidate.json"],
      cache: "file:local",
      run: sh`node --test src/app.test.js`
    })
  },
  jobs: {
    verify: job({ target: "test" })
  }
});
