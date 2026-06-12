// The "design system" under test. The dependent repos in repos/ consume this
// package, so the impact job proves a candidate change here does not break
// them.

export function formatPrice(cents, currency = "USD") {
  if (!Number.isInteger(cents) || cents < 0) {
    throw new Error(`formatPrice expects non-negative integer cents, got ${cents}.`);
  }
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

export function badge(kind) {
  const kinds = { sale: "Sale", new: "New", soldOut: "Sold out" };
  if (!(kind in kinds)) {
    throw new Error(`Unknown badge kind "${kind}".`);
  }
  return `[${kinds[kind]}]`;
}
