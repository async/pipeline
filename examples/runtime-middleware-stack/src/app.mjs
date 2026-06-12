#!/usr/bin/env node
// The "app" side: run the checkout workflow in-process, like a request
// handler would.
import { createRuntime } from "@async/pipeline/runtime";
import { checkoutWork } from "./flows.mjs";

const runtime = createRuntime(checkoutWork);

for (const request of [
  { sku: "desk-lamp", quantity: 2 },
  { sku: "monitor-arm", quantity: 1 }
]) {
  const result = await runtime.run(request);
  console.log(`checkout ${request.sku} x${request.quantity}`);
  console.log(`  status: ${result.status}`);
  console.log(`  output: ${JSON.stringify(result.output)}`);
}

// The same definition is inspectable without executing anything.
const [checkoutTask] = runtime.inspect().tasks;
console.log(`inspect: task "${checkoutTask.id}" flow kinds: ${checkoutTask.flow.children.map((node) => node.kind).join(", ")}`);
