#!/usr/bin/env node
// The "background" side: one long-lived runtime instance drains delivery
// batches. Identical batches hit the memory:session cache instead of
// re-sending.
import { createRuntime } from "@async/pipeline/runtime";
import { webhookWork } from "./flows.mjs";

const runtime = createRuntime(webhookWork);
await runtime.start();

const batch = {
  deliveries: [
    { id: "d-1", endpoint: "https://hooks.example.com/a" },
    { id: "d-2", endpoint: "http://insecure.example.com/b" },
    { id: "d-3", endpoint: "https://hooks.example.com/c" }
  ]
};

const first = await runtime.run(batch);
console.log(`first drain:  ${JSON.stringify(first.tasks.map((task) => `${task.id}:${task.status}`))}`);

const second = await runtime.run(batch);
console.log(`second drain: ${JSON.stringify(second.tasks.map((task) => `${task.id}:${task.status}`))}`);

const partial = await runtime.run(batch, { task: "report" });
console.log(`partial run of "report" still ordered after its dependency: ${JSON.stringify(partial.tasks.map((task) => task.id))}`);
console.log(`report output: ${JSON.stringify(partial.output)}`);

await runtime.stop();
