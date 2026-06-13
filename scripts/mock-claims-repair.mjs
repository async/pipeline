#!/usr/bin/env node
// Deterministic stand-in for the claims-repair agent profile (ASYNC_AGENT=mock).
// Mechanically finds stale anchors in tests/claims.json and proposes the
// reworded text from the source doc as a unified diff on stdout. It only
// attempts clearly-bounded rewordings; anything needing judgment is skipped
// with a REVIEW note on stderr. The real profile (claude) owns the judgment
// calls — this script exists so the plumbing is testable without a model.
import { readFileSync } from "node:fs";

const REGISTRY = "tests/claims.json";
const registryText = readFileSync(REGISTRY, "utf8");
const registryLines = registryText.split("\n");
const registry = JSON.parse(registryText);

const sources = new Map();
function sourceText(path) {
  if (!sources.has(path)) {
    try {
      sources.set(path, readFileSync(path, "utf8"));
    } catch {
      sources.set(path, null);
    }
  }
  return sources.get(path);
}

function tokens(text) {
  return text.toLowerCase().replaceAll(/[^a-z0-9` ]/g, " ").split(/\s+/).filter((token) => token.length > 0);
}

/**
 * Slice the candidate line between the anchor's surviving first/last tokens,
 * taking the NEAREST occurrence of the last token so the proposal stays as
 * narrow as the original anchor (a wide anchor breaks on unrelated edits).
 */
function boundedRewording(anchor, line) {
  const anchorTokens = tokens(anchor);
  if (anchorTokens.length < 4) return null;
  const first = anchor.split(/\s+/)[0];
  const last = anchor.split(/\s+/).at(-1);
  const start = line.indexOf(first);
  if (start < 0) return null;
  const end = line.indexOf(last, start + first.length);
  if (end < 0) return null;
  return line.slice(start, end + last.length);
}

const hunks = [];
for (const claim of registry.claims ?? []) {
  if (!claim.anchor || !claim.source) continue;
  const text = sourceText(claim.source);
  if (text === null) continue;
  if (text.includes(claim.anchor)) continue;

  const anchorTokens = new Set(tokens(claim.anchor));
  let best = null;
  let bestScore = 0;
  for (const line of text.split("\n")) {
    const lineTokens = new Set(tokens(line));
    let shared = 0;
    for (const token of anchorTokens) if (lineTokens.has(token)) shared += 1;
    const score = shared / anchorTokens.size;
    if (score > bestScore) {
      bestScore = score;
      best = line;
    }
  }
  if (!best || bestScore < 0.6) {
    process.stderr.write(`REVIEW ${claim.id}: anchor missing from ${claim.source} and no close rewording found.\n`);
    continue;
  }
  const replacement = boundedRewording(claim.anchor, best);
  if (!replacement || replacement === claim.anchor) {
    process.stderr.write(`REVIEW ${claim.id}: rewording in ${claim.source} needs judgment (candidate: ${best.trim()}).\n`);
    continue;
  }

  const escapedOld = JSON.stringify(claim.anchor);
  const lineIndex = registryLines.findIndex((line) => line.includes(escapedOld));
  if (lineIndex < 0) {
    process.stderr.write(`REVIEW ${claim.id}: anchor line not found in ${REGISTRY}.\n`);
    continue;
  }
  const oldLine = registryLines[lineIndex];
  const newLine = oldLine.replace(escapedOld, JSON.stringify(replacement));
  hunks.push({ line: lineIndex + 1, oldLine, newLine });
}

if (hunks.length === 0) {
  process.stderr.write("No mechanically-repairable stale anchors found; emitting empty patch.\n");
  process.exit(0);
}

hunks.sort((left, right) => left.line - right.line);
// One line of context per hunk so the patch applies with plain `git apply`
// (zero-context hunks would require --unidiff-zero).
const contentLines = registryLines.at(-1) === "" ? registryLines.slice(0, -1) : registryLines;
let patch = `--- a/${REGISTRY}\n+++ b/${REGISTRY}\n`;
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
