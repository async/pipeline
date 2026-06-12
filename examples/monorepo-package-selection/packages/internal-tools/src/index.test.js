import assert from "node:assert/strict";
import { test } from "node:test";
import { slugify } from "./index.js";

test("slugify lowercases and dashes", () => {
  assert.equal(slugify("Release Notes: v1.2"), "release-notes-v1-2");
});
