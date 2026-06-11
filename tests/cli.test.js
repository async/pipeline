import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { command, commandProxy, hostWorkspace, runPipelineCli } from "../packages/pipeline/dist/index.js";

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
  assert.deepEqual(explained.dependsOn, ["build"]);
});

test("runPipelineCli exposes CLI behavior without spawning a subprocess", async () => {
  let stdout = "";
  let stderr = "";
  const result = await runPipelineCli({
    args: ["list"],
    workspace: hostWorkspace({ cwd: repoRoot.pathname }),
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
    workspace: hostWorkspace({ cwd: repoRoot.pathname, commands }),
    stdout(text) {
      stdout += text;
    },
    stderr() {}
  });

  assert.equal(result.code, 0);
  assert.equal(stdout, "mock current\n");
  assert.equal(commands.records()[0]?.status, "mocked");
});

test("runPipelineCli validates named docker workspace before command-policy mock", async () => {
  const dir = mkdtempSync(join(tmpdir(), "async-pipeline-cli-workspace-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }), "utf8");
    writeFileSync(join(dir, "pipeline.js"), `
import { command, definePipeline, job, sh, task, workspace } from ${JSON.stringify(packageUrl)};

export default definePipeline({
  name: "fixture",
  workspaces: {
    docker: workspace.docker({ image: "node:24" })
  },
  commands: command.policy({
    rules: [
      command.rule({
        exact: ["async-pipeline", "run", "verify", "--workspace", "docker"],
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
      args: ["run", "verify", "--workspace", "docker"],
      workspace: hostWorkspace({ cwd: dir }),
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
