// The admin app consumes the design system's price formatting for its refund
// table. See repos/storefront/src/app.js for how candidate linking works.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

async function loadDesignSystem() {
  let link;
  try {
    link = JSON.parse(readFileSync(new URL("../candidate.json", import.meta.url), "utf8"));
  } catch {
    throw new Error(
      "No design-system candidate linked. Run this repo through the design-system impact pipeline (async-pipeline run verifyImpact)."
    );
  }
  return import(pathToFileURL(join(link.dir, "src/index.js")).href);
}

export async function refundLine(refund) {
  const ds = await loadDesignSystem();
  return `${refund.orderId}: refunded ${ds.formatPrice(refund.amountCents, refund.currency)}`;
}
