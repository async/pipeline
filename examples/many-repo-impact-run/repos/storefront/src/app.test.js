import assert from "node:assert/strict";
import { test } from "node:test";
import { renderProductTile } from "./app.js";

test("product tile renders price and sale badge from the candidate design system", async () => {
  const tile = await renderProductTile({ name: "Desk lamp", priceCents: 4250, onSale: true });
  assert.equal(tile, "Desk lamp — $42.50 [Sale]");
});

test("product tile skips the badge when not on sale", async () => {
  const tile = await renderProductTile({ name: "Desk lamp", priceCents: 4250, onSale: false });
  assert.equal(tile, "Desk lamp — $42.50");
});
