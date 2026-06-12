// Smoke tests proving every committed example runs green from its own
// directory through the *public* package CLI (packages/pipeline/dist/cli.js),
// and that committed sync artifacts (.github workflow, lock files, synced
// scripts) are current. Run by the self pipeline's `examples` task.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const cliPath = join(repoRoot, "packages/pipeline/dist/cli.js");

function exampleDir(name) {
  return join(repoRoot, "examples", name);
}

function runCli(example, args) {
  return spawnSync("node", [cliPath, ...args], {
    cwd: exampleDir(example),
    encoding: "utf8",
    env: { ...process.env },
    timeout: 240_000
  });
}

function assertPassed(example, args, result) {
  assert.equal(
    result.status,
    0,
    `examples/${example} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`
  );
}

function assertJobPasses(example, job) {
  const args = ["run", job, "--force"];
  const result = runCli(example, args);
  assertPassed(example, args, result);
  assert.match(result.stdout, /Pipeline passed/, `examples/${example} ${job} did not report success`);
}

function assertSyncCurrent(example) {
  const result = runCli(example, ["sync", "check"]);
  assertPassed(example, ["sync", "check"], result);
}

test("github-native-npm-preview-package: prPreview runs and sync artifacts are current", () => {
  assertJobPasses("github-native-npm-preview-package", "prPreview");
  assertSyncCurrent("github-native-npm-preview-package");
});

test("basic-node-package: verify runs, re-runs cached, and sync artifacts are current", () => {
  assertJobPasses("basic-node-package", "verify");
  assertSyncCurrent("basic-node-package");

  // The README promises the second run resolves the chain as cached.
  const second = runCli("basic-node-package", ["run", "verify", "--format", "json"]);
  assertPassed("basic-node-package", ["run", "verify", "--format", "json"], second);
  const record = JSON.parse(second.stdout);
  for (const taskId of ["typecheck", "test", "build"]) {
    const entry = record.tasks.find((task) => task.id === taskId);
    assert.equal(entry?.status, "cached", `second run: expected ${taskId} to be cached, got ${entry?.status}`);
  }
});

test("monorepo-package-selection: verify runs, selected packages carry synced scripts", () => {
  assertJobPasses("monorepo-package-selection", "verify");
  assertSyncCurrent("monorepo-package-selection");

  const tools = runCli("monorepo-package-selection", ["sync", "tasks", "list"]);
  assertPassed("monorepo-package-selection", ["sync", "tasks", "list"], tools);
  assert.match(tools.stdout, /packages\/app\/package\.json/);
  assert.match(tools.stdout, /packages\/api\/package\.json/);
  assert.doesNotMatch(tools.stdout, /internal-tools/);
});

test("deno-worker: verify runs without the deno binary and both manifests are synced", () => {
  assertJobPasses("deno-worker", "verify");
  assertSyncCurrent("deno-worker");

  const list = runCli("deno-worker", ["sync", "tasks", "list"]);
  assertPassed("deno-worker", ["sync", "tasks", "list"], list);
  assert.match(list.stdout, /worker\/deno\.json/);
  assert.match(list.stdout, /package\.json/);
});

test("many-repo-impact-run: impact job runs both source repos and matrix plans them", () => {
  assertJobPasses("many-repo-impact-run", "verifyImpact");
  assertSyncCurrent("many-repo-impact-run");

  const matrix = runCli("many-repo-impact-run", ["matrix", "verifyImpact", "--format", "github"]);
  assertPassed("many-repo-impact-run", ["matrix", "verifyImpact", "--format", "github"], matrix);
  const parsed = JSON.parse(matrix.stdout);
  assert.deepEqual(
    parsed.include.map((row) => row.task).sort(),
    ["admin:test-design-system", "storefront:test"]
  );

  const single = runCli("many-repo-impact-run", ["run-task", "storefront:test", "--force"]);
  assertPassed("many-repo-impact-run", ["run-task storefront:test"], single);
});

test("custom-cache-registry: verify runs, outputs restore from cache, and the remote store fails loudly", () => {
  assertJobPasses("custom-cache-registry", "verify");

  // The README promises a cache hit restores the declared output without
  // re-running the script: after deleting the file, the restored content must
  // be byte-identical (a re-run would write a fresh builtAt timestamp).
  const report = join(exampleDir("custom-cache-registry"), "build/report.json");
  const before = readFileSync(report, "utf8");
  rmSync(report, { force: true });
  const restore = runCli("custom-cache-registry", ["run-task", "report"]);
  assertPassed("custom-cache-registry", ["run-task report"], restore);
  assert.equal(existsSync(report), true, "build/report.json was not restored");
  assert.equal(readFileSync(report, "utf8"), before, "report.json was rebuilt instead of restored from cache");

  // The declared-only redis store must fail with its recorded reason on the
  // terminal, not silently skip caching.
  const remote = runCli("custom-cache-registry", ["run", "remote"]);
  assert.notEqual(remote.status, 0, "run remote should fail: redis is declared metadata only");
  assert.match(remote.stderr, /Cache store "redis" is registered but this runner cannot execute it/);
});

test("runtime-middleware-stack: demos and verify job stay honest", () => {
  const app = spawnSync("node", ["src/app.mjs"], {
    cwd: exampleDir("runtime-middleware-stack"),
    encoding: "utf8",
    timeout: 60_000
  });
  assert.equal(app.status, 0, app.stderr);
  assert.match(app.stdout, /"accepted":true/);
  assert.match(app.stdout, /flow kinds: middleware, series, parallel, branch/);

  const worker = spawnSync("node", ["src/worker.mjs"], {
    cwd: exampleDir("runtime-middleware-stack"),
    encoding: "utf8",
    timeout: 60_000
  });
  assert.equal(worker.status, 0, worker.stderr);
  assert.match(worker.stdout, /drainDeliveries:cached/);
  assert.match(worker.stdout, /report output: "processed 3 deliveries"/);

  assertJobPasses("runtime-middleware-stack", "verify");
});
