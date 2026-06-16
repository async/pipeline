#!/usr/bin/env node
// Mechanical release-drift checks. Fails when metadata that must move together drifts apart:
// 1. The workspace version must match the published package version.
// 2. The published package version must have a CHANGELOG.md entry.
// 3. The engines.node floor must be identical across all package.json files.
// 4. Generated GitHub workflows must install Node at or above the engines floor.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const failures = [];

function fail(message) {
  failures.push(message);
}

async function readJson(path) {
  return JSON.parse(await readFile(join(root, path), "utf8"));
}

// 1. Workspace version <-> published package version.
const workspace = await readJson("package.json");
const published = await readJson("packages/pipeline/package.json");
if (workspace.version !== published.version) {
  fail(`package.json is version ${workspace.version} but packages/pipeline/package.json is version ${published.version}.`);
}

// 2. Version <-> CHANGELOG.
const changelog = await readFile(join(root, "CHANGELOG.md"), "utf8");
const changelogHeadings = [...changelog.matchAll(/^##[ \t]+(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)[ \t]+-[ \t]+(.+?)[ \t]*$/gm)];
const changelogIndex = changelogHeadings.findIndex((heading) => heading[1] === published.version);
if (changelogIndex < 0) {
  fail(`packages/pipeline is version ${published.version} but CHANGELOG.md has no parseable "## ${published.version} - <date>" entry.`);
} else {
  const heading = changelogHeadings[changelogIndex];
  const start = heading.index + heading[0].length;
  const end = changelogIndex + 1 < changelogHeadings.length ? changelogHeadings[changelogIndex + 1].index : changelog.length;
  if (changelog.slice(start, end).trim().length === 0) {
    fail(`CHANGELOG.md entry "## ${published.version} - ${heading[2].trim()}" is empty.`);
  }
}

// 3. Engines floor consistency.
const packagePaths = ["package.json"];
for (const entry of await readdir(join(root, "packages"), { withFileTypes: true })) {
  if (entry.isDirectory()) packagePaths.push(join("packages", entry.name, "package.json"));
}
const engines = new Map();
for (const path of packagePaths) {
  const manifest = await readJson(path).catch(() => null);
  const node = manifest?.engines?.node;
  if (node) engines.set(path, node);
}
const distinct = [...new Set(engines.values())];
if (distinct.length > 1) {
  fail(`engines.node differs across packages: ${[...engines.entries()].map(([path, node]) => `${path}=${node}`).join(", ")}.`);
}
const floorMatch = /^>=\s*(\d+)/.exec(distinct[0] ?? "");
if (!floorMatch) {
  fail(`Cannot parse engines.node floor from "${distinct[0]}". Use the form ">=24".`);
}
const floor = floorMatch ? Number(floorMatch[1]) : Number.NaN;

// 4. Workflow Node versions respect the floor.
async function collectWorkflows(dir) {
  const found = [];
  let entries;
  try {
    entries = await readdir(join(root, dir), { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", ".git", ".async", "dist"].includes(entry.name)) continue;
      found.push(...await collectWorkflows(path));
    } else if (/\.ya?ml$/.test(entry.name) && dir.includes(join(".github", "workflows"))) {
      found.push(path);
    }
  }
  return found;
}

const workflows = [...await collectWorkflows(".github"), ...await collectWorkflows("examples")];
for (const workflow of workflows) {
  const text = await readFile(join(root, workflow), "utf8");
  for (const match of text.matchAll(/node-version:\s*["']?(\d+)/g)) {
    const version = Number(match[1]);
    if (Number.isFinite(floor) && version < floor) {
      fail(`${workflow} installs Node ${version}, below the engines floor >=${floor}.`);
    }
  }
}

if (failures.length > 0) {
  for (const message of failures) console.error(`DRIFT ${message}`);
  process.exit(1);
}
console.log(`Drift checks passed: CHANGELOG has ${published.version}, engines floor >=${floor}, ${workflows.length} workflow(s) at or above the floor.`);
