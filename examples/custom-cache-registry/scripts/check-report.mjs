#!/usr/bin/env node
// Consumes the report produced by build-report.mjs.
import { readFile } from "node:fs/promises";

const report = JSON.parse(await readFile(new URL("../build/report.json", import.meta.url), "utf8"));
if (typeof report.totalOrders !== "number" || report.totalOrders <= 0) {
  console.error("Report has no orders.");
  process.exit(1);
}
for (const [region, cents] of Object.entries(report.centsByRegion)) {
  if (!Number.isInteger(cents) || cents < 0) {
    console.error(`Region ${region} has invalid total ${cents}.`);
    process.exit(1);
  }
}
console.log(`Report OK: ${report.totalOrders} orders across ${Object.keys(report.centsByRegion).length} regions.`);
