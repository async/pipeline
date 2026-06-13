#!/usr/bin/env node
// Deterministic stand-in for the repair agent (the `mock` profile). Reads the
// same prompt a real model would (stdin), does the mechanical part — find
// stale anchors, match the reworded docs sentence, emit a unified diff on
// stdout — and defers anything needing judgment with a REVIEW note on stderr.
import { readFileSync } from "node:fs";

const prompt = readFileSync(0, "utf8");
const registryPath = prompt.match(/^Registry file: (.+)$/m)?.[1] ?? "anchors-stale.txt";
const docsPath = prompt.match(/^Docs file: (.+)$/m)?.[1] ?? "docs/README.md";

const registryLines = readFileSync(registryPath, "utf8").split("\n");
const docs = readFileSync(docsPath, "utf8");
const docLines = docs.split("\n");

function tokens(text) {
  return text.toLowerCase().replaceAll(/[^a-z0-9` ]/g, " ").split(/\s+/).filter(Boolean);
}

/**
 * Slice the candidate docs line between the anchor's surviving first and last
 * words, taking the NEAREST occurrence of the last word so the proposal stays
 * as narrow as the original anchor.
 */
function boundedRewording(anchor, line) {
  const first = anchor.split(/\s+/)[0];
  const last = anchor.split(/\s+/).at(-1);
  const start = line.indexOf(first);
  if (start < 0) return null;
  const end = line.indexOf(last, start + first.length);
  if (end < 0) return null;
  return line.slice(start, end + last.length);
}

const hunks = [];
registryLines.forEach((line, index) => {
  if (!line.trim()) return;
  const [id, anchor] = line.split("\t");
  if (!id || !anchor || docs.includes(anchor)) return;

  const anchorTokens = new Set(tokens(anchor));
  let best = null;
  let bestScore = 0;
  for (const docLine of docLines) {
    const docTokens = new Set(tokens(docLine));
    let shared = 0;
    for (const token of anchorTokens) if (docTokens.has(token)) shared += 1;
    const score = shared / anchorTokens.size;
    if (score > bestScore) {
      bestScore = score;
      best = docLine;
    }
  }
  if (!best || bestScore < 0.6) {
    process.stderr.write(`REVIEW ${id}: no close rewording found in ${docsPath}.\n`);
    return;
  }
  const replacement = boundedRewording(anchor, best);
  if (!replacement || replacement === anchor) {
    process.stderr.write(`REVIEW ${id}: rewording needs judgment (candidate: ${best.trim()}).\n`);
    return;
  }
  hunks.push({ line: index + 1, oldLine: line, newLine: `${id}\t${replacement}` });
});

if (hunks.length === 0) {
  process.stderr.write("No stale anchors found; emitting empty patch.\n");
  process.exit(0);
}

// Hunks carry one line of context so the patch applies with plain
// `git apply` (zero-context hunks would require --unidiff-zero).
const contentLines = registryLines.at(-1) === "" ? registryLines.slice(0, -1) : registryLines;
let patch = `--- a/${registryPath}\n+++ b/${registryPath}\n`;
for (const hunk of hunks) {
  const index = hunk.line - 1;
  const before = index > 0 ? contentLines[index - 1] : null;
  const after = index < contentLines.length - 1 ? contentLines[index + 1] : null;
  const start = before === null ? hunk.line : hunk.line - 1;
  const count = 1 + (before === null ? 0 : 1) + (after === null ? 0 : 1);
  patch += `@@ -${start},${count} +${start},${count} @@\n`;
  if (before !== null) patch += ` ${before}\n`;
  patch += `-${hunk.oldLine}\n+${hunk.newLine}\n`;
  if (after !== null) patch += ` ${after}\n`;
}
process.stdout.write(patch);
