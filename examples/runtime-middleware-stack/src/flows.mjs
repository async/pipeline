// In-process workflows built from @async/pipeline/runtime primitives.
//
// compose(...)  = middleware around a flow: (ctx, next) functions
// [a, b, c]     = sequential group
// parallel([])  = explicit fan-out (never inferred)
// branch(p,a,b) = exactly one side runs
// task({...})   = the boundary that gets an id, dependsOn, cache, inspection
import { branch, cache, compose, defineRuntime, parallel, task } from "@async/pipeline/runtime";

const CATALOG = {
  "desk-lamp": { priceCents: 4250, inStock: 7 },
  "monitor-arm": { priceCents: 12900, inStock: 0 }
};

// App workflow: an HTTP-ish checkout request flows through timing middleware,
// sequential validation, parallel enrichment, and a branch on the result.
export const checkoutWork = defineRuntime([
  task({ id: "handleCheckout", description: "Validate, enrich in parallel, then accept or reject." }, compose(
    // Middleware: wraps everything after it, like a server request logger.
    // next() returns the inner flow's result, so middleware can decorate it.
    async (_ctx, next) => {
      const startedAt = process.hrtime.bigint();
      const result = await next();
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      return { ...result, elapsedMs: Math.round(elapsedMs * 1000) / 1000 };
    },

    // Sequential group: each step validates and passes control on.
    [
      async (ctx, next) => {
        if (!ctx.input?.sku) throw new Error("Checkout requires a sku.");
        return next();
      },
      async (ctx, next) => {
        if (!Number.isInteger(ctx.input.quantity) || ctx.input.quantity < 1) {
          throw new Error("Checkout requires a positive integer quantity.");
        }
        return next();
      }
    ],

    // Explicit fan-out: price lookup and stock check are independent.
    parallel([
      async (ctx) => {
        const item = CATALOG[ctx.input.sku];
        if (!item) throw new Error(`Unknown sku "${ctx.input.sku}".`);
        return { totalCents: item.priceCents * ctx.input.quantity };
      },
      async (ctx) => {
        const item = CATALOG[ctx.input.sku];
        return { available: Boolean(item) && item.inStock >= ctx.input.quantity };
      }
    ]),

    // Branch on the gathered results: after a parallel group, ctx.output is
    // the array of its results, in declaration order.
    branch(
      (ctx) => ctx.output[1].available,
      async (ctx) => ({
        accepted: true,
        sku: ctx.input.sku,
        quantity: ctx.input.quantity,
        totalCents: ctx.output[0].totalCents
      }),
      async (ctx) => ({ accepted: false, reason: `"${ctx.input.sku}" is out of stock.` })
    )
  ))
]);

// Background workflow: drain a batch of webhook deliveries with bounded
// concurrency. The memory cache directive makes redelivering an identical
// batch a no-op within the same runtime instance, and `dependsOn` gives
// partial runs (run only "report") their prerequisite order.
export const webhookWork = defineRuntime([
  task({ id: "drainDeliveries" }, [
    cache.use("memory:session"),
    async (ctx) => {
      const send = async (delivery) => ({ id: delivery.id, delivered: delivery.endpoint.startsWith("https://") });
      const results = await runWithConcurrency(ctx.input.deliveries, 2, send);
      return {
        delivered: results.filter((entry) => entry.delivered).map((entry) => entry.id),
        rejected: results.filter((entry) => !entry.delivered).map((entry) => entry.id)
      };
    }
  ]),

  task({ id: "report", dependsOn: ["drainDeliveries"] }, async (ctx) => {
    return `processed ${ctx.input.deliveries.length} deliveries`;
  })
]);

async function runWithConcurrency(items, limit, work) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await work(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}
