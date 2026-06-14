import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { definePipeline, job, sh, task } from "../packages/pipeline-core/dist/index.js";
import { checkTaskSync, renderTaskSync, writeTaskSync } from "../packages/pipeline-node/dist/index.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const packageUrl = pathToFileURL(join(repoRoot, "packages/pipeline/dist/index.js")).href;
const cliPath = join(repoRoot, "packages/pipeline-node/dist/cli.js");

test("renders package scripts for synced jobs and opt-in raw tasks", async () => {
  const dir = mkdtempSyncCompat("async-pipeline-sync-package-");
  try {
    writeJson(join(dir, "package.json"), { name: "fixture", type: "module", scripts: {} });
    const pipeline = definePipeline({
      name: "test",
      sync: {
        tasks: {
          prefix: "ci",
          runners: ["package"],
          targets: "root",
          jobs: ["verify"],
          tasks: ["typecheck"],
          scripts: {
            "sync:check": "sync check"
          }
        }
      },
      tasks: {
        typecheck: task({ run: sh`echo typecheck` }),
        test: task({ dependsOn: ["typecheck"], run: sh`echo test` })
      },
      jobs: {
        verify: job({ target: "test" })
      }
    });

    const rendered = await renderTaskSync(pipeline, { cwd: dir, configPath: join(dir, "pipeline.ts") });
    assert.deepEqual(rendered.manifests.map((entry) => entry.path), ["package.json"]);
    assert.deepEqual(rendered.manifests[0].commands, [
      { name: "ci:verify", value: "async-pipeline run verify" },
      { name: "ci:task:typecheck", value: "async-pipeline run-task typecheck" },
      { name: "ci:sync:check", value: "async-pipeline sync check" }
    ]);

    await writeTaskSync(rendered, dir);
    const packageJson = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    assert.equal(packageJson.scripts["ci:verify"], "async-pipeline run verify");
    assert.equal(packageJson.scripts["ci:task:typecheck"], "async-pipeline run-task typecheck");
    assert.equal(packageJson.scripts["ci:sync:check"], "async-pipeline sync check");
    assert.equal(existsSync(join(dir, ".async-pipeline/tasks.lock.json")), true);
    assert.deepEqual(await checkTaskSync(rendered, dir), []);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("renders opt-in raw task scripts for flattened task group ids", async () => {
  const dir = mkdtempSyncCompat("async-pipeline-sync-groups-");
  try {
    writeJson(join(dir, "package.json"), { name: "fixture", type: "module", scripts: {} });
    const pipeline = definePipeline({
      name: "test",
      sync: {
        tasks: {
          prefix: "pipeline",
          runners: ["package"],
          targets: "root",
          jobs: [],
          tasks: ["claims", "claims.report"]
        }
      },
      tasks: {
        claims: {
          default: task({ run: sh`echo claims` }),
          report: task({ run: sh`echo report` })
        }
      },
      jobs: {
        verify: job({ target: "claims" })
      }
    });

    const rendered = await renderTaskSync(pipeline, { cwd: dir, configPath: join(dir, "pipeline.ts") });

    assert.deepEqual(rendered.manifests[0].commands, [
      { name: "pipeline:task:claims", value: "async-pipeline run-task claims" },
      { name: "pipeline:task:claims.report", value: "async-pipeline run-task claims.report" }
    ]);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("sync.tasks true syncs jobs only to root package scripts", async () => {
  const dir = mkdtempSyncCompat("async-pipeline-sync-defaults-");
  try {
    writeJson(join(dir, "package.json"), { name: "fixture", type: "module", scripts: {} });
    const pipeline = definePipeline({
      name: "test",
      sync: {
        tasks: true
      },
      tasks: {
        typecheck: task({ run: sh`echo typecheck` })
      },
      jobs: {
        verify: job({ target: "typecheck" })
      }
    });

    const rendered = await renderTaskSync(pipeline, { cwd: dir, configPath: join(dir, "pipeline.ts") });

    assert.deepEqual(rendered.manifests[0].commands, [
      { name: "pipeline:verify", value: "async-pipeline run verify" }
    ]);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("renders deno tasks for explicit path targets", async () => {
  const dir = mkdtempSyncCompat("async-pipeline-sync-deno-");
  try {
    mkdirSync(join(dir, "tools/worker"), { recursive: true });
    writeJson(join(dir, "tools/worker/deno.json"), { tasks: {} });
    const pipeline = definePipeline({
      name: "test",
      sync: {
        tasks: {
          runners: ["deno"],
          targets: [{ path: "tools/worker/deno.json" }],
          jobs: ["verify"]
        }
      },
      tasks: {
        test: task({ run: sh`echo test` })
      },
      jobs: {
        verify: job({ target: "test" })
      }
    });

    const rendered = await renderTaskSync(pipeline, { cwd: dir, configPath: join(dir, "pipeline.ts") });
    await writeTaskSync(rendered, dir);
    const denoJson = JSON.parse(readFileSync(join(dir, "tools/worker/deno.json"), "utf8"));
    assert.equal(denoJson.tasks["pipeline:verify"], "async-pipeline run verify");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("resolves package-name targets and rejects unmanaged conflicts", async () => {
  const dir = mkdtempSyncCompat("async-pipeline-sync-targets-");
  try {
    mkdirSync(join(dir, "packages/app"), { recursive: true });
    writeJson(join(dir, "package.json"), { name: "root", scripts: {} });
    writeJson(join(dir, "packages/app/package.json"), {
      name: "@acme/app",
      scripts: {
        "pipeline:verify": "echo unmanaged"
      }
    });
    const pipeline = definePipeline({
      name: "test",
      sync: {
        tasks: {
          runners: ["package"],
          targets: [{ package: "@acme/app" }],
          jobs: ["verify"]
        }
      },
      tasks: {
        test: task({ run: sh`echo test` })
      },
      jobs: {
        verify: job({ target: "test" })
      }
    });

    const rendered = await renderTaskSync(pipeline, { cwd: dir, configPath: join(dir, "pipeline.ts") });
    assert.equal(rendered.manifests[0].path, "packages/app/package.json");
    await assert.rejects(() => writeTaskSync(rendered, dir), (error) => error.code === "ASYNC_PIPELINE_SYNC_CONFLICT");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("detects stale synced task manifests and locks", async () => {
  const dir = mkdtempSyncCompat("async-pipeline-sync-stale-");
  try {
    writeJson(join(dir, "package.json"), { name: "fixture", scripts: {} });
    const pipeline = definePipeline({
      name: "test",
      sync: {
        tasks: true
      },
      tasks: {
        test: task({ run: sh`echo test` })
      },
      jobs: {
        verify: job({ target: "test" })
      }
    });
    const rendered = await renderTaskSync(pipeline, { cwd: dir, configPath: join(dir, "pipeline.ts") });
    await writeTaskSync(rendered, dir);
    const packageJson = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    packageJson.scripts["pipeline:verify"] = "echo stale";
    writeJson(join(dir, "package.json"), packageJson);

    const issues = await checkTaskSync(rendered, dir);
    assert.equal(issues.some((issue) => issue.includes("pipeline:verify")), true);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("sync CLI generates and checks configured targets", () => {
  const dir = mkdtempSyncCompat("async-pipeline-sync-cli-");
  try {
    writeJson(join(dir, "package.json"), {
      type: "module",
      packageManager: "pnpm@10.20.0",
      scripts: {
        "async-pipeline": `node ${JSON.stringify(cliPath)}`
      }
    });
    writeFileSync(join(dir, "pipeline.js"), `
import { definePipeline, job, sh, task, trigger } from ${JSON.stringify(packageUrl)};

export default definePipeline({
  name: "fixture",
  triggers: {
    main: trigger.github({ events: ["push"], branches: ["main"] })
  },
  sync: {
    github: true,
    tasks: true
  },
  tasks: {
    verify: task({ run: sh\`node -e 'console.log("ok")'\` })
  },
  jobs: {
    verify: job({ target: "verify", trigger: ["main"] })
  }
});
`, "utf8");

    const generate = spawnSync("node", [cliPath, "sync", "generate"], { cwd: dir, encoding: "utf8" });
    assert.equal(generate.status, 0, generate.stderr);
    assert.equal(existsSync(join(dir, ".github/workflows/async-pipeline.yml")), true);
    assert.equal(existsSync(join(dir, ".github/async-pipeline.lock.json")), true);
    assert.equal(existsSync(join(dir, ".async-pipeline/tasks.lock.json")), true);

    const check = spawnSync("node", [cliPath, "sync", "check"], { cwd: dir, encoding: "utf8" });
    assert.equal(check.status, 0, check.stderr);

    const tasksCheck = spawnSync("node", [cliPath, "sync", "tasks", "check"], { cwd: dir, encoding: "utf8" });
    assert.equal(tasksCheck.status, 0, tasksCheck.stderr);

    const githubCheck = spawnSync("node", [cliPath, "sync", "github", "check"], { cwd: dir, encoding: "utf8" });
    assert.equal(githubCheck.status, 0, githubCheck.stderr);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function mkdtempSyncCompat(prefix) {
  const dir = join(tmpdir(), `${prefix}${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
