#!/usr/bin/env node
// Validates worker/deno.json without needing the Deno binary: the manifest
// must parse, export the worker entrypoint, and keep the dev task pointing at
// a file that exists.
import { readFile, access } from "node:fs/promises";

const manifest = JSON.parse(await readFile(new URL("../worker/deno.json", import.meta.url), "utf8"));
const failures = [];

if (manifest.exports !== "./main.ts") {
  failures.push(`worker/deno.json exports must be "./main.ts", found ${JSON.stringify(manifest.exports)}.`);
}
if (typeof manifest.tasks?.dev !== "string" || !manifest.tasks.dev.includes("main.ts")) {
  failures.push("worker/deno.json tasks.dev must serve main.ts.");
}
await access(new URL("../worker/main.ts", import.meta.url)).catch(() => {
  failures.push("worker/main.ts is missing.");
});

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exit(1);
}
console.log("worker/deno.json is valid.");
