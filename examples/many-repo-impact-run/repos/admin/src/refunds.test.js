import assert from "node:assert/strict";
import { test } from "node:test";
import { refundLine } from "./refunds.js";

test("refund line formats the refunded amount with the candidate design system", async () => {
  assert.equal(
    await refundLine({ orderId: "A-1042", amountCents: 1250, currency: "USD" }),
    "A-1042: refunded $12.50"
  );
});
