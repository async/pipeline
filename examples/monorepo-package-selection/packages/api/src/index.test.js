import assert from "node:assert/strict";
import { test } from "node:test";
import { healthResponse } from "./index.js";

test("healthResponse reports ok with a timestamp", () => {
  const fixed = new Date("2026-01-01T00:00:00.000Z");
  assert.deepEqual(healthResponse(() => fixed), {
    status: "ok",
    checkedAt: "2026-01-01T00:00:00.000Z"
  });
});
