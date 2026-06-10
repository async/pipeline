import assert from "node:assert/strict";
import { test } from "node:test";
import { branch, cache, compose, createRuntime, defineRuntime, parallel, task } from "../packages/pipeline/dist/runtime.js";

test("runtime executes run arrays and nested tasks", async () => {
  const order = [];
  const work = defineRuntime([
    task({ id: "parent" }, [
      async (_ctx, next) => {
        order.push("before-parent");
        await next();
        order.push("after-parent");
      }
    ]),
    task({ id: "child" }, async () => {
      order.push("child");
    })
  ]);

  const runtime = createRuntime(work);
  const result = await runtime.run({});

  assert.equal(result.status, "passed");
  assert.deepEqual(order, ["before-parent", "after-parent", "child"]);
  assert.deepEqual(result.tasks.map((entry) => entry.id), ["parent", "child"]);
});

test("runtime memory cache directive skips repeated work", async () => {
  let runs = 0;
  const runtime = createRuntime(defineRuntime([
    task({ id: "cached" }, [
      cache.use("memory:cache-first"),
      async () => {
        runs += 1;
        return runs;
      }
    ])
  ]));

  const first = await runtime.run({ value: 1 });
  const second = await runtime.run({ value: 1 });

  assert.equal(first.output, 1);
  assert.equal(second.output, 1);
  assert.equal(runs, 1);
  assert.equal(second.tasks[0].status, "cached");
});

test("runtime partial execution runs dependencies first", async () => {
  const order = [];
  const runtime = createRuntime(defineRuntime([
    task({ id: "load" }, async () => {
      order.push("load");
    }),
    task({ id: "send", dependsOn: ["load"] }, async () => {
      order.push("send");
    })
  ]));

  const result = await runtime.run({}, { task: "send" });

  assert.equal(result.status, "passed");
  assert.deepEqual(order, ["load", "send"]);
  assert.deepEqual(result.tasks.map((entry) => entry.id), ["load", "send"]);
});

test("runtime nested tasks run once with parent before child", async () => {
  const order = [];
  const runtime = createRuntime(defineRuntime([
    task({ id: "group" }, [
      task({ id: "child" }, async () => {
        order.push("child");
      })
    ])
  ]));

  const result = await runtime.run({});

  assert.equal(result.status, "passed");
  assert.deepEqual(order, ["child"]);
  assert.deepEqual(result.tasks.map((entry) => entry.id), ["group", "child"]);
});

test("runtime rejects config run with second argument", () => {
  assert.throws(() => task({ id: "bad", run: async () => {} }, async () => {}), (error) => error.code === "ASYNC_PIPELINE_TASK_ARGUMENT_CONFLICT");
});

test("runtime compose executes middleware and sequential groups", async () => {
  const order = [];
  const runtime = createRuntime(defineRuntime([
    task({ id: "verify" }, compose(
      async (_ctx, next) => {
        order.push("before");
        const value = await next();
        order.push(`after:${value}`);
        return "done";
      },
      [
        async (_ctx, next) => {
          order.push("group-a");
          return next();
        },
        async (_ctx, next) => {
          order.push("group-b");
          return next();
        }
      ],
      async () => {
        order.push("final");
        return "value";
      }
    ))
  ]));

  const result = await runtime.run({});

  assert.equal(result.status, "passed");
  assert.equal(result.output, "done");
  assert.deepEqual(order, ["before", "group-a", "group-b", "final", "after:value"]);
  assert.equal(runtime.inspect().tasks[0].flow.children[1].kind, "series");
});

test("runtime task accepts array flows with explicit parallel fan-out", async () => {
  const order = [];
  const runtime = createRuntime(defineRuntime([
    task({ id: "verify" }, [
      async (_ctx, next) => {
        order.push("start");
        return next();
      },
      parallel({ concurrency: 2 }, [
        async () => {
          order.push("typecheck");
          return "typecheck";
        },
        async () => {
          order.push("test");
          return "test";
        }
      ]),
      async (ctx) => {
        order.push(`after:${ctx.output.join(",")}`);
        return "done";
      }
    ])
  ]));

  const result = await runtime.run({});

  assert.equal(result.status, "passed");
  assert.equal(result.output, "done");
  assert.deepEqual(order, ["start", "typecheck", "test", "after:typecheck,test"]);
  assert.equal(result.nodes.some((node) => node.kind === "parallel" && node.status === "passed"), true);
});

test("runtime branch executes only the selected flow", async () => {
  const order = [];
  const runtime = createRuntime(defineRuntime([
    task({ id: "publish" }, [
      branch(
        (ctx) => Boolean(ctx.input.preview),
        async () => {
          order.push("preview");
          return "preview";
        },
        async () => {
          order.push("release");
          return "release";
        }
      )
    ])
  ]));

  const result = await runtime.run({ preview: true });

  assert.equal(result.status, "passed");
  assert.equal(result.output, "preview");
  assert.deepEqual(order, ["preview"]);
  assert.equal(result.nodes.some((node) => node.kind === "branch" && node.status === "passed"), true);
});

test("runtime rejects second-argument parallel options", () => {
  assert.throws(
    () => parallel([async () => "ok"], { concurrency: 1 }),
    (error) => error.code === "ASYNC_PIPELINE_RUNTIME_PARALLEL_OPTIONS_ORDER"
  );
});

test("runtime exposes branch predicate failures separately", async () => {
  const runtime = createRuntime(defineRuntime([
    task({ id: "publish" }, [
      branch(
        () => {
          throw new Error("cannot choose branch");
        },
        async () => "preview"
      )
    ])
  ]));

  const result = await runtime.run({});

  assert.equal(result.status, "failed");
  assert.equal(result.nodes.some((node) => node.kind === "branch" && node.errorCode === "ASYNC_PIPELINE_RUNTIME_BRANCH_PREDICATE_FAILED"), true);
});

test("runtime exposes structural failure nodes", async () => {
  const runtime = createRuntime(defineRuntime([
    task({ id: "verify" }, [
      async (_ctx, next) => next(),
      parallel([
        async () => "ok",
        async () => {
          throw new Error("boom");
        }
      ])
    ])
  ]));

  const result = await runtime.run({});

  assert.equal(result.status, "failed");
  assert.equal(result.tasks[0].status, "failed");
  assert.equal(result.tasks[0].errorCode, "ASYNC_PIPELINE_RUNTIME_TASK_FAILED");
  assert.equal(result.nodes.some((node) => node.kind === "parallel" && node.status === "failed"), true);
  assert.equal(result.nodes.some((node) => node.kind === "middleware" && node.status === "failed" && node.path.at(-1) === "0"), true);
});

test("runtime exposes double next guardrail in failed nodes", async () => {
  const runtime = createRuntime(defineRuntime([
    task({ id: "bad" }, [
      async (_ctx, next) => {
        await next();
        return next();
      },
      async () => "done"
    ])
  ]));

  const result = await runtime.run({});

  assert.equal(result.status, "failed");
  assert.equal(result.nodes.some((node) => node.errorCode === "ASYNC_PIPELINE_RUNTIME_NEXT_CALLED_TWICE"), true);
});

test("runtime can define a top-level anonymous composed flow", async () => {
  const order = [];
  const runtime = createRuntime(defineRuntime([
    async (_ctx, next) => {
      order.push("top");
      return next();
    },
    async () => {
      order.push("done");
      return "ok";
    }
  ]));

  const result = await runtime.run({});

  assert.equal(result.status, "passed");
  assert.equal(result.output, "ok");
  assert.deepEqual(order, ["top", "done"]);
  assert.deepEqual(result.tasks.map((entry) => entry.id), ["runtime"]);
});
