import assert from "node:assert/strict";
import { test } from "node:test";
import { definePipeline, job, sh, task, tasksForJob } from "../packages/pipeline-core/dist/index.js";

test("resolves a 500-task graph within the performance budget", () => {
  // Guards against accidental quadratic blowups in normalization, validation,
  // or graph resolution. The budget is deliberately generous for slow CI.
  const started = process.hrtime.bigint();

  const tasks = {};
  for (let index = 0; index < 500; index += 1) {
    tasks[`t${index}`] = task({
      cache: false,
      dependsOn: index === 0 ? [] : [`t${index - 1}`],
      run: sh`true`
    });
  }
  const pipeline = definePipeline({
    name: "perf",
    tasks,
    jobs: { verify: job({ target: "t499" }) }
  });
  const graph = tasksForJob(pipeline, "verify");

  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(graph.executionOrder.length, 500);
  assert.ok(elapsedMs < 2000, `graph resolution took ${Math.round(elapsedMs)}ms; budget is 2000ms`);
});
