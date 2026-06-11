#!/usr/bin/env node
// Packaging-drift checks for the published package. Fails when the manifest
// promises files that do not exist after a build:
// 1. Every exports subpath's types and default targets exist on disk.
// 2. Every bin target exists.
// 3. license, files ("dist"), and the LICENSE file are present.
// Run after `pnpm build`; wired into release:check and the self pipeline.
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const packageDir = join(root, "packages", "pipeline");
const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
const failures = [];

async function expectFile(label, relativePath) {
  if (typeof relativePath !== "string" || relativePath === "") {
    failures.push(`${label}: missing path.`);
    return;
  }
  try {
    await access(join(packageDir, relativePath));
  } catch {
    failures.push(`${label}: ${relativePath} does not exist. Build first, or fix the manifest.`);
  }
}

const exportEntries = Object.entries(manifest.exports ?? {});
if (exportEntries.length === 0) failures.push("package.json has no exports map.");
for (const [subpath, target] of exportEntries) {
  if (typeof target === "string") {
    await expectFile(`exports["${subpath}"]`, target);
    continue;
  }
  await expectFile(`exports["${subpath}"].types`, target?.types);
  await expectFile(`exports["${subpath}"].default`, target?.default);
}
for (const [name, target] of Object.entries(manifest.bin ?? {})) {
  await expectFile(`bin.${name}`, target);
}
if (!manifest.license) failures.push("package.json has no license field.");
if (!(manifest.files ?? []).includes("dist")) failures.push('package.json files must include "dist".');
await expectFile("LICENSE", "LICENSE");

if (failures.length > 0) {
  for (const message of failures) console.error(`EXPORTS ${message}`);
  process.exit(1);
}
console.log(`Exports checks passed: ${exportEntries.length} subpath(s), bin, license, and files are consistent with dist.`);
