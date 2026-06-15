import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { command, commandProxy, runPipelineCli } from "../packages/pipeline/dist/index.js";

const repoRoot = new URL("..", import.meta.url);
const packageUrl = pathToFileURL(join(repoRoot.pathname, "packages/pipeline/dist/index.js")).href;

test("pipeline list shows self job and tasks", () => {
  const result = spawnSync("node", ["packages/pipeline-node/dist/cli.js", "list"], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /verify/);
  assert.match(result.stdout, /typecheck/);
});

test("discovers pipeline config in ts, js, mjs, mts order", async () => {
  const dir = mkdtempSync(join(tmpdir(), "async-pipeline-cli-config-order-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }), "utf8");
    for (const [fileName, name] of [
      ["pipeline.ts", "ts"],
      ["pipeline.js", "js"],
      ["pipeline.mjs", "mjs"],
      ["pipeline.mts", "mts"]
    ]) {
      writeFileSync(join(dir, fileName), `
import { definePipeline, job, sh, task } from ${JSON.stringify(packageUrl)};

export default definePipeline({
  name: ${JSON.stringify(name)},
  tasks: { verify: task({ cache: false, run: sh\`true\` }) },
  jobs: { verify: job({ target: "verify" }) }
});
`, "utf8");
    }

    const readName = async () => {
      const result = await runPipelineCli({
        args: ["metadata", "--format", "json"],
        cwd: dir,
        stdout() {},
        stderr() {}
      });
      assert.equal(result.code, 0, result.stderr);
      return JSON.parse(result.stdout).name;
    };

    assert.equal(await readName(), "ts");
    unlinkSync(join(dir, "pipeline.ts"));
    assert.equal(await readName(), "js");
    unlinkSync(join(dir, "pipeline.js"));
    assert.equal(await readName(), "mjs");
    unlinkSync(join(dir, "pipeline.mjs"));
    assert.equal(await readName(), "mts");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

// Regression: the published bin (packages/pipeline/dist/cli.js) is a wrapper
// module around the internal CLI. The internal entrypoint guard compares
// argv[1] against its own module URL, so before runCliMain() was invoked
// explicitly from the wrapper, the public bin parsed nothing, printed
// nothing, and exited 0.
test("public package bin runs the CLI (direct and through a symlinked bin path)", () => {
  const direct = spawnSync("node", ["packages/pipeline/dist/cli.js", "list"], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  assert.equal(direct.status, 0, direct.stderr);
  assert.match(direct.stdout, /Jobs:/);
  assert.match(direct.stdout, /verify/);

  const dir = mkdtempSync(join(tmpdir(), "async-pipeline-cli-bin-"));
  try {
    const shim = join(dir, "async-pipeline");
    symlinkSync(join(repoRoot.pathname, "packages/pipeline/dist/cli.js"), shim);
    const viaSymlink = spawnSync("node", [shim, "list"], {
      cwd: repoRoot,
      encoding: "utf8"
    });

    assert.equal(viaSymlink.status, 0, viaSymlink.stderr);
    assert.match(viaSymlink.stdout, /Jobs:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pipeline graph emits JSON", () => {
  const result = spawnSync("node", ["packages/pipeline-node/dist/cli.js", "graph", "--format", "json"], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const graph = JSON.parse(result.stdout);
  assert.ok(Array.isArray(graph.tasks));
  assert.ok(graph.executionOrder.includes("pack"));
});

test("pipeline explain emits task details", () => {
  const result = spawnSync("node", ["packages/pipeline-node/dist/cli.js", "explain", "pack"], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const explained = JSON.parse(result.stdout);
  assert.deepEqual(explained.dependsOn, [
    "test",
    "drift",
    "claims",
    "docs",
    "api-surface",
    "sync-check",
    "examples",
    "hygiene"
  ]);
});

test("runPipelineCli exposes CLI behavior without spawning a subprocess", async () => {
  let stdout = "";
  let stderr = "";
  const result = await runPipelineCli({
    args: ["list"],
    ...({ cwd: repoRoot.pathname }),
    stdout(text) {
      stdout += text;
    },
    stderr(text) {
      stderr += text;
    }
  });

  assert.equal(result.code, 0);
  assert.equal(stderr, "");
  assert.match(stdout, /verify/);
  assert.match(stdout, /typecheck/);
});

test("runPipelineCli can mock a CLI command through workspace commands", async () => {
  let stdout = "";
  const commands = commandProxy(command.policy({
    rules: [
      command.rule({
        exact: ["async-pipeline", "github", "check"],
        action: command.mock({ code: 0, stdout: "mock current\n" })
      })
    ],
    record: true
  }));

  const result = await runPipelineCli({
    args: ["github", "check"],
    ...({ cwd: repoRoot.pathname, commands }),
    stdout(text) {
      stdout += text;
    },
    stderr() {}
  });

  assert.equal(result.code, 0);
  assert.equal(stdout, "mock current\n");
  assert.equal(commands.records()[0]?.status, "mocked");
});

test("run prints failed task reasons to stderr next to the final status", async () => {
  const dir = mkdtempSync(join(tmpdir(), "async-pipeline-cli-fail-reason-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }), "utf8");
    writeFileSync(join(dir, "pipeline.js"), `
import { definePipeline, job, sh, task } from ${JSON.stringify(packageUrl)};

export default definePipeline({
  name: "fixture",
  tasks: {
    boom: task({ cache: false, run: sh\`exit 7\` })
  },
  jobs: {
    verify: job({ target: "boom" })
  }
});
`, "utf8");

    let stdout = "";
    let stderr = "";
    const result = await runPipelineCli({
      args: ["run", "verify"],
      ...({ cwd: dir }),
      stdout(text) {
        stdout += text;
      },
      stderr(text) {
        stderr += text;
      }
    });

    assert.equal(result.code, 1);
    assert.match(stdout, /Pipeline failed/);
    assert.match(stderr, /Task boom failed: .*exit code 7/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("run-task dry-run accepts local and source task group ids", async () => {
  const parent = mkdtempSync(join(tmpdir(), "async-pipeline-cli-groups-"));
  const root = join(parent, "root");
  const app = join(parent, "app");
  try {
    writeFileSync(join(parent, "package.json"), JSON.stringify({ type: "module" }), "utf8");
    mkdirSync(root, { recursive: true });
    mkdirSync(app, { recursive: true });
    writeFileSync(join(root, "pipeline.js"), `
import { definePipeline, job, sh, source, task } from ${JSON.stringify(packageUrl)};

export default definePipeline({
  name: "root",
  sources: {
    app: source.path({ path: "../app", pipeline: "pipeline.js" })
  },
  tasks: {
    claims: {
      default: task({ cache: false, run: sh\`echo claims\` }),
      report: task({ cache: false, run: sh\`echo report\` })
    }
  },
  jobs: {
    verify: job({ target: "claims" })
  }
});
`, "utf8");
    writeFileSync(join(app, "pipeline.js"), `
import { definePipeline, job, sh, task } from ${JSON.stringify(packageUrl)};

export default definePipeline({
  name: "app",
  tasks: {
    claims: {
      default: task({ cache: false, run: sh\`echo app claims\` }),
      report: task({ cache: false, run: sh\`echo app report\` })
    }
  },
  jobs: {
    verify: job({ target: "claims.report" })
  }
});
`, "utf8");

    for (const taskId of ["claims", "claims.report", "app:claims.report"]) {
      let stdout = "";
      let stderr = "";
      const result = await runPipelineCli({
        args: ["run-task", taskId, "--dry-run"],
        ...({ cwd: root }),
        stdout(text) {
          stdout += text;
        },
        stderr(text) {
          stderr += text;
        }
      });

      assert.equal(result.code, 0, stderr);
      assert.match(stdout, new RegExp(taskId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  } finally {
    rmSync(parent, { force: true, recursive: true });
  }
});

test("runPipelineCli validates concurrency for run commands", async () => {
  const dir = mkdtempSync(join(tmpdir(), "async-pipeline-cli-concurrency-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }), "utf8");
    writeFileSync(join(dir, "pipeline.js"), `
import { definePipeline, job, task } from ${JSON.stringify(packageUrl)};

export default definePipeline({
  name: "fixture",
  tasks: {
    verify: task({ run() {} })
  },
  jobs: {
    verify: job({ target: "verify" })
  }
});
`, "utf8");

    let stderr = "";
    const result = await runPipelineCli({
      args: ["run", "verify", "--concurrency", "0"],
      ...({ cwd: dir }),
      stdout() {},
      stderr(text) {
        stderr += text;
      }
    });

    assert.equal(result.code, 1);
    assert.match(stderr, /Task concurrency must be a positive integer/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("runPipelineCli validates named docker sandbox before command-policy mock", async () => {
  const dir = mkdtempSync(join(tmpdir(), "async-pipeline-cli-workspace-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }), "utf8");
    writeFileSync(join(dir, "pipeline.js"), `
import { command, definePipeline, job, sh, task, sandbox } from ${JSON.stringify(packageUrl)};

export default definePipeline({
  name: "fixture",
  sandboxes: {
    docker: sandbox.docker({ image: "node:24" })
  },
  commands: command.policy({
    rules: [
      command.rule({
        exact: ["async-pipeline", "run", "verify", "--sandbox", "docker"],
        action: command.mock({ code: 0, stdout: "mock docker run\\n" })
      })
    ],
    record: true
  }),
  tasks: {
    verify: task({ run: sh\`node -e 'process.exit(9)'\` })
  },
  jobs: {
    verify: job({ target: "verify" })
  }
});
`, "utf8");

    let stdout = "";
    const result = await runPipelineCli({
      args: ["run", "verify", "--sandbox", "docker"],
      ...({ cwd: dir }),
      stdout(text) {
        stdout += text;
      },
      stderr() {}
    });

    assert.equal(result.code, 0);
    assert.equal(stdout, "mock docker run\n");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("runPipelineCli validates execution profiles before command-policy mock", async () => {
  const dir = mkdtempSync(join(tmpdir(), "async-pipeline-cli-execution-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }), "utf8");
    writeFileSync(join(dir, "pipeline.js"), `
import { command, definePipeline, execution, job, sandbox, sh, task } from ${JSON.stringify(packageUrl)};

export default definePipeline({
  name: "fixture",
  sandboxes: {
    node24: sandbox.container({ image: "node:24" })
  },
  execution: {
    local: execution.local({ sandbox: "node24", provider: "docker" })
  },
  commands: command.policy({
    rules: [
      command.rule({
        exact: ["async-pipeline", "run", "verify", "--execution", "local", "--provider", "docker"],
        action: command.mock({ code: 0, stdout: "mock execution run\\n" })
      })
    ],
    record: true
  }),
  tasks: {
    verify: task({ run: sh\`node -e 'process.exit(9)'\` })
  },
  jobs: {
    verify: job({ target: "verify" })
  }
});
`, "utf8");

    let stdout = "";
    const result = await runPipelineCli({
      args: ["run", "verify", "--execution", "local", "--provider", "docker"],
      ...({ cwd: dir }),
      stdout(text) {
        stdout += text;
      },
      stderr() {}
    });

    assert.equal(result.code, 0);
    assert.equal(stdout, "mock execution run\n");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("cache clear and gc maintain local pipeline state", async () => {
  const { mkdtemp, mkdir, writeFile, readdir, rm, utimes } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { runPipelineCli } = await import("../packages/pipeline-node/dist/cli.js");

  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-cli-gc-"));
  try {
    // Minimal valid pipeline config for CLI maintenance commands.
    await writeFile(join(dir, "pipeline.mjs"), [
      `import { definePipeline, job, sh, task } from ${JSON.stringify(new URL("../packages/pipeline-core/dist/index.js", import.meta.url).href)};`,
      "export default definePipeline({",
      '  name: "gc-test",',
      "  tasks: { noop: task({ cache: false, run: sh`node -e \"process.exit(0)\"` }) },",
      "  jobs: { noop: job({ target: \"noop\" }) }",
      "});",
      ""
    ].join("\n"), "utf8");

    await mkdir(join(dir, ".async", "cache", "tasks", "deadbeef"), { recursive: true });
    for (const runId of ["2026-01-01T00-00-00-000Z-aaaaaaaa", "2026-01-02T00-00-00-000Z-bbbbbbbb", "2026-01-03T00-00-00-000Z-cccccccc"]) {
      await mkdir(join(dir, ".async", "runs", runId), { recursive: true });
    }
    const target = ({ cwd: dir, env: { PATH: process.env.PATH } });

    let stdout = "";
    const clear = await runPipelineCli({ args: ["cache", "clear"], ...target, stdout: (t) => { stdout += t; }, stderr: () => {} });
    assert.equal(clear.code, 0, stdout);
    assert.match(stdout, /Cleared task cache/);
    assert.deepEqual(await readdir(join(dir, ".async", "cache")).catch(() => []), []);

    const staleCacheFile = join(dir, ".async", "cache", "tasks", "stale", "result.json");
    await mkdir(join(dir, ".async", "cache", "tasks", "stale"), { recursive: true });
    await writeFile(staleCacheFile, "{}\n", "utf8");
    const old = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000);
    await utimes(staleCacheFile, old, old);

    stdout = "";
    const gc = await runPipelineCli({ args: ["gc", "--keep", "1", "--cache-days", "30"], ...target, stdout: (t) => { stdout += t; }, stderr: () => {} });
    assert.equal(gc.code, 0, stdout);
    assert.match(stdout, /Removed 2 run records; kept 1/);
    assert.match(stdout, /Removed 1 cache entry unused for 30\+ days/);
    assert.deepEqual(await readdir(join(dir, ".async", "runs")), ["2026-01-03T00-00-00-000Z-cccccccc"]);
    assert.deepEqual(await readdir(join(dir, ".async", "cache", "tasks")).catch(() => []), []);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("doctor warns about stale running run records", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { runPipelineCli } = await import("../packages/pipeline-node/dist/cli.js");

  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-cli-doctor-"));
  try {
    const runDir = join(dir, ".async", "runs", "2026-01-01T00-00-00-000Z-deadbeef");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "execution.json"), `${JSON.stringify({
      schemaVersion: 1,
      id: "2026-01-01T00-00-00-000Z-deadbeef",
      pipelineName: "fixture",
      jobId: "verify",
      cwd: dir,
      pid: 99999999,
      startedAt: new Date().toISOString(),
      status: "running",
      mode: "manual",
      tasks: []
    }, null, 2)}\n`, "utf8");

    let stdout = "";
    const result = await runPipelineCli({
      args: ["doctor"],
      ...({ cwd: dir, env: { PATH: process.env.PATH } }),
      stdout: (text) => { stdout += text; },
      stderr: () => {}
    });

    assert.equal(result.code, 0, stdout);
    assert.match(stdout, /WARN runs: Crashed runs detected/);
    assert.match(stdout, /record\(s\) stuck in "running" from a dead process/);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("run auto-prunes records, emits json, and finds config from subdirectories", async () => {
  const { mkdtemp, mkdir, writeFile, readdir, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { runPipelineCli } = await import("../packages/pipeline-node/dist/cli.js");

  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-cli-polish-"));
  try {
    await writeFile(join(dir, "pipeline.mjs"), [
      `import { definePipeline, job, sh, task } from ${JSON.stringify(new URL("../packages/pipeline-core/dist/index.js", import.meta.url).href)};`,
      "export default definePipeline({",
      '  name: "polish-test",',
      "  tasks: { noop: task({ cache: false, run: sh`node -e \"process.exit(0)\"` }) },",
      '  jobs: { noop: job({ target: "noop" }) }',
      "});",
      ""
    ].join("\n"), "utf8");
    await mkdir(join(dir, "nested", "deeper"), { recursive: true });

    // Config walk-up: run from a nested cwd, json output, keep only 1 run.
    const env = { PATH: process.env.PATH, ASYNC_PIPELINE_KEEP_RUNS: "1" };
    let stdout = "";
    const first = await runPipelineCli({
      args: ["run", "noop", "--format", "json"],
      ...({ cwd: join(dir, "nested", "deeper"), env }),
      stdout: (t) => { stdout += t; },
      stderr: () => {}
    });
    assert.equal(first.code, 0, first.stderr);
    const record = JSON.parse(stdout);
    assert.equal(record.status, "passed");
    assert.equal(record.tasks[0]?.id, "noop");

    const second = await runPipelineCli({
      args: ["run", "noop"],
      ...({ cwd: join(dir, "nested", "deeper"), env }),
      stdout: () => {},
      stderr: () => {}
    });
    assert.equal(second.code, 0);
    const runs = await readdir(join(dir, ".async", "runs"));
    assert.equal(runs.length, 1, `auto-prune should keep exactly 1 run, saw: ${runs.join(", ")}`);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("run --format json suppresses live task output on stdout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "async-pipeline-cli-json-"));
  try {
    writeFileSync(join(dir, "pipeline.mjs"), [
      `import { definePipeline, job, sh, task } from ${JSON.stringify(packageUrl)};`,
      "export default definePipeline({",
      '  name: "json-output-test",',
      "  tasks: { noisy: task({ cache: false, run: sh`printf \"task-noise\\n\"` }) },",
      '  jobs: { noisy: job({ target: "noisy" }) }',
      "});",
      ""
    ].join("\n"));

    const result = spawnSync("node", [join(repoRoot.pathname, "packages/pipeline-node/dist/cli.js"), "run", "noisy", "--format", "json"], {
      cwd: dir,
      encoding: "utf8"
    });

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /task-noise/);
    const record = JSON.parse(result.stdout);
    assert.equal(record.status, "passed");
    assert.equal(record.tasks[0]?.id, "noisy");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
