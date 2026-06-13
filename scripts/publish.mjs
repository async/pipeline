#!/usr/bin/env node
// Idempotent npm publish for @async/pipeline. Re-dispatching the publish job
// for an already-published version skips cleanly instead of failing.
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "packages", "pipeline");
const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
const spec = `${manifest.name}@${manifest.version}`;

const view = spawnSync("npm", ["view", spec, "version", "--registry", "https://registry.npmjs.org/"], { encoding: "utf8" });
if (view.status === 0 && view.stdout.trim() === manifest.version) {
  console.log(`${spec} is already published; skipping.`);
  process.exit(0);
}

console.log(`Publishing ${spec}...`);
const publish = spawnSync("npm", [
  "publish",
  "--access", "public",
  "--registry", "https://registry.npmjs.org/"
], { cwd: packageDir, stdio: "inherit" });
process.exit(publish.status ?? 1);
