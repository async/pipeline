import assert from "node:assert/strict";
import { test } from "node:test";
import { renderBanner } from "./index.js";

test("renderBanner greets the user", () => {
  assert.equal(renderBanner({ name: "Ada" }), "Welcome back, Ada.");
});

test("renderBanner rejects missing names", () => {
  assert.throws(() => renderBanner({}), /requires \{ name: string \}/);
});
