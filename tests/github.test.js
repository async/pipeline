import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { definePipeline, env, execution, job, sandbox, sh, task, trigger } from "../packages/pipeline-core/dist/index.js";
import { jobsForGitHubEvent, renderGitHubWorkflow } from "../packages/pipeline-node/dist/index.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const packageUrl = pathToFileURL(join(repoRoot, "packages/pipeline/dist/index.js")).href;
const cliPath = join(repoRoot, "packages/pipeline-node/dist/cli.js");

test("renders github workflow triggers and bootloader steps", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-github-render-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ packageManager: "pnpm@10.20.0" }), "utf8");
    const pipeline = definePipeline({
      name: "test",
      triggers: {
        pr: trigger.github({ events: ["pull_request"] }),
        main: trigger.github({ events: ["push"], branches: ["main"] }),
        nightly: trigger.cron("17 2 * * *")
      },
      tasks: {
        verify: task({ run: sh`echo verify` })
      },
      jobs: {
        verify: job({ target: "verify", trigger: ["pr", "main", "nightly"] })
      }
    });

    const rendered = await renderGitHubWorkflow(pipeline, { cwd: dir, configPath: join(dir, "pipeline.ts") });

    assert.match(rendered.workflow, /pull_request:/);
    assert.match(rendered.workflow, /push:/);
    assert.match(rendered.workflow, /schedule:/);
    assert.match(rendered.workflow, /async-pipeline github check/);
    assert.match(rendered.workflow, /async-pipeline run verify/);
    assert.match(rendered.workflow, /actions\/cache@0057852bfaa89a56745cba8c7296529d2fc39830 # v4/);
    assert.match(rendered.workflow, /async-pipeline explain --run latest \|\| true/);
    assert.match(rendered.workflow, /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4/);
    assert.match(rendered.workflow, /path: \.async\/runs/);
    assert.equal(rendered.lock.workflow, ".github/workflows/async-pipeline.yml");
    assert.equal(rendered.lock.jobs[0].id, "verify");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("renders github job environment and secret env wiring", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-github-env-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ packageManager: "pnpm@10.20.0" }), "utf8");
    const pipeline = definePipeline({
      name: "test",
      env: {
        NODE_VERSION: env.var("NODE_VERSION", { default: "24" })
      },
      triggers: {
        publish: trigger.manual()
      },
      tasks: {
        publish: task({
          requires: { secrets: ["NPM_TOKEN"] },
          run: sh`npm publish`
        })
      },
      jobs: {
        publish: job({
          target: "publish",
          trigger: ["publish"],
          env: {
            NODE_AUTH_TOKEN: env.secret("NPM_TOKEN"),
            PUBLISH_REGISTRY: "https://registry.npmjs.org/"
          },
          environment: {
            name: "npm-publish",
            url: "https://www.npmjs.com/package/@async/pipeline"
          },
          requires: {
            provenance: true
          }
        })
      }
    });

    const rendered = await renderGitHubWorkflow(pipeline, { cwd: dir, configPath: join(dir, "pipeline.ts") });

    assert.match(rendered.workflow, /workflow_dispatch:\n    inputs:\n      job:\n        description: "Pipeline job to run"\n        required: true\n        type: choice\n        options:\n          - "publish"/);
    assert.match(rendered.workflow, /publish:/);
    assert.match(rendered.workflow, /if: github\.event_name == 'workflow_dispatch' && github\.event\.inputs\.job == 'publish'/);
    assert.match(rendered.workflow, /environment:\n      name: "npm-publish"\n      url: "https:\/\/www\.npmjs\.com\/package\/@async\/pipeline"/);
    assert.match(rendered.workflow, /permissions:\n      contents: read\n      id-token: write/);
    assert.match(rendered.workflow, /NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/);
    assert.match(rendered.workflow, /NODE_VERSION: \$\{\{ vars\.NODE_VERSION \}\}/);
    assert.match(rendered.workflow, /PUBLISH_REGISTRY: "https:\/\/registry\.npmjs\.org\/"/);
    assert.match(rendered.workflow, /async-pipeline run publish/);
    assert.deepEqual(rendered.lock.jobs[0].environment, {
      name: "npm-publish",
      url: "https://www.npmjs.com/package/@async/pipeline"
    });
    assert.deepEqual(rendered.lock.manualDispatchJobs, ["publish"]);
    assert.deepEqual(rendered.lock.jobs[0].requires, { provenance: true });
    assert.equal(rendered.lock.jobs[0].env.NODE_AUTH_TOKEN.kind, "async-pipeline.env.secret");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("renders workflow_dispatch job selector inputs and gates manual jobs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-github-selector-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ packageManager: "pnpm@10.20.0" }), "utf8");
    const pipeline = definePipeline({
      name: "selector-test",
      triggers: {
        main: trigger.github({ events: ["push"], branches: ["main"] }),
        manual: trigger.manual()
      },
      tasks: {
        verify: task({ run: sh`echo verify` }),
        publish: task({ run: sh`echo publish` }),
        doctor: task({ run: sh`echo doctor` })
      },
      jobs: {
        verify: job({ target: "verify", trigger: ["main"] }),
        publish: job({ target: "publish", trigger: ["manual"] }),
        doctor: job({ target: "doctor", trigger: ["main", "manual"] })
      }
    });

    const rendered = await renderGitHubWorkflow(pipeline, { cwd: dir, configPath: join(dir, "pipeline.ts") });

    assert.match(rendered.workflow, /workflow_dispatch:\n    inputs:\n      job:\n        description: "Pipeline job to run"\n        required: true\n        type: choice\n        options:\n          - "doctor"\n          - "publish"/);
    assert.match(rendered.workflow, /publish:\n    name: publish\n    if: github\.event_name == 'workflow_dispatch' && github\.event\.inputs\.job == 'publish'/);
    assert.match(rendered.workflow, /doctor:\n    name: doctor\n    if: \(github\.event_name == 'push' && \(github\.ref == 'refs\/heads\/main'\)\) \|\| \(github\.event_name == 'workflow_dispatch' && github\.event\.inputs\.job == 'doctor'\)/);
    assert.deepEqual(rendered.lock.manualDispatchJobs, ["doctor", "publish"]);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("renders github pages build and deploy jobs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-github-pages-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ packageManager: "pnpm@10.20.0" }), "utf8");
    const pipeline = definePipeline({
      name: "pages-test",
      triggers: {
        pr: trigger.github({ events: ["pull_request"] }),
        main: trigger.github({ events: ["push"], branches: ["main"] }),
        manual: trigger.manual()
      },
      tasks: {
        docs: task({ run: sh`pnpm run docs:check` })
      },
      jobs: {
        pages: job({
          target: "docs",
          trigger: ["pr", "main", "manual"],
          github: {
            pages: {
              build: { kind: "jekyll", source: "./docs", destination: "./_site" }
            }
          }
        })
      }
    });

    const rendered = await renderGitHubWorkflow(pipeline, { cwd: dir, configPath: join(dir, "pipeline.ts") });

    assert.match(rendered.workflow, /workflow_dispatch:\n    inputs:\n      job:\n        description: "Pipeline job to run"\n        required: true\n        type: choice\n        options:\n          - "pages"/);
    assert.match(rendered.workflow, /pages:\n    name: pages\n    if: \(github\.event_name == 'pull_request'\) \|\| \(github\.event_name == 'push' && \(github\.ref == 'refs\/heads\/main'\)\) \|\| \(github\.event_name == 'workflow_dispatch' && github\.event\.inputs\.job == 'pages'\)/);
    assert.match(rendered.workflow, /run: pnpm async-pipeline run pages/);
    assert.match(rendered.workflow, /uses: actions\/configure-pages@v5/);
    assert.match(rendered.workflow, /uses: actions\/jekyll-build-pages@v1\n        with:\n          source: "\.\/docs"\n          destination: "\.\/_site"/);
    assert.match(rendered.workflow, /uses: actions\/upload-pages-artifact@v4\n        with:\n          path: "\.\/_site"/);
    assert.match(rendered.workflow, /pages-deploy:\n    name: pages-deploy\n    needs: "pages"\n    if: github\.event_name != 'pull_request'\n    runs-on: ubuntu-latest/);
    assert.match(rendered.workflow, /environment:\n      name: "github-pages"\n      url: "\$\{\{ steps\.deployment\.outputs\.page_url \}\}"/);
    assert.match(rendered.workflow, /permissions:\n      pages: write\n      id-token: write/);
    assert.match(rendered.workflow, /uses: actions\/deploy-pages@v4/);
    assert.deepEqual(rendered.lock.manualDispatchJobs, ["pages"]);
    assert.deepEqual(rendered.lock.jobs[0].github.pages, {
      build: { kind: "jekyll", source: "./docs", destination: "./_site" }
    });
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("renders github job packages, issues, and pull-requests permissions with a contents fallback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-github-permissions-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ packageManager: "pnpm@10.20.0" }), "utf8");
    const pipeline = definePipeline({
      name: "test",
      triggers: {
        pr: trigger.github({ events: ["pull_request"] })
      },
      tasks: {
        preview: task({ run: sh`node scripts/publish-github.mjs pr` })
      },
      jobs: {
        preview: job({
          target: "preview",
          trigger: ["pr"],
          env: {
            GITHUB_TOKEN: env.secret("GITHUB_TOKEN")
          },
          github: {
            permissions: {
              issues: "write",
              packages: "write",
              pullRequests: "read"
            }
          }
        })
      }
    });

    const rendered = await renderGitHubWorkflow(pipeline, { cwd: dir, configPath: join(dir, "pipeline.ts") });

    // Job-level permissions replace the workflow defaults, so contents: read
    // must be restated automatically or checkout loses repo access.
    assert.match(
      rendered.workflow,
      /permissions:\n      contents: read\n      issues: write\n      packages: write\n      pull-requests: read/
    );
    assert.match(rendered.workflow, /GITHUB_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
    assert.doesNotMatch(rendered.workflow, /id-token/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("rejects unknown github permission fields", () => {
  assert.throws(
    () =>
      definePipeline({
        name: "test",
        tasks: { verify: task({ run: sh`echo verify` }) },
        jobs: {
          verify: job({
            target: "verify",
            github: { permissions: { packges: "write" } }
          })
        }
      }),
    (error) => error.code === "ASYNC_PIPELINE_UNKNOWN_FIELD" && /packges/.test(error.message)
  );
});

test("github pages config rejects invalid settings", () => {
  assert.throws(
    () =>
      definePipeline({
        name: "test",
        tasks: { docs: task({ run: sh`echo docs` }) },
        jobs: {
          pages: job({
            target: "docs",
            github: {
              pages: {
                build: { kind: "static", source: "./docs" }
              }
            }
          })
        }
      }),
    (error) => error.code === "ASYNC_PIPELINE_UNKNOWN_FIELD" && /source/.test(error.message)
  );

  assert.throws(
    () =>
      definePipeline({
        name: "test",
        tasks: { docs: task({ run: sh`echo docs` }) },
        jobs: {
          pages: job({
            target: "docs",
            github: {
              runsOnMatrix: ["ubuntu-latest", "macos-latest"],
              pages: {
                build: { kind: "static", path: "./dist" }
              }
            }
          })
        }
      }),
    (error) => error.code === "ASYNC_PIPELINE_GITHUB_PAGES_INVALID" && /runsOnMatrix/.test(error.message)
  );
});

test("renders github job runner labels and runner matrices", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-github-runners-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ packageManager: "pnpm@10.20.0" }), "utf8");
    const pipeline = definePipeline({
      name: "runner-test",
      triggers: {
        manual: trigger.manual()
      },
      tasks: {
        linux: task({ run: sh`echo linux` }),
        mac: task({ run: sh`echo mac` }),
        matrix: task({ run: sh`echo matrix` })
      },
      jobs: {
        linux: job({ target: "linux", trigger: ["manual"], github: { runsOn: "ubuntu-24.04" } }),
        mac: job({ target: "mac", trigger: ["manual"], github: { runsOn: ["self-hosted", "macos", "tart"] } }),
        matrix: job({
          target: "matrix",
          trigger: ["manual"],
          github: { runsOnMatrix: ["ubuntu-latest", ["self-hosted", "macos", "tart"]] }
        })
      }
    });

    const rendered = await renderGitHubWorkflow(pipeline, { cwd: dir, configPath: join(dir, "pipeline.ts") });

    assert.match(rendered.workflow, /linux:\n    name: linux\n    if: github\.event_name == 'workflow_dispatch' && github\.event\.inputs\.job == 'linux'\n    runs-on: ubuntu-24\.04/);
    assert.match(rendered.workflow, /mac:\n    name: mac\n    if: github\.event_name == 'workflow_dispatch' && github\.event\.inputs\.job == 'mac'\n    runs-on: \["self-hosted","macos","tart"\]/);
    assert.match(rendered.workflow, /matrix:\n    name: matrix \(\$\{\{ join\(matrix\.runner, ' '\) \}\}\)/);
    assert.match(rendered.workflow, /strategy:\n      fail-fast: false\n      matrix:\n        runner:\n          - \["ubuntu-latest"\]\n          - \["self-hosted","macos","tart"\]\n    runs-on: \$\{\{ matrix\.runner \}\}/);
    assert.deepEqual(rendered.lock.jobs.find((entry) => entry.id === "matrix")?.github?.runsOnMatrix, [
      "ubuntu-latest",
      ["self-hosted", "macos", "tart"]
    ]);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("renders github execution profiles as runner defaults and CLI execution args", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-github-execution-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ packageManager: "pnpm@10.20.0" }), "utf8");
    const pipeline = definePipeline({
      name: "execution-test",
      triggers: {
        manual: trigger.manual()
      },
      sandboxes: {
        node24: sandbox.container({ image: "node:24" })
      },
      execution: {
        linuxCi: execution.github({ sandbox: "node24", provider: "docker", runsOn: "ubuntu-latest" }),
        appleCi: execution.github({ sandbox: "node24", provider: "apple-container", runsOn: ["self-hosted", "macos", "arm64", "apple-container"] })
      },
      tasks: {
        linux: task({ run: sh`echo linux` }),
        apple: task({ run: sh`echo apple` }),
        override: task({ run: sh`echo override` })
      },
      jobs: {
        linux: job({ target: "linux", trigger: ["manual"], execution: "linuxCi" }),
        apple: job({ target: "apple", trigger: ["manual"], execution: "appleCi" }),
        override: job({ target: "override", trigger: ["manual"], execution: "linuxCi", github: { runsOn: "ubuntu-24.04" } })
      }
    });

    const rendered = await renderGitHubWorkflow(pipeline, { cwd: dir, configPath: join(dir, "pipeline.ts") });

    assert.match(rendered.workflow, /linux:\n    name: linux\n    if: github\.event_name == 'workflow_dispatch' && github\.event\.inputs\.job == 'linux'\n    runs-on: ubuntu-latest/);
    assert.match(rendered.workflow, /run: pnpm async-pipeline run linux --execution linuxCi/);
    assert.match(rendered.workflow, /apple:\n    name: apple\n    if: github\.event_name == 'workflow_dispatch' && github\.event\.inputs\.job == 'apple'\n    runs-on: \["self-hosted","macos","arm64","apple-container"\]/);
    assert.match(rendered.workflow, /run: pnpm async-pipeline run apple --execution appleCi/);
    assert.match(rendered.workflow, /override:\n    name: override\n    if: github\.event_name == 'workflow_dispatch' && github\.event\.inputs\.job == 'override'\n    runs-on: ubuntu-24\.04/);
    assert.equal(rendered.lock.jobs.find((entry) => entry.id === "linux")?.execution, "linuxCi");
    assert.equal(rendered.lock.jobs.find((entry) => entry.id === "apple")?.github?.runsOn?.[3], "apple-container");
    assert.equal(rendered.lock.jobs.find((entry) => entry.id === "override")?.github?.runsOn, "ubuntu-24.04");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("matches github jobs from event context", () => {
  const pipeline = definePipeline({
    name: "test",
    triggers: {
      main: trigger.github({ events: ["push"], branches: ["main"] }),
      release: trigger.github({ events: ["push"], branches: ["release/*"] }),
      docs: trigger.github({ events: ["push"], branches: ["docs"] }),
      published: trigger.github({ events: ["release"] }),
      nightly: trigger.cron("17 2 * * *"),
      manual: trigger.manual()
    },
    tasks: {
      verify: task({ run: sh`echo verify` }),
      docs: task({ run: sh`echo docs` }),
      release: task({ run: sh`echo release` }),
      published: task({ run: sh`echo published` }),
      nightly: task({ run: sh`echo nightly` }),
      deploy: task({ run: sh`echo deploy` })
    },
    jobs: {
      verify: job({ target: "verify", trigger: ["main"] }),
      release: job({ target: "release", trigger: ["release"] }),
      docs: job({ target: "docs", trigger: ["docs"] }),
      published: job({ target: "published", trigger: ["published"] }),
      nightly: job({ target: "nightly", trigger: ["nightly"] }),
      deploy: job({ target: "deploy", trigger: ["manual"] })
    }
  });

  assert.deepEqual(jobsForGitHubEvent(pipeline, { eventName: "push", ref: "refs/heads/main" }).map((entry) => entry.id), ["verify"]);
  assert.deepEqual(jobsForGitHubEvent(pipeline, { eventName: "push", ref: "refs/heads/release/1.0" }).map((entry) => entry.id), ["release"]);
  assert.deepEqual(jobsForGitHubEvent(pipeline, { eventName: "release" }).map((entry) => entry.id), ["published"]);
  assert.deepEqual(jobsForGitHubEvent(pipeline, { eventName: "schedule", schedule: "17 2 * * *" }).map((entry) => entry.id), ["nightly"]);
  // workflow_dispatch requires selecting one manual job.
  assert.deepEqual(jobsForGitHubEvent(pipeline, { eventName: "workflow_dispatch" }).map((entry) => entry.id), []);
  assert.deepEqual(jobsForGitHubEvent(pipeline, { eventName: "workflow_dispatch", selectedJob: "deploy" }).map((entry) => entry.id), ["deploy"]);
  assert.deepEqual(jobsForGitHubEvent(pipeline, { eventName: "workflow_dispatch", selectedJob: "verify" }).map((entry) => entry.id), []);
  assert.deepEqual(jobsForGitHubEvent(pipeline, { eventName: "workflow_dispatch", selectedJob: "missing" }).map((entry) => entry.id), []);
});

test("github generate writes a current workflow and lock", () => {
  const dir = mkdtempSyncCompat("async-pipeline-github-cli-");
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({
      type: "module",
      packageManager: "pnpm@10.20.0",
      scripts: {
        "async-pipeline": `node ${JSON.stringify(cliPath)}`
      }
    }), "utf8");
    writeFileSync(join(dir, "pipeline.js"), `
import { definePipeline, job, sh, task, trigger } from ${JSON.stringify(packageUrl)};

export default definePipeline({
  name: "fixture",
  triggers: {
    main: trigger.github({ events: ["push"], branches: ["main"] })
  },
  tasks: {
    verify: task({ run: sh\`node -e 'console.log("ok")'\` })
  },
  jobs: {
    verify: job({ target: "verify", trigger: ["main"] })
  }
});
`, "utf8");

    const generate = spawnSync("node", [cliPath, "github", "generate"], { cwd: dir, encoding: "utf8" });
    assert.equal(generate.status, 0, generate.stderr);
    assert.equal(existsSync(join(dir, ".github/workflows/async-pipeline.yml")), true);
    assert.equal(existsSync(join(dir, ".github/async-pipeline.lock.json")), true);

    const check = spawnSync("node", [cliPath, "github", "check"], { cwd: dir, encoding: "utf8" });
    assert.equal(check.status, 0, check.stderr);

    const lock = JSON.parse(readFileSync(join(dir, ".github/async-pipeline.lock.json"), "utf8"));
    assert.equal(lock.triggers.push.branches[0], "main");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("github generate and check support custom output paths", () => {
  const dir = mkdtempSyncCompat("async-pipeline-github-custom-");
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({
      type: "module",
      packageManager: "pnpm@10.20.0",
      scripts: {
        "async-pipeline": `node ${JSON.stringify(cliPath)}`
      }
    }), "utf8");
    writeFileSync(join(dir, "pipeline.js"), `
import { definePipeline, job, sh, task, trigger } from ${JSON.stringify(packageUrl)};

export default definePipeline({
  name: "fixture",
  triggers: {
    pr: trigger.github({ events: ["pull_request"] })
  },
  tasks: {
    verify: task({ run: sh\`node -e 'console.log("ok")'\` })
  },
  jobs: {
    verify: job({ target: "verify", trigger: ["pr"] })
  }
});
`, "utf8");

    const workflow = ".tmp/generated-workflow.yml";
    const lock = ".tmp/generated-lock.json";
    const generate = spawnSync("node", [cliPath, "github", "generate", "--workflow", workflow, "--lock", lock], { cwd: dir, encoding: "utf8" });
    assert.equal(generate.status, 0, generate.stderr);
    assert.equal(existsSync(join(dir, workflow)), true);
    assert.equal(existsSync(join(dir, lock)), true);
    assert.equal(existsSync(join(dir, ".github/workflows/async-pipeline.yml")), false);

    const check = spawnSync("node", [cliPath, "github", "check", "--workflow", workflow, "--lock", lock], { cwd: dir, encoding: "utf8" });
    assert.equal(check.status, 0, check.stderr);

    const lockJson = JSON.parse(readFileSync(join(dir, lock), "utf8"));
    assert.equal(lockJson.workflow, workflow);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

function mkdtempSyncCompat(prefix) {
  const dir = join(tmpdir(), `${prefix}${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
