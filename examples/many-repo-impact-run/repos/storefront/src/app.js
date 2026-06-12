// The storefront consumes the design system. During an impact run the
// candidate checkout is linked by tools/use-candidate.mjs (see prepare in the
// root pipeline.ts); a real storefront would import its installed
// @acme/design-system dependency instead.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export async function loadDesignSystem() {
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

export async function renderProductTile(product) {
  const ds = await loadDesignSystem();
  const flag = product.onSale ? ` ${ds.badge("sale")}` : "";
  return `${product.name} — ${ds.formatPrice(product.priceCents)}${flag}`;
}
