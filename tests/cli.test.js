import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
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

test("github plan and run expose local generated job manifests through the CLI", async () => {
  const dir = mkdtempSync(join(tmpdir(), "async-pipeline-cli-github-plan-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module", private: true, packageManager: "pnpm@11.1.0" }), "utf8");
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    writeFileSync(join(dir, "pipeline.js"), `
import { definePipeline, job, sh, task, trigger } from ${JSON.stringify(packageUrl)};

export default definePipeline({
  name: "fixture",
  sync: { github: { evidence: true } },
  triggers: {
    pr: trigger.github({ events: ["pull_request"] })
  },
  tasks: {
    verify: task({ run: sh\`echo verify\` })
  },
  jobs: {
    verify: job({
      target: "verify",
      trigger: ["pr"],
      github: { runsOnMatrix: ["ubuntu-latest", "macos-latest"] }
    })
  }
});
`, "utf8");

    let stdout = "";
    let stderr = "";
    const plan = await runPipelineCli({
      args: ["github", "plan", "--job", "verify", "--event", "pull_request", "--event-action", "opened", "--format", "json"],
      ...({ cwd: dir, env: { PATH: process.env.PATH } }),
      stdout(text) {
        stdout += text;
      },
      stderr(text) {
        stderr += text;
      }
    });

    assert.equal(plan.code, 0, stderr);
    const planJson = JSON.parse(stdout);
    assert.equal(planJson.version, 1);
    assert.equal(planJson.event.name, "pull_request");
    assert.equal(planJson.manifests[0].job.id, "verify");
    assert.equal(planJson.manifests[0].job.matrix.length, 2);
    assert.ok(planJson.manifests[0].steps.some((entry) => entry.local.contract === "run"));

    stdout = "";
    stderr = "";
    const envPlan = await runPipelineCli({
      args: ["github", "plan", "--job", "verify", "--format", "json"],
      ...({ cwd: dir, env: { PATH: process.env.PATH, GITHUB_EVENT_NAME: "pull_request" } }),
      stdout(text) {
        stdout += text;
      },
      stderr(text) {
        stderr += text;
      }
    });

    assert.equal(envPlan.code, 0, stderr);
    assert.equal(JSON.parse(stdout).event.name, "pull_request");

    stdout = "";
    stderr = "";
    const run = await runPipelineCli({
      args: ["github", "run", "--job", "verify", "--event", "pull_request", "--format", "json"],
      ...({ cwd: dir, env: { PATH: process.env.PATH } }),
      stdout(text) {
        stdout += text;
      },
      stderr(text) {
        stderr += text;
      }
    });

    assert.equal(run.code, 0, stderr);
    const runJson = JSON.parse(stdout);
    assert.equal(runJson.status, "passed");
    assert.equal(runJson.plan.host, "github");
    assert.equal(runJson.plan.eventEnvelope.event, "pull_request");
    assert.equal(runJson.plan.workflowJobs[0].id, "verify");
    assert.equal(existsSync(join(dir, runJson.planPath)), true);
    assert.equal(runJson.receipts[0].job, "verify");
    assert.equal(runJson.receipts[0].network, "mock");
    assert.equal(existsSync(join(dir, runJson.receipts[0].manifestPath)), true);
    assert.equal(existsSync(join(dir, ".async/github-local/jobs/verify/receipt.json")), true);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("cloudflare plan and mock run expose shared workflow event and receipt vocabulary", async () => {
  const dir = mkdtempSync(join(tmpdir(), "async-pipeline-cli-cloudflare-plan-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module", private: true, packageManager: "pnpm@11.1.0" }), "utf8");
    mkdirSync(join(dir, ".async", "pages"), { recursive: true });
    writeFileSync(join(dir, ".async", "pages", "index.html"), "<h1>preview</h1>\n", "utf8");
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "dist", "worker.js"), "export default {};\n", "utf8");
    writeFileSync(join(dir, "pipeline.js"), `
import { cloudflare, definePipeline, execution, github, job, sh, task, trigger } from ${JSON.stringify(packageUrl)};

export default definePipeline({
  name: "fixture",
  sync: {
    cloudflare: {
      worker: "fixture-ci",
      queue: "fixture-events",
      workflow: "preview",
      bridge: { mode: "github-actions" }
    }
  },
  execution: {
    cloudflare: execution.cloudflare({
      runner: { image: "node:24", packageManager: "pnpm" }
    })
  },
  triggers: {
    pr: trigger.github({ events: ["pull_request"] }),
    push: trigger.github({ events: ["push"] })
  },
  tasks: {
    "docs.site": task({
      outputs: [".async/pages/**"],
      run: sh\`echo docs\`
    }),
    "worker.bundle": task({
      outputs: ["dist/worker.js"],
      run: sh\`echo worker\`
    })
  },
  jobs: {
    preview: job({
      target: "docs.site",
      trigger: ["pr"],
      execution: "cloudflare",
      deploy: cloudflare.pages({
        project: "site",
        directory: ".async/pages"
      }),
      report: github.prPreview()
    }),
    silentPreview: job({
      target: "docs.site",
      trigger: ["pr"],
      execution: "cloudflare",
      deploy: cloudflare.pages({
        project: "site",
        directory: ".async/pages",
        productionBranch: "main"
      }),
      report: github.prPreview({ comment: false })
    }),
    workerPreview: job({
      target: "worker.bundle",
      trigger: ["push"],
      execution: "cloudflare",
      deploy: cloudflare.worker({
        script: "dist/worker.js",
        alias: "edge-preview",
        productionBranch: "main"
      }),
      report: github.deployment({ environment: "production" })
    })
  }
});
`, "utf8");

    let stdout = "";
    let stderr = "";
    const plan = await runPipelineCli({
      args: ["cloudflare", "plan", "--job", "preview", "--source", "github", "--event", "pull_request", "--repository", "async/pipeline", "--head-repo", "async/pipeline", "--installation-id", "123", "--pr-number", "42", "--head-sha", "abc123", "--ref", "refs/pull/42/head", "--branch", "main", "--same-repository", "true", "--format", "json"],
      ...({ cwd: dir, env: { PATH: process.env.PATH } }),
      stdout(text) {
        stdout += text;
      },
      stderr(text) {
        stderr += text;
      }
    });

    assert.equal(plan.code, 0, stderr);
    const planJson = JSON.parse(stdout);
    assert.equal(planJson.host, "cloudflare");
    assert.equal(planJson.event.source, "github");
    assert.equal(planJson.event.event, "pull_request");
    assert.equal(planJson.event.pullRequest.number, 42);
    assert.equal(planJson.jobs[0].id, "preview");
    assert.equal(planJson.jobs[0].idempotencyKey, "fixture/preview/pull_request/abc123");
    assert.deepEqual(planJson.jobs[0].lifecycle, ["plan", "run", "deploy", "report", "record"]);
    assert.equal(planJson.jobs[0].trust.writeCredentials, true);
    assert.deepEqual(planJson.jobs[0].effects.map((effect) => effect.kind), ["deploy", "report"]);
    assert.equal(planJson.sync.capabilityManifest.runner.image, "node:24");
    assert.equal(planJson.sync.capabilityManifest.runner.packageManager, "pnpm");
    assert.equal(planJson.sync.capabilityManifest.jobs[0].command, "async-pipeline run preview --execution cloudflare");
    assert.deepEqual(planJson.sync.capabilityManifest.jobs[0].permissions, ["runner.exec", "github.report", "cloudflare.deploy", "artifacts.readWrite"]);
    assert.equal(planJson.sync.jobs[0].runner.mockAvailable, true);
    assert.equal(planJson.sync.jobs[0].runner.evidence.cacheNamespace, "async-pipeline");
    assert.equal(planJson.sync.apply.mode, "external");
    assert.equal(planJson.sync.apply.command, "wrangler deploy --config .cloudflare/pipeline/wrangler.jsonc");
    assert.equal(planJson.bridge.enabled, true);
    assert.equal(planJson.bridge.mode, "github-actions");
    assert.equal(planJson.bridge.queueMessage.owner, "async");
    assert.equal(planJson.bridge.queueMessage.repo, "pipeline");
    assert.equal(planJson.bridge.queueMessage.sha, "abc123");
    assert.equal(planJson.bridge.queueMessage.pullRequest.headRepoFullName, "async/pipeline");
    assert.equal(planJson.bridge.queueMessage.pullRequest.sameRepository, true);
    assert.equal(planJson.bridge.queueMessage.installationId, 123);
    assert.equal(JSON.stringify(planJson.bridge.queueMessage).includes("TOKEN"), false);
    assert.equal(planJson.bridge.reports[0].result.status, "queued");
    assert.equal(planJson.bridge.reports[0].result.preview.kind, "pages");
    assert.equal(planJson.bridge.reports[0].result.preview.environment, "preview");
    assert.equal(planJson.bridge.reports[0].result.preview.urlAlias, "site");
    assert.equal(planJson.bridge.reports[0].github.check.externalId, "fixture/preview/pull_request/abc123/check");
    assert.equal(planJson.bridge.reports[0].github.deployment.environment, "preview");
    assert.equal(planJson.bridge.reports[0].github.deployment.kind, "pages");
    assert.equal(planJson.bridge.reports[0].github.deployment.sourcePath, ".async/pages");
    assert.equal(planJson.bridge.reports[0].github.deployment.transientEnvironment, true);
    assert.equal(planJson.bridge.reports[0].github.prComment.marker, "async-pipeline-preview:preview");

    stdout = "";
    stderr = "";
    const silentPlan = await runPipelineCli({
      args: ["cloudflare", "plan", "--job", "silentPreview", "--source", "github", "--event", "pull_request", "--repository", "async/pipeline", "--head-repo", "async/pipeline", "--installation-id", "123", "--pr-number", "43", "--head-sha", "abc124", "--ref", "refs/pull/43/head", "--branch", "main", "--same-repository", "true", "--format", "json"],
      ...({ cwd: dir, env: { PATH: process.env.PATH } }),
      stdout(text) {
        stdout += text;
      },
      stderr(text) {
        stderr += text;
      }
    });
    assert.equal(silentPlan.code, 0, stderr);
    const silentPlanJson = JSON.parse(stdout);
    assert.equal(silentPlanJson.bridge.reports[0].result.preview.environment, "preview");
    assert.equal(silentPlanJson.bridge.reports[0].github.prComment, undefined);

    stdout = "";
    stderr = "";
    const workerPlan = await runPipelineCli({
      args: ["cloudflare", "plan", "--job", "workerPreview", "--source", "github", "--event", "push", "--repository", "async/pipeline", "--sha", "def456", "--ref", "refs/heads/main", "--branch", "main", "--format", "json"],
      ...({ cwd: dir, env: { PATH: process.env.PATH } }),
      stdout(text) {
        stdout += text;
      },
      stderr(text) {
        stderr += text;
      }
    });
    assert.equal(workerPlan.code, 0, stderr);
    const workerPlanJson = JSON.parse(stdout);
    assert.equal(workerPlanJson.jobs[0].id, "workerPreview");
    assert.equal(workerPlanJson.bridge.reports[0].result.preview.kind, "worker");
    assert.equal(workerPlanJson.bridge.reports[0].result.preview.environment, "production");
    assert.equal(workerPlanJson.bridge.reports[0].result.preview.urlAlias, "edge-preview");
    assert.equal(workerPlanJson.bridge.reports[0].github.deployment.environment, "production");
    assert.equal(workerPlanJson.bridge.reports[0].github.deployment.kind, "worker");
    assert.equal(workerPlanJson.bridge.reports[0].github.deployment.sourcePath, "dist/worker.js");
    assert.equal(workerPlanJson.bridge.reports[0].github.deployment.transientEnvironment, false);
    assert.equal(workerPlanJson.bridge.reports[0].github.prComment, undefined);

    stdout = "";
    stderr = "";
    const run = await runPipelineCli({
      args: ["cloudflare", "run", "--job", "preview", "--source", "github", "--event", "pull_request", "--repository", "async/pipeline", "--head-repo", "patrick/fork", "--installation-id", "123", "--pr-number", "42", "--head-sha", "abc123", "--ref", "refs/pull/42/head", "--branch", "main", "--same-repository", "false", "--mode", "mock", "--format", "json"],
      ...({ cwd: dir, env: { PATH: process.env.PATH } }),
      stdout(text) {
        stdout += text;
      },
      stderr(text) {
        stderr += text;
      }
    });

    assert.equal(run.code, 0, stderr);
    const runJson = JSON.parse(stdout);
    assert.equal(runJson.status, "passed");
    assert.equal(runJson.receipts[0].job, "preview");
    assert.equal(runJson.receipts[0].trust.writeCredentials, false);
    assert.deepEqual(runJson.receipts[0].effects.map((effect) => effect.status), ["skipped_untrusted", "skipped_untrusted"]);
    assert.equal(runJson.receipts[0].effects[0].sourcePath, ".async/pages");
    assert.equal(runJson.receipts[0].effects[0].sourceExists, true);
    assert.equal(runJson.receipts[0].effects[0].preview.kind, "pages");
    assert.equal(runJson.receipts[0].effects[0].preview.environment, "preview");
    assert.equal(runJson.bridge.eventPath, ".async/cloudflare-local/bridge/event.json");
    assert.equal(runJson.bridge.reports[0].resultPath, ".async/cloudflare-local/jobs/preview/result.json");
    assert.equal(runJson.bridge.reports[0].reportPath, ".async/cloudflare-local/jobs/preview/github-report.json");
    assert.equal(runJson.runner.plans[0].path, ".async/cloudflare-local/jobs/preview/runner.json");
    assert.equal(existsSync(join(dir, ".async/cloudflare-local/jobs/preview/plan.json")), true);
    assert.equal(existsSync(join(dir, ".async/cloudflare-local/jobs/preview/deploy.json")), true);
    assert.equal(existsSync(join(dir, ".async/cloudflare-local/jobs/preview/report.json")), true);
    assert.equal(existsSync(join(dir, ".async/cloudflare-local/jobs/preview/runner.json")), true);
    assert.equal(existsSync(join(dir, ".async/cloudflare-local/bridge/event.json")), true);
    assert.equal(existsSync(join(dir, ".async/cloudflare-local/jobs/preview/result.json")), true);
    assert.equal(existsSync(join(dir, ".async/cloudflare-local/jobs/preview/github-report.json")), true);
    assert.equal(existsSync(join(dir, ".async/cloudflare-local/jobs/preview/receipt.json")), true);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
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

test("lifecycle audit reports custom release surfaces without a pipeline config", async () => {
  const dir = mkdtempSync(join(tmpdir(), "async-pipeline-lifecycle-audit-custom-"));
  try {
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({
      name: "@async/example",
      version: "1.2.3",
      type: "module",
      scripts: {
        "release:check": "npm test && npm pack --dry-run",
        "release": "node scripts/release.mjs",
        "publish:npm": "npm publish --provenance"
      }
    }, null, 2), "utf8");
    writeFileSync(join(dir, ".github", "workflows", "release.yml"), [
      "name: release",
      "on:",
      "  release:",
      "    types: [published]",
      "jobs:",
      "  publish:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: npm publish --provenance",
      ""
    ].join("\n"), "utf8");
    writeFileSync(join(dir, "scripts", "release.mjs"), "export {};\n", "utf8");

    let stdout = "";
    let stderr = "";
    const result = await runPipelineCli({
      args: ["lifecycle", "audit", "--format", "json"],
      ...({ cwd: dir }),
      stdout(text) {
        stdout += text;
      },
      stderr(text) {
        stderr += text;
      }
    });

    assert.equal(result.code, 0, stderr);
    const report = JSON.parse(stdout);
    assert.equal(report.package.name, "@async/example");
    assert.equal(report.pipeline.configPath, undefined);
    assert.ok(report.findings.some((finding) => finding.id === "pipeline.config.missing"));
    assert.ok(report.findings.some((finding) => finding.id === "workflows.lifecycle.custom"));
    assert.ok(report.findings.some((finding) => finding.id === "scripts.lifecycle.unmanaged"));
    assert.ok(report.files.some((file) => file.path === "scripts/release.mjs"));
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("lifecycle audit --package scans selected repo lifecycle files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "async-pipeline-lifecycle-audit-workspace-"));
  try {
    const repo = join(dir, "package-repo");
    mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
    mkdirSync(join(repo, "scripts"), { recursive: true });
    writeFileSync(join(repo, "package.json"), JSON.stringify({
      name: "@async/package-repo",
      version: "0.1.0",
      type: "module",
      scripts: {
        "release": "node scripts/release.mjs"
      }
    }, null, 2), "utf8");
    writeFileSync(join(repo, ".github", "workflows", "release.yml"), [
      "name: release",
      "on:",
      "  workflow_dispatch:",
      "jobs:",
      "  publish:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: npm publish --provenance",
      ""
    ].join("\n"), "utf8");
    writeFileSync(join(repo, "scripts", "release.mjs"), "export {};\n", "utf8");

    let stdout = "";
    let stderr = "";
    const result = await runPipelineCli({
      args: ["lifecycle", "audit", "--package", "package-repo", "--format", "json"],
      ...({ cwd: dir }),
      stdout(text) {
        stdout += text;
      },
      stderr(text) {
        stderr += text;
      }
    });

    assert.equal(result.code, 0, stderr);
    const report = JSON.parse(stdout);
    assert.equal(report.package.path, "package-repo/package.json");
    assert.ok(report.workflows.some((workflow) => workflow.path === "package-repo/.github/workflows/release.yml"));
    assert.ok(report.files.some((file) => file.path === "package-repo/scripts/release.mjs"));
    assert.ok(report.findings.some((finding) => finding.id === "workflows.lifecycle.custom"));
    assert.ok(report.findings.some((finding) => finding.id === "files.lifecycle.scripts"));
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("lifecycle audit recognizes pipeline-owned scripts and nested package paths", async () => {
  const dir = mkdtempSync(join(tmpdir(), "async-pipeline-lifecycle-audit-managed-"));
  try {
    mkdirSync(join(dir, "packages", "tool"), { recursive: true });
    mkdirSync(join(dir, "packages", "tool", "scripts"), { recursive: true });
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    mkdirSync(join(dir, ".async-pipeline"), { recursive: true });
    writeFileSync(join(dir, "pipeline.js"), "export default {};\n", "utf8");
    writeFileSync(join(dir, ".github", "async-pipeline.lock.json"), "{}\n", "utf8");
    writeFileSync(join(dir, ".async-pipeline", "tasks.lock.json"), "{}\n", "utf8");
    writeFileSync(join(dir, ".github", "workflows", "async-pipeline.yml"), "name: async-pipeline\n", "utf8");
    writeFileSync(join(dir, "packages", "tool", "package.json"), JSON.stringify({
      name: "@async/tool",
      version: "0.1.0",
      type: "module",
      devDependencies: {
        "@async/pipeline": "0.9.18"
      },
      scripts: {
        "pipeline:publish": "async-pipeline run publish",
        "release:evidence:check": "node scripts/evidence.js --check"
      }
    }, null, 2), "utf8");
    writeFileSync(join(dir, "packages", "tool", "scripts", "release.mjs"), "export {};\n", "utf8");

    let stdout = "";
    let stderr = "";
    const result = await runPipelineCli({
      args: ["lifecycle", "audit", "--package", "packages/tool"],
      ...({ cwd: dir }),
      stdout(text) {
        stdout += text;
      },
      stderr(text) {
        stderr += text;
      }
    });

    assert.equal(result.code, 0, stderr);
    assert.match(stdout, /Lifecycle audit: @async\/tool/);
    assert.match(stdout, /Pipeline config: pipeline.js/);
    assert.match(stdout, /@async\/pipeline: 0.9.18/);

    stdout = "";
    stderr = "";
    const jsonResult = await runPipelineCli({
      args: ["lifecycle", "audit", "--package", "packages/tool", "--format", "json"],
      ...({ cwd: dir }),
      stdout(text) {
        stdout += text;
      },
      stderr(text) {
        stderr += text;
      }
    });

    assert.equal(jsonResult.code, 0, stderr);
    const report = JSON.parse(stdout);
    assert.equal(report.package.path, "packages/tool/package.json");
    assert.equal(report.pipeline.configPath, "pipeline.js");
    assert.equal(report.package.asyncPipelineVersion, "0.9.18");
    assert.ok(report.workflows.some((workflow) => workflow.path === ".github/workflows/async-pipeline.yml"));
    assert.ok(report.files.some((file) => file.path === "packages/tool/scripts/release.mjs"));
    assert.ok(report.scripts.some((script) => script.name === "pipeline:publish" && script.managedByPipeline));
    assert.ok(report.scripts.some((script) => script.name === "release:evidence:check" && script.category === "keep"));
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

test("cache manifest writes generated task-cache metadata", async () => {
  const { mkdtemp, readFile, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { runPipelineCli } = await import("../packages/pipeline-node/dist/cli.js");

  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-cli-cache-manifest-"));
  try {
    await writeFile(join(dir, "input.txt"), "hello\n", "utf8");
    await writeFile(join(dir, "pipeline.mjs"), [
      `import { definePipeline, job, sh, task } from ${JSON.stringify(new URL("../packages/pipeline-core/dist/index.js", import.meta.url).href)};`,
      "export default definePipeline({",
      '  name: "cache-manifest-test",',
      "  tasks: { verify: task({ inputs: [\"input.txt\"], cache: \"file:local\", run: sh`node -e \"process.exit(0)\"` }) },",
      "  jobs: { verify: job({ target: \"verify\" }) }",
      "});",
      ""
    ].join("\n"), "utf8");
    const target = ({ cwd: dir, env: { PATH: process.env.PATH, RUNNER_OS: "Linux" } });

    let stdout = "";
    const result = await runPipelineCli({
      args: ["cache", "manifest", "--job", "verify", "--output", ".async/actions/cache/verify.json", "--trust", "read-write"],
      ...target,
      stdout: (text) => { stdout += text; },
      stderr: () => {}
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(stdout, /Generated \.async\/actions\/cache\/verify\.json/);

    const manifest = JSON.parse(await readFile(join(dir, ".async/actions/cache/verify.json"), "utf8"));
    assert.equal(manifest.generatedBy, "@async/pipeline");
    assert.equal(manifest.job, "verify");
    assert.equal(manifest.trust, "read-write");
    assert.match(manifest.primaryKey, /^async-pipeline-linux-verify-/u);
    assert.equal(manifest.entries.length, 1);
    assert.equal(manifest.entries[0].task, "verify");
    assert.match(manifest.entries[0].key, /^async-pipeline-linux-verify-/u);
    assert.match(manifest.entries[0].paths[0], /^\.async\/cache\/tasks\/[a-f0-9]+$/u);
    assert.equal(manifest.entries[0].writeAllowed, true);

    stdout = "";
    const unsafe = await runPipelineCli({
      args: ["cache", "manifest", "--job", "verify", "--output", "../outside.json"],
      ...target,
      stdout: (text) => { stdout += text; },
      stderr: () => {}
    });
    assert.equal(unsafe.code, 1);
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
