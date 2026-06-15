import assert from "node:assert/strict";
import { test } from "node:test";
import { previewChannel } from "./index.js";

test("previewChannel detects PR preview versions", () => {
  assert.equal(previewChannel("0.0.0-pr.12.sha.abc"), "preview");
  assert.equal(previewChannel("0.1.0"), "stable");
});

