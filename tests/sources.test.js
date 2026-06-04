import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { loadPipeline, runJob } from "../packages/pipeline-node/dist/index.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const packageUrl = pathToFileURL(join(repoRoot, "packages/pipeline/dist/index.js")).href;
const cliPath = join(repoRoot, "packages/pipeline-node/dist/cli.js");

test("runs a path source task with root-owned dynamic prepare and cache reuse", async () => {
  const fixture = await createImpactFixture();
  try {
    const pipeline = await loadPipeline(join(fixture.root, "pipeline.js"));

    const first = await runJob(pipeline, { cwd: fixture.root, jobId: "verifyImpact" });
    assert.equal(first.status, "passed");
    assert.equal(first.sources?.app?.dir, fixture.app);
    assert.deepEqual(first.tasks.map((task) => task.id), ["app:prepare", "app:test", "impact"]);
    assert.equal(await readFile(join(fixture.app, "candidate.txt"), "utf8"), fixture.root);

    const second = await runJob(pipeline, { cwd: fixture.root, jobId: "verifyImpact" });
    assert.equal(second.status, "passed");
    assert.equal(second.tasks.find((task) => task.id === "app:test")?.status, "cached");
  } finally {
    await rm(fixture.parent, { force: true, recursive: true });
  }
});

test("CLI exposes metadata, matrix, source list, source sync, and namespaced run-task", async () => {
  const fixture = await createImpactFixture();
  try {
    const metadata = spawnSync("node", [cliPath, "metadata", "--format", "json"], {
      cwd: fixture.root,
      encoding: "utf8"
    });
    assert.equal(metadata.status, 0, metadata.stderr);
    assert.equal(existsSync(join(fixture.root, ".async")), false);
    assert.equal(JSON.parse(metadata.stdout).sources.app.type, "path");

    const matrix = spawnSync("node", [cliPath, "matrix", "verifyImpact", "--format", "github"], {
      cwd: fixture.root,
      encoding: "utf8"
    });
    assert.equal(matrix.status, 0, matrix.stderr);
    assert.deepEqual(JSON.parse(matrix.stdout).include.map((row) => row.task), ["app:test"]);

    const list = spawnSync("node", [cliPath, "sources", "list"], {
      cwd: fixture.root,
      encoding: "utf8"
    });
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /app\tpath/);
    assert.equal(existsSync(join(fixture.root, ".async")), false);

    const sync = spawnSync("node", [cliPath, "sources", "sync"], {
      cwd: fixture.root,
      encoding: "utf8"
    });
    assert.equal(sync.status, 0, sync.stderr);
    assert.match(sync.stdout, /app\t/);

    const runTask = spawnSync("node", [cliPath, "run-task", "app:test"], {
      cwd: fixture.root,
      encoding: "utf8"
    });
    assert.equal(runTask.status, 0, runTask.stderr);
    assert.match(runTask.stdout, /Task run passed/);
  } finally {
    await rm(fixture.parent, { force: true, recursive: true });
  }
});

async function createImpactFixture() {
  const parent = await mkdtemp(join(tmpdir(), "async-pipeline-impact-"));
  const root = join(parent, "design-system");
  const app = join(parent, "app");
  await mkdir(root, { recursive: true });
  await mkdir(app, { recursive: true });

  await writeFile(join(root, "pipeline.js"), `
import { definePipeline, job, sh, source, task } from ${JSON.stringify(packageUrl)};

export default definePipeline({
  name: "design-system",
  sources: {
    app: source.path({
      path: "../app",
      pipeline: "pipeline.js",
      writable: true,
      prepare: [
        sh\`node -e 'require("fs").writeFileSync("prepared.txt", "ready")'\`,
        sh((ctx) => sh\`node -e 'require("fs").writeFileSync("candidate.txt", \${JSON.stringify(ctx.candidate.dir)})'\`)
      ]
    })
  },
  tasks: {
    impact: task({
      dependsOn: ["app:test"],
      run: sh\`node -e 'console.log("impact complete")'\`
    })
  },
  jobs: {
    verifyImpact: job({ target: "impact" })
  }
});
`, "utf8");

  await writeFile(join(app, "pipeline.js"), `
import { definePipeline, job, sh, task } from ${JSON.stringify(packageUrl)};

export default definePipeline({
  name: "app",
  tasks: {
    test: task({
      inputs: ["candidate.txt"],
      cache: true,
      run: sh\`node -e 'const fs = require("fs"); if (!fs.existsSync("candidate.txt")) process.exit(1); console.log(fs.readFileSync("candidate.txt", "utf8"))'\`
    })
  },
  jobs: {
    verify: job({ target: "test" })
  }
});
`, "utf8");

  return { app, parent, root };
}
