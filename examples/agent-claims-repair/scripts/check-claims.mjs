#!/usr/bin/env node
// Mini claims checker: every `<id>\t<anchor>` line in the registry must
// appear verbatim in docs/README.md. The deterministic authority — the
// repair agent proposes, this script disposes.
import { readFileSync } from "node:fs";

const registryPath = process.argv[2] ?? "anchors.txt";
const docs = readFileSync("docs/README.md", "utf8");
const failures = [];

for (const line of readFileSync(registryPath, "utf8").split("\n")) {
  if (!line.trim()) continue;
  const [id, anchor] = line.split("\t");
  if (!id || !anchor) {
    failures.push(`malformed registry line: ${line}`);
    continue;
  }
  if (!docs.includes(anchor)) {
    failures.push(`${id}: anchor no longer appears in docs/README.md\n  anchor: ${anchor}`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`CLAIMS ${failure}`);
  process.exit(1);
}
console.log(`Claims checks passed: ${registryPath} anchors all appear in docs/README.md.`);
