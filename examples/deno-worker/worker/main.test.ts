// Runs under `node --test` (native type stripping) and `deno test` alike:
// the routing logic is pure, so the verify job needs no Deno binary.
import assert from "node:assert/strict";
import { test } from "node:test";
import { route } from "./main.ts";

const fixed = new Date("2026-01-01T00:00:00.000Z");

test("route serves /health with the start timestamp", () => {
  const result = route("/health", fixed);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { status: "ok", startedAt: "2026-01-01T00:00:00.000Z" });
});

test("route serves /version", () => {
  assert.equal(route("/version", fixed).status, 200);
});

test("route 404s unknown paths", () => {
  assert.equal(route("/nope", fixed).status, 404);
});
