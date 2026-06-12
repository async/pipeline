import assert from "node:assert/strict";
import { test } from "node:test";
import { createRuntime } from "@async/pipeline/runtime";
import { checkoutWork, webhookWork } from "./flows.mjs";

test("checkout accepts an in-stock order and middleware decorates the result", async () => {
  const runtime = createRuntime(checkoutWork);
  const result = await runtime.run({ sku: "desk-lamp", quantity: 2 });

  assert.equal(result.status, "passed");
  assert.equal(result.output.accepted, true);
  assert.equal(result.output.totalCents, 8500);
  assert.equal(typeof result.output.elapsedMs, "number");
});

test("checkout rejects an out-of-stock order through the branch", async () => {
  const runtime = createRuntime(checkoutWork);
  const result = await runtime.run({ sku: "monitor-arm", quantity: 1 });

  assert.equal(result.status, "passed");
  assert.equal(result.output.accepted, false);
  assert.match(result.output.reason, /out of stock/);
});

test("checkout fails structurally when validation throws", async () => {
  const runtime = createRuntime(checkoutWork);
  const result = await runtime.run({ quantity: 1 });

  assert.equal(result.status, "failed");
  assert.equal(result.tasks[0].errorCode, "ASYNC_PIPELINE_RUNTIME_TASK_FAILED");
});

test("webhook drain caches identical batches within one runtime", async () => {
  const runtime = createRuntime(webhookWork);
  const batch = {
    deliveries: [
      { id: "d-1", endpoint: "https://hooks.example.com/a" },
      { id: "d-2", endpoint: "http://insecure.example.com/b" }
    ]
  };

  const first = await runtime.run(batch);
  assert.equal(first.status, "passed");
  assert.deepEqual(first.tasks.map((task) => task.status), ["passed", "passed"]);

  const second = await runtime.run(batch);
  assert.equal(second.tasks.find((task) => task.id === "drainDeliveries").status, "cached");
});

test("partial run of report executes its dependency first", async () => {
  const runtime = createRuntime(webhookWork);
  const batch = { deliveries: [{ id: "d-9", endpoint: "https://hooks.example.com/z" }] };

  const result = await runtime.run(batch, { task: "report" });

  assert.equal(result.status, "passed");
  assert.deepEqual(result.tasks.map((task) => task.id), ["drainDeliveries", "report"]);
  assert.equal(result.output, "processed 1 deliveries");
});
