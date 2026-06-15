import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { definePipeline, env, job, sh, task } from "../packages/pipeline-core/dist/index.js";
import { runJob } from "../packages/pipeline-node/dist/runner.js";

const execFileAsync = promisify(execFile);
const CLI = join(process.cwd(), "packages", "pipeline-node", "dist", "cli.js");
const DIST = join(process.cwd(), "packages", "pipeline", "dist", "index.js");

function checkPipeline(dir) {
  return definePipeline({
    name: "context-test",
    cache: "file:local",
    env: { SECRET_DEST: env.secret("ASYNC_PIPELINE_TEST_PACK_SECRET") },
    tasks: {
      check: task({
        inputs: ["seed.txt"],
        cache: true,
        run: sh`sh -c 'echo "checking with $SECRET_DEST"; grep ok seed.txt'`
      })
    },
    jobs: { verify: job({ target: "check" }) }
  });
}

const RUN_ENV = { PATH: process.env.PATH, ASYNC_PIPELINE_TEST_PACK_SECRET: "hunter2-very-secret-value" };

test("PROMISE: failed tasks write a context pack with a redacted log tail and an input diff against the last passing run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-pack-"));
  try {
    await writeFile(join(dir, "seed.txt"), "ok\n");
    const passing = await runJob(checkPipeline(dir), { id: "verify", cwd: dir, env: RUN_ENV });
    assert.equal(passing.tasks[0]?.status, "passed");

    await writeFile(join(dir, "seed.txt"), "FAIL\n");
    const failing = await runJob(checkPipeline(dir), { id: "verify", cwd: dir, env: RUN_ENV });
    assert.equal(failing.tasks[0]?.status, "failed");

    const pack = JSON.parse(await readFile(join(dir, ".async", "runs", failing.id, "context", "check.json"), "utf8"));
    assert.equal(pack.schemaVersion, 1);
    assert.equal(pack.task, "check");
    assert.equal(pack.runId, failing.id);
    assert.equal(pack.status, "failed");
    assert.match(pack.error, /exit code/);
    assert.equal(pack.reproduce, "async-pipeline run-task check");

    // The diff names exactly the input that moved since the last pass.
    assert.equal(pack.inputDiff.baselineCacheKey, passing.tasks[0]?.cacheKey);
    assert.deepEqual(pack.inputDiff.changed, ["seed.txt"]);
    assert.deepEqual(pack.inputDiff.added, []);
    assert.deepEqual(pack.inputDiff.removed, []);

    // The log tail is present and redacted.
    assert.match(pack.logTail, /checking with/);
    assert.doesNotMatch(pack.logTail, /hunter2-very-secret-value/);
    assert.match(pack.logTail, /\[redacted\]/);
    assert.doesNotMatch(pack.error, /hunter2-very-secret-value/);
    assert.ok(pack.logTail.length <= 4096);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("PROMISE: a task that has never passed reports a missing baseline instead of a diff", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-pack-cold-"));
  try {
    await writeFile(join(dir, "seed.txt"), "FAIL\n");
    const failing = await runJob(checkPipeline(dir), { id: "verify", cwd: dir, env: RUN_ENV });
    assert.equal(failing.tasks[0]?.status, "failed");
    const pack = JSON.parse(await readFile(join(dir, ".async", "runs", failing.id, "context", "check.json"), "utf8"));
    assert.deepEqual(pack.inputDiff, { baselineMissing: true });
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("PROMISE: cache entries persist per-file input digests for the entry's input state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-pack-digests-"));
  try {
    await writeFile(join(dir, "seed.txt"), "ok\n");
    const record = await runJob(checkPipeline(dir), { id: "verify", cwd: dir, env: RUN_ENV });
    const cacheKey = record.tasks[0]?.cacheKey;
    const manifest = JSON.parse(await readFile(join(dir, ".async", "cache", "tasks", cacheKey, "inputs.json"), "utf8"));
    assert.equal(manifest.schemaVersion, 1);
    assert.match(manifest.files["seed.txt"], /^sha256:[0-9a-f]{64}$/);
    const baseline = JSON.parse(await readFile(join(dir, ".async", "cache", "baselines", "check.json"), "utf8"));
    assert.equal(baseline.cacheKey, cacheKey);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("context packs name registered claims whose test titles appear in the failing log", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-pack-claims-"));
  try {
    await writeFile(join(dir, "seed.txt"), "ok\n");
    await mkdir(join(dir, "tests"), { recursive: true });
    await writeFile(join(dir, "tests", "claims.json"), JSON.stringify({
      claims: [
        { id: "demo.promise", source: "README.md", anchor: "x", tests: ["PROMISE: the demo invariant holds"] },
        { id: "demo.unrelated", source: "README.md", anchor: "y", tests: ["some other test"] }
      ]
    }));
    const pipeline = definePipeline({
      name: "claims-test",
      cache: "file:local",
      tasks: {
        check: task({
          inputs: ["seed.txt"],
          cache: true,
          run: sh`sh -c 'echo "not ok 1 - PROMISE: the demo invariant holds"; exit 1'`
        })
      },
      jobs: { verify: job({ target: "check" }) }
    });
    const failing = await runJob(pipeline, { id: "verify", cwd: dir, env: { PATH: process.env.PATH } });
    assert.equal(failing.tasks[0]?.status, "failed");
    const pack = JSON.parse(await readFile(join(dir, ".async", "runs", failing.id, "context", "check.json"), "utf8"));
    assert.deepEqual(pack.claims, ["demo.promise"]);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("PROMISE: explain reports changed inputs and run evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-explain-diff-"));
  try {
    await writeFile(join(dir, "pipeline.mjs"), `import { definePipeline, job, sh, task } from ${JSON.stringify(DIST)};
export default definePipeline({
  name: "explain-test",
  cache: "file:local",
  tasks: {
    check: task({ inputs: ["seed.txt"], cache: true, run: sh\`grep ok seed.txt\` })
  },
  jobs: { verify: job({ target: "check" }) }
});
`);
    await writeFile(join(dir, "seed.txt"), "ok\n");
    await execFileAsync(process.execPath, [CLI, "run", "verify"], { cwd: dir, env: RUN_ENV });

    // Unchanged inputs: empty diff.
    const unchanged = JSON.parse((await execFileAsync(process.execPath, [CLI, "explain", "check", "--diff-inputs", "--format", "json"], { cwd: dir, env: RUN_ENV })).stdout);
    assert.deepEqual(unchanged.changed, []);

    await writeFile(join(dir, "seed.txt"), "still ok\n");
    await writeFile(join(dir, "extra.txt"), "ignored, not an input\n");
    const diff = JSON.parse((await execFileAsync(process.execPath, [CLI, "explain", "check", "--diff-inputs", "--format", "json"], { cwd: dir, env: RUN_ENV })).stdout);
    assert.equal(diff.task, "check");
    assert.deepEqual(diff.changed, ["seed.txt"]);
    assert.deepEqual(diff.added, []);

    // explain --run surfaces the run evidence and context packs of a failing run.
    await writeFile(join(dir, "seed.txt"), "FAIL\n");
    const failed = await execFileAsync(process.execPath, [CLI, "run", "verify", "--format", "json"], { cwd: dir, env: RUN_ENV }).catch((error) => error);
    const record = JSON.parse(failed.stdout);
    assert.equal(record.status, "failed");
    const evidence = JSON.parse((await execFileAsync(process.execPath, [CLI, "explain", "--run", record.id, "--format", "json"], { cwd: dir, env: RUN_ENV })).stdout);
    assert.equal(evidence.runId, record.id);
    assert.equal(evidence.contextPacks.length, 1);
    assert.equal(evidence.contextPacks[0].task, "check");
    assert.deepEqual(evidence.contextPacks[0].inputDiff.changed, ["seed.txt"]);
    assert.equal(evidence.tasks.find((entry) => entry.id === "check").contextPack.task, "check");
    const latest = JSON.parse((await execFileAsync(process.execPath, [CLI, "explain", "--run", "latest", "--format", "json"], { cwd: dir, env: RUN_ENV })).stdout);
    assert.equal(latest.runId, record.id);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});
