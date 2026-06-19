// Product-promise invariants. Each test encodes a claim from README.md or docs/.
// If one of these fails, the product is lying about its core behavior — fix the
// implementation, never the assertion.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { definePipeline, job, sh, task } from "../packages/pipeline-core/dist/index.js";
import { runJob } from "../packages/pipeline-node/dist/runner.js";

const cliPath = fileURLToPath(new URL("../packages/pipeline-node/dist/cli.js", import.meta.url));
const coreUrl = new URL("../packages/pipeline-core/dist/index.js", import.meta.url).href;

function statusOf(record, taskId) {
  return record.tasks.find((entry) => entry.id === taskId)?.status;
}

test("PROMISE: per-task inputs isolate cache invalidation", async () => {
  // README: "Make cache behavior explicit through declared task inputs."
  // Editing a file that only belongs to task b's inputs must not invalidate task a.
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-invariant-isolation-"));
  try {
    await writeFile(join(dir, "a.txt"), "a1\n", "utf8");
    await writeFile(join(dir, "b.txt"), "b1\n", "utf8");
    const pipeline = () => definePipeline({
      name: "isolation",
      cache: "file:local",
      tasks: {
        a: task({ inputs: ["a.txt"], cache: true, run: sh`node -e "process.exit(0)"` }),
        b: task({ inputs: ["b.txt"], cache: true, run: sh`node -e "process.exit(0)"` })
      },
      jobs: { all: job({ target: ["a", "b"] }) }
    });
    const target = ({ cwd: dir, env: { PATH: process.env.PATH } });

    await runJob(pipeline(), { id: "all", ...target });
    await writeFile(join(dir, "b.txt"), "b2\n", "utf8");
    const record = await runJob(pipeline(), { id: "all", ...target });

    assert.equal(statusOf(record, "a"), "cached", "task a must stay cached when only b's inputs change");
    assert.equal(statusOf(record, "b"), "passed", "task b must re-run when its inputs change");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("PROMISE: a second run of an unchanged pipeline is fully cached", async () => {
  // README: local-first verification — a warm verify must be a no-op.
  // This is the invariant that catches outputs leaking into inputs, global
  // fingerprints, unstable cache keys, and similar self-invalidation bugs.
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-invariant-warm-"));
  try {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "main.txt"), "stable\n", "utf8");
    const pipeline = () => definePipeline({
      name: "warm",
      cache: "file:local",
      tasks: {
        build: task({
          inputs: ["src/**/*.txt"],
          outputs: ["out/**"],
          cache: true,
          run: sh`node -e "const fs=require('node:fs');fs.mkdirSync('out',{recursive:true});fs.writeFileSync('out/build.txt','built\\n')"`
        }),
        check: task({
          dependsOn: ["build"],
          inputs: ["src/**/*.txt"],
          cache: true,
          run: sh`node -e "process.exit(0)"`
        })
      },
      jobs: { verify: job({ target: "check" }) }
    });
    const target = ({ cwd: dir, env: { PATH: process.env.PATH } });

    const cold = await runJob(pipeline(), { id: "verify", ...target });
    assert.equal(cold.status, "passed");
    const warm = await runJob(pipeline(), { id: "verify", ...target });
    assert.equal(warm.status, "passed");
    for (const entry of warm.tasks) {
      assert.equal(entry.status, "cached", `task ${entry.id} must be cached on an unchanged second run`);
    }
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("PROMISE: declared outputs do not feed back into a task's own cache inputs", async () => {
  // docs/api.md: a task's declared outputs are ignored by its input resolution.
  // Outputs written inside an input glob must not invalidate the task that wrote them.
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-invariant-feedback-"));
  try {
    await mkdir(join(dir, "site"), { recursive: true });
    await writeFile(join(dir, "site", "page.txt"), "page\n", "utf8");
    const pipeline = () => definePipeline({
      name: "feedback",
      cache: "file:local",
      tasks: {
        render: task({
          inputs: ["site/**/*.txt"],
          outputs: ["site/gen/**"],
          cache: true,
          run: sh`node -e "const fs=require('node:fs');fs.mkdirSync('site/gen',{recursive:true});fs.writeFileSync('site/gen/rendered.txt','rendered\\n')"`
        })
      },
      jobs: { render: job({ target: "render" }) }
    });
    const target = ({ cwd: dir, env: { PATH: process.env.PATH } });

    const first = await runJob(pipeline(), { id: "render", ...target });
    assert.equal(first.status, "passed");
    const second = await runJob(pipeline(), { id: "render", ...target });
    assert.equal(statusOf(second, "render"), "cached", "render must not invalidate itself by writing its declared outputs");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("PROMISE: the CLI streams the plan before task output and prefixes task lines", async () => {
  // CHANGELOG 0.2.0: CLI progress streams during the run, and parallel task
  // output stays attributable. Plan line first, prefixed task output, summary last.
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-invariant-cli-"));
  try {
    await writeFile(join(dir, "pipeline.mjs"), [
      `import { definePipeline, job, sh, task } from ${JSON.stringify(coreUrl)};`,
      "export default definePipeline({",
      '  name: "ordering",',
      "  tasks: { hello: task({ cache: false, run: sh`node -e \"console.log('hello-from-task')\"` }) },",
      '  jobs: { all: job({ target: "hello" }) }',
      "});",
      ""
    ].join("\n"), "utf8");

    const result = spawnSync("node", [cliPath, "run", "all"], { cwd: dir, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);

    const planIndex = result.stdout.indexOf("Running ordering:all");
    const taskIndex = result.stdout.indexOf("[hello] hello-from-task");
    const doneIndex = result.stdout.indexOf("Pipeline passed");
    assert.ok(planIndex >= 0, `missing plan line in: ${result.stdout}`);
    assert.ok(taskIndex >= 0, `missing prefixed task output in: ${result.stdout}`);
    assert.ok(doneIndex >= 0, `missing completion line in: ${result.stdout}`);
    assert.ok(planIndex < taskIndex, "plan line must stream before task output");
    assert.ok(taskIndex < doneIndex, "task output must stream before the completion line");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("PROMISE: interrupting the CLI terminates running task processes", { skip: process.platform === "win32" }, async () => {
  // Stability: Ctrl-C on a run must not orphan task process groups, must
  // finalize the execution record, and must exit 130 (128 + SIGINT).
  const { spawn } = await import("node:child_process");
  const { setTimeout: delay } = await import("node:timers/promises");
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-invariant-signal-"));
  try {
    await writeFile(join(dir, "pipeline.mjs"), [
      `import { definePipeline, job, sh, task } from ${JSON.stringify(coreUrl)};`,
      "export default definePipeline({",
      '  name: "signal",',
      "  tasks: { hang: task({ cache: false, run: sh`node -e \"console.log('CHILD='+process.pid); setInterval(()=>{},1000)\"` }) },",
      '  jobs: { hang: job({ target: "hang" }) }',
      "});",
      ""
    ].join("\n"), "utf8");

    const cli = spawn("node", [cliPath, "run", "hang"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    const closed = new Promise((resolve) => cli.on("close", (code) => resolve(code)));
    cli.stderr.resume();
    let output = "";
    cli.stdout.setEncoding("utf8");
    cli.stdout.on("data", (chunk) => { output += chunk; });

    let childPid;
    for (let attempt = 0; attempt < 100 && !childPid; attempt += 1) {
      const match = /CHILD=(\d+)/.exec(output);
      if (match) childPid = Number(match[1]);
      else await delay(50);
    }
    assert.ok(childPid, `task process never reported its pid: ${output}`);

    cli.kill("SIGINT");
    let childAlive = true;
    for (let attempt = 0; attempt < 100 && childAlive; attempt += 1) {
      try {
        process.kill(childPid, 0);
        await delay(50);
      } catch {
        childAlive = false;
      }
    }
    if (childAlive) {
      try { process.kill(childPid, "SIGKILL"); } catch {}
    }
    assert.equal(childAlive, false, "task process must terminate when the CLI receives SIGINT");

    const exitCode = await Promise.race([closed, delay(15000).then(() => null)]);
    if (exitCode === null) { try { cli.kill("SIGKILL"); } catch {} }
    assert.equal(exitCode, 130, "CLI must exit 130 after SIGINT");

    const runs = await readdir(join(dir, ".async", "runs"));
    assert.equal(runs.length >= 1, true, "an execution record directory must exist");
    const record = JSON.parse(await readFile(join(dir, ".async", "runs", runs[0], "execution.json"), "utf8"));
    assert.notEqual(record.status, "running", "interrupt must finalize the execution record");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("CLI exits 143 and finalizes records after SIGTERM", { skip: process.platform === "win32" }, async () => {
  const { spawn } = await import("node:child_process");
  const { setTimeout: delay } = await import("node:timers/promises");
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-invariant-sigterm-"));
  try {
    await writeFile(join(dir, "pipeline.mjs"), [
      `import { definePipeline, job, sh, task } from ${JSON.stringify(coreUrl)};`,
      "export default definePipeline({",
      '  name: "sigterm",',
      "  tasks: { hang: task({ cache: false, run: sh`node -e \"console.log('CHILD='+process.pid); setInterval(()=>{},1000)\"` }) },",
      '  jobs: { hang: job({ target: "hang" }) }',
      "});",
      ""
    ].join("\n"), "utf8");

    const cli = spawn("node", [cliPath, "run", "hang"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    const closed = new Promise((resolve) => cli.on("close", (code) => resolve(code)));
    cli.stderr.resume();
    let output = "";
    cli.stdout.setEncoding("utf8");
    cli.stdout.on("data", (chunk) => { output += chunk; });

    let childPid;
    for (let attempt = 0; attempt < 100 && !childPid; attempt += 1) {
      const match = /CHILD=(\d+)/.exec(output);
      if (match) childPid = Number(match[1]);
      else await delay(50);
    }
    assert.ok(childPid, `task process never reported its pid: ${output}`);

    cli.kill("SIGTERM");
    const exitCode = await Promise.race([closed, delay(15000).then(() => null)]);
    if (exitCode === null) { try { cli.kill("SIGKILL"); } catch {} }
    assert.equal(exitCode, 143, "CLI must exit 143 after SIGTERM");

    let childAlive = true;
    for (let attempt = 0; attempt < 100 && childAlive; attempt += 1) {
      try {
        process.kill(childPid, 0);
        await delay(50);
      } catch {
        childAlive = false;
      }
    }
    if (childAlive) {
      try { process.kill(childPid, "SIGKILL"); } catch {}
    }
    assert.equal(childAlive, false, "task process must terminate when the CLI receives SIGTERM");

    const runs = await readdir(join(dir, ".async", "runs"));
    assert.equal(runs.length >= 1, true, "an execution record directory must exist");
    const record = JSON.parse(await readFile(join(dir, ".async", "runs", runs[0], "execution.json"), "utf8"));
    assert.notEqual(record.status, "running", "SIGTERM must finalize the execution record");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("PROMISE: a closed output pipe terminates tasks and finalizes the run", { skip: process.platform === "win32" }, async () => {
  // Stability: `async-pipeline run x | head` must not crash, orphan task
  // processes, or leave the execution record "running"; it exits 141
  // (128 + SIGPIPE).
  const { spawn } = await import("node:child_process");
  const { setTimeout: delay } = await import("node:timers/promises");
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-invariant-epipe-"));
  try {
    await writeFile(join(dir, "pipeline.mjs"), [
      `import { definePipeline, job, sh, task } from ${JSON.stringify(coreUrl)};`,
      "export default definePipeline({",
      '  name: "epipe",',
      "  tasks: { chatty: task({ cache: false, run: sh`node -e \"console.log('CHILD='+process.pid); setInterval(()=>console.log('tick'),25)\"` }) },",
      '  jobs: { chatty: job({ target: "chatty" }) }',
      "});",
      ""
    ].join("\n"), "utf8");

    const cli = spawn("node", [cliPath, "run", "chatty"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    const closed = new Promise((resolve) => cli.on("close", (code) => resolve(code)));
    cli.stderr.resume();
    let output = "";
    cli.stdout.setEncoding("utf8");
    cli.stdout.on("data", (chunk) => { output += chunk; });

    let childPid;
    for (let attempt = 0; attempt < 100 && !childPid; attempt += 1) {
      const match = /CHILD=(\d+)/.exec(output);
      if (match) childPid = Number(match[1]);
      else await delay(50);
    }
    assert.ok(childPid, `task process never reported its pid: ${output}`);

    // Simulate `| head` exiting: close the read end of the CLI's stdout.
    cli.stdout.destroy();

    const exitCode = await Promise.race([closed, delay(15000).then(() => null)]);
    let childAlive = true;
    for (let attempt = 0; attempt < 100 && childAlive; attempt += 1) {
      try {
        process.kill(childPid, 0);
        await delay(50);
      } catch {
        childAlive = false;
      }
    }
    if (childAlive) {
      try { process.kill(childPid, "SIGKILL"); } catch {}
    }
    if (exitCode === null) { try { cli.kill("SIGKILL"); } catch {} }

    assert.equal(childAlive, false, "task process must terminate when the output pipe closes");
    assert.equal(exitCode, 141, "CLI must exit 141 when its output pipe closes");

    const runs = await readdir(join(dir, ".async", "runs"));
    assert.equal(runs.length >= 1, true, "an execution record directory must exist");
    const record = JSON.parse(await readFile(join(dir, ".async", "runs", runs[0], "execution.json"), "utf8"));
    assert.notEqual(record.status, "running", "EPIPE shutdown must finalize the execution record");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("PROMISE: the release chain publishes GitHub Packages before npm, and package previews/snapshots are wired to their triggers", async () => {
  // README: "Stable releases publish to GitHub Packages as `@async/pipeline`
  // before npm". The wiring lives in pipeline.ts; this pins it so the fallback
  // registry can never silently fall behind the primary one.
  const { default: pipeline } = await import("../pipeline.ts");

  assert.deepEqual(
    pipeline.tasks["publish"].dependsOn,
    ["publish-github"],
    "the npm publish task must depend on the GitHub Packages mirror task"
  );
  assert.deepEqual(
    pipeline.tasks["publish-github"].dependsOn,
    ["release-ensure"],
    "the GitHub Packages mirror must wait for pipeline-owned release tag and GitHub Release creation"
  );
  assert.deepEqual(
    pipeline.tasks["release-ensure"].dependsOn,
    ["pack"],
    "release creation must only run after package verification"
  );
  assert.equal(pipeline.tasks["release-ensure"].run.command, "pnpm async-pipeline release ensure --package packages/pipeline");
  assert.equal(pipeline.tasks["publish-github"].run.command, "pnpm async-pipeline publish github release --package packages/pipeline");
  assert.equal(pipeline.tasks["snapshot"].run.command, "pnpm async-pipeline publish github main --package packages/pipeline");
  assert.deepEqual(
    pipeline.tasks["publish"].steps.map((step) => step.command),
    [
      "pnpm async-pipeline publish npm --package packages/pipeline",
      "pnpm async-pipeline release doctor --package packages/pipeline"
    ]
  );

  assert.equal(pipeline.sync.github.packagePreviews.enabled, true);
  assert.equal(pipeline.sync.github.dependabotAutoMerge.enabled, true);
  assert.equal(pipeline.tasks.preview, undefined);
  assert.equal(pipeline.jobs.preview, undefined);
  assert.deepEqual(pipeline.jobs["snapshot"].trigger, ["main"]);
  assert.deepEqual(
    pipeline.jobs["publish"].trigger,
    ["manual", "release"],
    "stable GitHub releases must invoke the publish chain, while manual dispatch remains available for re-runs"
  );

  // Publishing jobs must hold packages:write or GitHub Packages rejects them.
  assert.equal(pipeline.jobs["snapshot"].github.permissions.packages, "write");
  assert.equal(pipeline.jobs["publish"].github.permissions.contents, "write");
  assert.equal(pipeline.jobs["publish"].github.permissions.packages, "write");
});

test("PROMISE: package API surface artifacts are published with @async/pipeline", async () => {
  const rootManifest = JSON.parse(await readFile(new URL("../api-contract.json", import.meta.url), "utf8"));
  const packageManifest = JSON.parse(await readFile(new URL("../packages/pipeline/api-contract.json", import.meta.url), "utf8"));
  const rootLedger = await readFile(new URL("../API_SURFACE.md", import.meta.url), "utf8");
  const packageLedger = await readFile(new URL("../packages/pipeline/API_SURFACE.md", import.meta.url), "utf8");
  const packageJson = JSON.parse(await readFile(new URL("../packages/pipeline/package.json", import.meta.url), "utf8"));

  assert.equal(rootManifest.packageName, "@async/pipeline");
  assert.deepEqual(packageManifest, rootManifest, "published package manifest must stay in sync with the root API contract");
  assert.equal(packageLedger, rootLedger, "published package ledger must stay in sync with the root API surface ledger");
  assert.ok(packageJson.files.includes("api-contract.json"), "api-contract.json must be included in npm package files");
  assert.ok(packageJson.files.includes("API_SURFACE.md"), "API_SURFACE.md must be included in npm package files");
});

test("PROMISE: published package does not ship release lifecycle GitHub API fetch code", async () => {
  const lifecycle = await readFile(new URL("../packages/pipeline/dist/internal/node/package-lifecycle.js", import.meta.url), "utf8");
  assert.doesNotMatch(lifecycle, /globalThis\s*\[\s*["']fetch["']\s*\]|(?<![A-Za-z0-9_$])fetch\s*\(/);
  assert.match(lifecycle, /Package lifecycle commands moved out of the @async\/pipeline npm tarball/);
  assert.match(lifecycle, /pnpm dlx/);
  assert.match(lifecycle, /github:async\/release#b21372abc92a921cf659e54dc479dfe1028f8acf/);
  assert.match(lifecycle, /release", "sync-descriptions"/);
  assert.match(lifecycle, /publishGitHubPackage\(\) \{ throw new Error\(message\); \}/);
});

test("PROMISE: package exports the CLI subpath for Deno npm entrypoints", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../packages/pipeline/package.json", import.meta.url), "utf8"));

  assert.deepEqual(packageJson.exports["./cli"], {
    types: "./dist/cli.d.ts",
    default: "./dist/cli.js"
  });
});

test("PROMISE: API surface drift checks are wired through @async/api-contract and the release gate", async () => {
  const { default: pipeline } = await import("../pipeline.ts");
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const workspaceConfig = await readFile(new URL("../pnpm-workspace.yaml", import.meta.url), "utf8");

  assert.equal(packageJson.devDependencies["@async/api-contract"], "0.1.0");
  assert.match(workspaceConfig, /minimumReleaseAgeExclude:\n\s+- "@async\/\*"/);
  assert.equal(packageJson.scripts["pipeline:api-surface"], "async-pipeline run-task api-surface");
  assert.equal(packageJson.scripts["pipeline:api-surface:generate"], "async-pipeline run-task api-surface-generate");
  assert.ok(pipeline.tasks.pack.dependsOn.includes("api-surface"), "release pack gate must include API surface drift checks");
  assert.deepEqual(
    pipeline.tasks["api-surface"].steps.map((step) => step.command),
    [
      "pnpm api-contract check --manifest api-contract.json",
      "pnpm api-contract ledger --manifest api-contract.json --check API_SURFACE.md",
      "pnpm api-contract check --manifest packages/pipeline/api-contract.json",
      "pnpm api-contract ledger --manifest packages/pipeline/api-contract.json --check packages/pipeline/API_SURFACE.md"
    ]
  );
  assert.deepEqual(
    pipeline.tasks["api-surface-generate"].steps.map((step) => step.command),
    [
      "pnpm api-contract ledger --manifest api-contract.json --out API_SURFACE.md",
      "pnpm api-contract ledger --manifest packages/pipeline/api-contract.json --out packages/pipeline/API_SURFACE.md"
    ]
  );
});

test("PROMISE: self hygiene gates run in the release pack chain", async () => {
  const { default: pipeline } = await import("../pipeline.ts");
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  assert.ok(packageJson.devDependencies["@async/hygiene"], "@async/hygiene must own self hygiene tooling");
  assert.equal(packageJson.scripts["hygiene:check"], "async-hygiene check");
  assert.ok(pipeline.tasks.hygiene, "hygiene task must exist");
  assert.deepEqual(pipeline.tasks.hygiene.dependsOn, ["build"]);
  assert.equal(pipeline.tasks.hygiene.steps[0].command, "async-hygiene check");
  assert.ok(pipeline.tasks.pack.dependsOn.includes("hygiene"), "pack must depend on the hidden hygiene gate");

  for (const taskId of ["actionlint", "package-lint", "depcruise", "knip"]) {
    assert.equal(pipeline.tasks[taskId], undefined, `${taskId} task must stay hidden inside @async/hygiene`);
    assert.equal(pipeline.tasks.pack.dependsOn.includes(taskId), false, `pack must not expose ${taskId}`);
    assert.equal(packageJson.scripts[`${taskId}:check`], undefined, `${taskId} script must stay hidden inside @async/hygiene`);
  }
});

test("PROMISE: generated sync checks wait for the built CLI before release packing", async () => {
  const { default: pipeline } = await import("../pipeline.ts");

  assert.deepEqual(
    pipeline.tasks["sync-check"].dependsOn,
    ["build"],
    "sync-check executes packages/pipeline-node/dist/cli.js and must not race the build output"
  );
  assert.ok(pipeline.tasks.pack.dependsOn.includes("sync-check"), "release pack gate must include generated sync drift checks");
});
