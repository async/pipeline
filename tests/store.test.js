import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { definePipeline, job, sh, task } from "../packages/pipeline-core/dist/index.js";
import { acquireRunLock, computeTaskCacheKey, createFileCacheStoreAdapter, createMemoryCacheStoreAdapter, createStore, pruneCacheEntries, readCacheEntry, resolveInputFiles, restoreCacheOutputs, writeCacheEntry, writeFileAtomic } from "../packages/pipeline-node/dist/store.js";

function cacheStoreContext(dir, storeName) {
  return {
    rootDir: dir,
    asyncDir: join(dir, ".async"),
    storeName,
    policy: storeName === "memory" ? "session" : "local",
    runId: "test",
    taskId: "cache"
  };
}

async function listCacheEntries(adapter, prefix, context) {
  assert.equal(typeof adapter.list, "function");
  const entries = [];
  for await (const entry of adapter.list(prefix, context)) entries.push(entry);
  return entries;
}

test("writeFileAtomic publishes complete files and leaves no temp files behind", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-atomic-"));
  try {
    const target = join(dir, "execution.json");
    await writeFileAtomic(target, "{\"status\":\"passed\"}\n");
    assert.equal(await readFile(target, "utf8"), "{\"status\":\"passed\"}\n");

    // Overwrite must replace the full content, never append or truncate partially.
    await writeFileAtomic(target, "{\"status\":\"failed\",\"longer\":true}\n");
    assert.equal(await readFile(target, "utf8"), "{\"status\":\"failed\",\"longer\":true}\n");

    const leftovers = (await readdir(dir)).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(leftovers, [], "temp files must not survive a successful write");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("glob inputs are resolved deterministically and included in cache keys", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-cache-"));
  try {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "a.ts"), "export const value = 1;\n", "utf8");
    await writeFile(join(dir, "src", "b.test.ts"), "test('noop', () => {});\n", "utf8");

    assert.deepEqual(await resolveInputFiles(dir, ["src/**/*.ts", "!src/**/*.test.ts"]), ["src/a.ts"]);

    const pipeline = definePipeline({
      name: "cache-test",
      tasks: {
        build: task({ inputs: ["src/**/*.ts", "!src/**/*.test.ts"], run: sh`echo build` })
      },
      jobs: {
        verify: job({ target: "build" })
      }
    });

    const first = await computeTaskCacheKey(pipeline, pipeline.tasks.build, dir);
    await writeFile(join(dir, "src", "a.ts"), "export const value = 2;\n", "utf8");
    const second = await computeTaskCacheKey(pipeline, pipeline.tasks.build, dir);

    assert.notEqual(first, second);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("cache inputs ignore local state directories and declared outputs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-cache-ignore-"));
  try {
    await mkdir(join(dir, ".async", "cache"), { recursive: true });
    await mkdir(join(dir, ".git", "objects"), { recursive: true });
    await mkdir(join(dir, "node_modules", "fixture"), { recursive: true });
    await mkdir(join(dir, "packages", "app", "src"), { recursive: true });
    await mkdir(join(dir, "packages", "app", "dist"), { recursive: true });
    await writeFile(join(dir, ".async", "cache", "state.ts"), "export const state = true;\n", "utf8");
    await writeFile(join(dir, ".git", "objects", "ignored.ts"), "export const ignored = true;\n", "utf8");
    await writeFile(join(dir, "node_modules", "fixture", "ignored.ts"), "export const ignored = true;\n", "utf8");
    await writeFile(join(dir, "packages", "app", "src", "index.ts"), "export const value = 1;\n", "utf8");
    await writeFile(join(dir, "packages", "app", "dist", "index.d.ts"), "export declare const value = 1;\n", "utf8");

    assert.deepEqual(await resolveInputFiles(dir, ["**/*.ts"]), ["packages/app/dist/index.d.ts", "packages/app/src/index.ts"]);
    assert.deepEqual(await resolveInputFiles(dir, ["packages/**/*.ts"], {
      exclude: ["packages/*/dist/**"]
    }), ["packages/app/src/index.ts"]);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("production cache keys ignore test edits and declared outputs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-production-cache-"));
  try {
    await mkdir(join(dir, "packages", "app", "src"), { recursive: true });
    await mkdir(join(dir, "packages", "app", "dist"), { recursive: true });
    await mkdir(join(dir, "tests"), { recursive: true });
    await writeFile(join(dir, "packages", "app", "src", "index.ts"), "export const value = 1;\n", "utf8");
    await writeFile(join(dir, "packages", "app", "dist", "index.d.ts"), "export declare const value = 1;\n", "utf8");
    await writeFile(join(dir, "tests", "app.test.js"), "test('one', () => {});\n", "utf8");

    const pipeline = definePipeline({
      name: "cache-test",
      namedInputs: {
        production: ["packages/**/*.ts", "!tests/**/*.test.js"]
      },
      tasks: {
        build: task({
          inputs: ["production"],
          outputs: ["packages/*/dist/**"],
          cache: true,
          run: sh`echo build`
        })
      },
      jobs: {
        verify: job({ target: "build" })
      }
    });

    const first = await computeTaskCacheKey(pipeline, pipeline.tasks.build, dir);
    await writeFile(join(dir, "tests", "app.test.js"), "test('two', () => {});\n", "utf8");
    await writeFile(join(dir, "packages", "app", "dist", "index.d.ts"), "export declare const value = 2;\n", "utf8");
    const second = await computeTaskCacheKey(pipeline, pipeline.tasks.build, dir);

    assert.equal(first, second);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("cache keys omit candidate fingerprints and absolute working directories", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-source-cache-"));
  const otherDir = await mkdtemp(join(tmpdir(), "async-pipeline-source-cache-other-"));
  try {
    await writeFile(join(dir, "input.txt"), "one\n", "utf8");
    await writeFile(join(otherDir, "input.txt"), "one\n", "utf8");
    const pipeline = definePipeline({
      name: "cache-test",
      tasks: {
        test: task({ inputs: ["input.txt"], cache: true, run: sh`echo test` })
      },
      jobs: {
        verify: job({ target: "test" })
      }
    });

    const baseOptions = {
      source: { name: "app", dir, type: "path" },
      prepareCommands: [`pnpm add file:${dir}`]
    };
    const first = await computeTaskCacheKey(pipeline, pipeline.tasks.test, dir, {
      ...baseOptions,
      candidate: { dir, fingerprint: "candidate-a" }
    });
    const second = await computeTaskCacheKey(pipeline, pipeline.tasks.test, otherDir, {
      source: { name: "app", dir: otherDir, type: "path" },
      prepareCommands: [`pnpm add file:${otherDir}`],
      candidate: { dir: otherDir, fingerprint: "candidate-b" }
    });
    const third = await computeTaskCacheKey(pipeline, pipeline.tasks.test, dir, {
      ...baseOptions,
      candidate: { dir, fingerprint: "candidate-a" },
      prepareCommands: ["pnpm install", "pnpm add file:../candidate"]
    });

    assert.equal(first, second);
    assert.notEqual(first, third);
  } finally {
    await rm(dir, { force: true, recursive: true });
    await rm(otherDir, { force: true, recursive: true });
  }
});

test("file cache entries snapshot and restore declared outputs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-output-cache-"));
  try {
    const store = await createStore(dir);
    await mkdir(join(dir, "dist"), { recursive: true });
    await writeFile(join(dir, "dist", "artifact.txt"), "cached output\n", "utf8");

    await writeCacheEntry(store, "cache-key", {
      id: "build",
      status: "passed",
      attempts: 1,
      cacheHit: false,
      finishedAt: new Date().toISOString()
    }, {
      cwd: dir,
      outputs: ["dist/**"]
    });

    await rm(join(dir, "dist"), { force: true, recursive: true });
    assert.equal(await restoreCacheOutputs(store, "cache-key", dir, ["dist/**"]), true);
    assert.equal(await readFile(join(dir, "dist", "artifact.txt"), "utf8"), "cached output\n");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("run locks reject active holders and reclaim stale locks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-run-lock-"));
  try {
    const store = await createStore(dir);
    const lock = await acquireRunLock(store);
    await assert.rejects(
      () => acquireRunLock(store),
      /ASYNC_PIPELINE_RUN_ACTIVE|Another async-pipeline run/
    );
    await lock.release();

    await writeFile(join(store.asyncDir, "run.lock"), `${JSON.stringify({ pid: 99999999 })}\n`, "utf8");
    const reclaimed = await acquireRunLock(store);
    await reclaimed.release();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cache hits refresh mtimes and gc prunes cold cache entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-cache-gc-"));
  try {
    const store = await createStore(dir);
    await writeCacheEntry(store, "hot", {
      id: "build",
      status: "passed",
      attempts: 1,
      cacheHit: false,
      finishedAt: new Date().toISOString()
    });
    await writeCacheEntry(store, "cold", {
      id: "test",
      status: "passed",
      attempts: 1,
      cacheHit: false,
      finishedAt: new Date().toISOString()
    });

    const old = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000);
    await utimes(join(store.cacheDir, "hot", "result.json"), old, old);
    await utimes(join(store.cacheDir, "cold", "result.json"), old, old);

    assert.equal((await readCacheEntry(store, "hot"))?.schemaVersion, 1);
    assert.ok((await stat(join(store.cacheDir, "hot", "result.json"))).mtimeMs > old.getTime());

    assert.equal(await pruneCacheEntries(dir, 30), 1);
    assert.deepEqual((await readdir(store.cacheDir)).sort(), ["hot"]);
    assert.equal(await pruneCacheEntries(dir, 0), 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("file cache store adapter lists deletes touches and prunes blob keys", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-file-cache-lifecycle-"));
  try {
    const adapter = createFileCacheStoreAdapter();
    const context = cacheStoreContext(dir, "file");

    await adapter.put("entry/result.json", "one", context);
    await adapter.put("entry/outputs.blob", "two", context);
    await adapter.put("other/result.json", "three", context);
    const old = new Date(Date.now() - 60_000);
    await utimes(join(dir, ".async", "cache", "tasks", "entry", "result.json"), old, old);

    assert.deepEqual((await listCacheEntries(adapter, "entry/", context)).map((entry) => entry.key), [
      "entry/outputs.blob",
      "entry/result.json"
    ]);

    await delay(5);
    await adapter.touch?.("entry/result.json", context);
    const touched = (await listCacheEntries(adapter, "entry/result.json", context))[0];
    assert.ok(Date.parse(touched.lastUsedAt) > old.getTime());

    await adapter.delete?.("entry/outputs.blob", context);
    assert.deepEqual((await listCacheEntries(adapter, "entry/", context)).map((entry) => entry.key), ["entry/result.json"]);

    const pruned = await adapter.prune?.({ prefix: "other/", maxSizeBytes: 0 }, context);
    assert.deepEqual(pruned, { removed: 1, bytesRemoved: 5 });
    assert.deepEqual((await listCacheEntries(adapter, "", context)).map((entry) => entry.key), ["entry/result.json"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("memory cache store adapter lists deletes touches and prunes blob keys", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-memory-cache-lifecycle-"));
  try {
    const adapter = createMemoryCacheStoreAdapter();
    const context = cacheStoreContext(dir, "memory");

    await adapter.put("entry/result.json", "one", context);
    await adapter.put("entry/outputs.blob", "two", context);
    await adapter.put("other/result.json", "three", context);
    const before = (await listCacheEntries(adapter, "entry/result.json", context))[0];

    await delay(5);
    await adapter.touch?.("entry/result.json", context);
    const after = (await listCacheEntries(adapter, "entry/result.json", context))[0];
    assert.ok(Date.parse(after.lastUsedAt) > Date.parse(before.lastUsedAt));

    await adapter.delete?.("entry/outputs.blob", context);
    assert.deepEqual((await listCacheEntries(adapter, "entry/", context)).map((entry) => entry.key), ["entry/result.json"]);

    const pruned = await adapter.prune?.({ prefix: "other/", maxSizeBytes: 0 }, context);
    assert.deepEqual(pruned, { removed: 1, bytesRemoved: 5 });
    assert.deepEqual((await listCacheEntries(adapter, "", context)).map((entry) => entry.key), ["entry/result.json"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("default pruning skips .git, .async, and node_modules at any depth", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-prune-"));
  try {
    await mkdir(join(dir, "pkg", "src"), { recursive: true });
    await mkdir(join(dir, "pkg", "node_modules", "dep"), { recursive: true });
    await mkdir(join(dir, "pkg", ".git"), { recursive: true });
    await writeFile(join(dir, "pkg", "src", "a.ts"), "export {};\n", "utf8");
    await writeFile(join(dir, "pkg", "node_modules", "dep", "d.ts"), "export {};\n", "utf8");
    await writeFile(join(dir, "pkg", ".git", "x.ts"), "export {};\n", "utf8");

    assert.deepEqual(await resolveInputFiles(dir, ["pkg/**/*.ts"]), ["pkg/src/a.ts"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
