#!/usr/bin/env node
// Stands in for an expensive aggregation. The pipeline declares
// build/report.json as a task output, so a file-cache hit restores the file
// instead of re-running this script.
import { mkdir, readFile, writeFile } from "node:fs/promises";

const orders = JSON.parse(await readFile(new URL("../data/orders.json", import.meta.url), "utf8"));
const byRegion = {};
for (const order of orders) {
  byRegion[order.region] = (byRegion[order.region] ?? 0) + order.amountCents;
}

await mkdir(new URL("../build/", import.meta.url), { recursive: true });
await writeFile(
  new URL("../build/report.json", import.meta.url),
  `${JSON.stringify({ totalOrders: orders.length, centsByRegion: byRegion, builtAt: new Date().toISOString() }, null, 2)}\n`,
  "utf8"
);
console.log(`Aggregated ${orders.length} orders.`);
