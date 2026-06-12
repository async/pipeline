import assert from "node:assert/strict";
import { test } from "node:test";
import { badge, formatPrice } from "./index.js";

test("formatPrice renders dollars from cents", () => {
  assert.equal(formatPrice(1999), "$19.99");
});

test("formatPrice rejects fractional cents", () => {
  assert.throws(() => formatPrice(19.99), /non-negative integer cents/);
});

test("badge renders known kinds", () => {
  assert.equal(badge("sale"), "[Sale]");
});
