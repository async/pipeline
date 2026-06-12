#!/usr/bin/env node
// Candidate wiring for impact runs; see repos/storefront/tools/use-candidate.mjs.
import { writeFile } from "node:fs/promises";

const candidateDir = process.argv[2];
if (!candidateDir) {
  console.error("Usage: node tools/use-candidate.mjs <candidate-dir>");
  process.exit(1);
}
await writeFile(new URL("../candidate.json", import.meta.url), `${JSON.stringify({ dir: candidateDir }, null, 2)}\n`, "utf8");
console.log(`Linked design-system candidate: ${candidateDir}`);
