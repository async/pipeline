import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { agent, definePipeline, env, execution, job, sandbox, sh, source, task, trigger } from "../packages/pipeline-core/dist/index.js";
import { checkGitHubWorkflow, jobsForGitHubEvent, planGitHubJobs, renderGitHubWorkflow, runGitHubLocalManifest, writeGitHubWorkflow } from "../packages/pipeline-node/dist/index.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const packageUrl = pathToFileURL(join(repoRoot, "packages/pipeline/dist/index.js")).href;
const cliPath = join(repoRoot, "packages/pipeline-node/dist/cli.js");
const asyncActionsSha = "f81b4ae15d6a8c512a94bc3a2e866f807ad398a4";
const asyncActionsLabel = "v0.1.16";
const asyncActionsRefPattern = `${asyncActionsSha} # ${asyncActionsLabel.replaceAll(".", "\\.")}`;
const asyncActionUses = (name) => new RegExp(`uses: async/actions/${name}@${asyncActionsRefPattern}`);

test("renders github workflow triggers and bootloader steps", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-github-render-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ packageManager: "pnpm@11.1.0" }), "utf8");
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    const pipeline = definePipeline({
      name: "test",
      triggers: {
        pr: trigger.github({ events: ["pull_request"] }),
        main: trigger.github({ events: ["push"], branches: ["main"] }),
        release: trigger.github({ events: ["release"], types: ["published"] }),
        nightly: trigger.cron("17 2 * * *")
      },
      tasks: {
        verify: task({ run: sh`echo verify` })
      },
      jobs: {
        verify: job({ target: "verify", trigger: ["pr", "main", "release", "nightly"] })
      }
    });

    const rendered = await renderGitHubWorkflow(pipeline, { cwd: dir, configPath: join(dir, "pipeline.ts") });

    assert.match(rendered.workflow, /pull_request:/);
    assert.match(rendered.workflow, /push:/);
    assert.match(rendered.workflow, /release:\n    types:\n      - "published"/);
    assert.match(rendered.workflow, /schedule:/);
    assert.match(rendered.workflow, /github\.event_name == 'release' && \(github\.event\.action == 'published'\)/);
    assert.match(rendered.workflow, /async-pipeline github check/);
    assertAllRemoteActionRefsPinned(rendered.workflow);
    assert.match(rendered.workflow, /async-pipeline run verify/);
    assert.match(rendered.workflow, /async-pipeline cache manifest --job verify --output \.async\/actions\/cache\/verify-cache-manifest\.json --trust read-only/);
    assert.match(rendered.workflow, asyncActionUses("cache"));
    assert.match(rendered.workflow, /mode: restore/);
    assert.match(rendered.workflow, /mode: save/);
    assert.match(rendered.workflow, /github\.event_name != 'pull_request'/);
    assert.match(rendered.workflow, /name: Setup pnpm runtime/);
    assert.match(rendered.workflow, /uses: pnpm\/setup@cf03a9b516e09bc5a90f041fc26fc930c9dc631b # v1\.0\.0/);
    assert.match(rendered.workflow, /version: 11\.1\.0/);
    assert.match(rendered.workflow, /runtime: node@24/);
    assert.match(rendered.workflow, /install: false/);
    assert.match(rendered.workflow, /cache: true/);
    assert.match(rendered.workflow, /cache-dependency-path: "pnpm-lock\.yaml"/);
    assert.match(rendered.workflow, /pnpm install --frozen-lockfile/);
    assert.doesNotMatch(rendered.workflow, /run_install: false/);
    assert.doesNotMatch(rendered.workflow, /package-manager-cache: false/);
    assert.doesNotMatch(rendered.workflow, /async\/actions\/setup@v0/);
    assert.doesNotMatch(rendered.workflow, /actions\/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6/);
    assert.doesNotMatch(rendered.workflow, /corepack prepare/);
    assert.match(rendered.workflow, asyncActionUses("run"));
    assert.match(rendered.workflow, /command: "pnpm async-pipeline github check && pnpm async-pipeline run verify"/);
    assert.match(rendered.workflow, /artifact-name: async-pipeline-\$\{\{ github\.job \}\}-runs/);
    assert.equal(rendered.lock.workflow, ".github/workflows/async-pipeline.yml");
    assert.equal(rendered.lock.actions.find((entry) => entry.id === "async.actions.run")?.sha, asyncActionsSha);
    assert.equal(rendered.lock.actions.find((entry) => entry.id === "async.actions.cache")?.sha, asyncActionsSha);
    assert.equal(rendered.lock.setup, "pnpm");
    assert.equal(rendered.lock.packageManagerVersion, "11.1.0");
    assert.equal(rendered.lock.dependencyCache, true);
    assert.equal(rendered.lock.dependencyCachePath, "pnpm-lock.yaml");
    assert.equal(rendered.lock.jobs[0].id, "verify");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("renders generated actions bridge job from sync github bridge", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-github-bridge-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ packageManager: "pnpm@11.1.0" }), "utf8");
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    const pipeline = definePipeline({
      name: "test",
      sync: {
        github: {
          bridge: {
            mode: "actions",
            schedule: "*/15 * * * *",
            branchPrefix: "async/bridge/",
            allowedPaths: ["pipeline.ts", "package.json", "docs/**"],
            endpointVar: "ASYNC_BRIDGE_URL",
            tokenEnv: "ASYNC_BRIDGE_TOKEN",
            packageVersion: "0.1.1"
          }
        }
      },
      tasks: {
        verify: task({ run: sh`echo verify` })
      },
      jobs: {
        verify: job({ target: "verify" })
      }
    });

    const rendered = await renderGitHubWorkflow(pipeline, { cwd: dir, configPath: join(dir, "pipeline.ts") });

    assert.match(rendered.workflow, /workflow_dispatch:\n    inputs:\n      job:/);
    assert.match(rendered.workflow, /- "async-bridge"/);
    assert.match(rendered.workflow, /schedule:\n    - cron: "\*\/15 \* \* \* \*"/);
    assert.match(rendered.workflow, /async-bridge:\n    name: async-bridge/);
    assert.match(rendered.workflow, /github\.event_name == 'schedule' && github\.event\.schedule == '\*\/15 \* \* \* \*'/);
    assert.match(rendered.workflow, /contents: write/);
    assert.match(rendered.workflow, /pull-requests: write/);
    assert.match(rendered.workflow, /group: async-bridge-\$\{\{ github\.repository \}\}/);
    assert.match(rendered.workflow, /name: Check generated workflow[\s\S]+command: "pnpm async-pipeline github check"/);
    assert.match(rendered.workflow, new RegExp(`name: Pull and apply Async bridge change sets[\\s\\S]+${asyncActionUses("run").source}`));
    assert.match(rendered.workflow, /npx --yes \\"@async\/github-app@0\.1\.1\\" actions pull --branch-prefix async\/bridge\/ --pull-request true --allowed-path pipeline\.ts --allowed-path package\.json --allowed-path \\"docs\/\*\*\\"/);
    assert.match(rendered.workflow, /ASYNC_PROJECT_URL: \$\{\{ vars\.ASYNC_BRIDGE_URL \}\}/);
    assert.match(rendered.workflow, /ASYNC_PROJECT_TOKEN: \$\{\{ secrets\.ASYNC_BRIDGE_TOKEN \}\}/);
    assertAllRemoteActionRefsPinned(rendered.workflow);
    assert.equal(rendered.lock.bridge.enabled, true);
    assert.equal(rendered.lock.bridge.job, "async-bridge");
    assert.equal(rendered.lock.bridge.actionsJob.scheduled, true);
    assert.deepEqual(rendered.lock.bridge.allowedPaths, ["pipeline.ts", "package.json", "docs/**"]);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("renders explicit async setup provider", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-github-async-setup-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ packageManager: "pnpm@11.1.0" }), "utf8");
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    const pipeline = definePipeline({
      name: "test",
      sync: {
        github: {
          setup: "async",
          runtime: ["node@24", "deno@2"]
        }
      },
      tasks: {
        verify: task({ run: sh`echo verify` })
      },
      jobs: {
        verify: job({ target: "verify" })
      }
    });

    const rendered = await renderGitHubWorkflow(pipeline, { cwd: dir, configPath: join(dir, "pipeline.ts") });

    assert.match(rendered.workflow, /name: Setup Async runtimes/);
    assert.match(rendered.workflow, asyncActionUses("setup"));
    assert.match(rendered.workflow, /pnpm-version: 11\.1\.0/);
    assert.match(rendered.workflow, /runtime: \|\n            node@24\n            deno@2/);
    assert.match(rendered.workflow, /^\s+install: true$/m);
    assert.match(rendered.workflow, /cache: true/);
    assert.match(rendered.workflow, /dependency-cache-path: "pnpm-lock\.yaml"/);
    assert.doesNotMatch(rendered.workflow, /pnpm\/setup@/);
    assert.doesNotMatch(rendered.workflow, /denoland\/setup-deno@/);
    assert.doesNotMatch(rendered.workflow, /pnpm install --frozen-lockfile/);
    assert.equal(rendered.lock.setup, "async");
    assert.deepEqual(rendered.lock.runtime, ["node@24", "deno@2"]);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("renders legacy pnpm setup with setup-node when the consumer pnpm version does not support runtime", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-github-pnpm-version-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ packageManager: "pnpm@10.20.0" }), "utf8");
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    const pipeline = definePipeline({
      name: "test",
      sync: {
        github: {
          setup: "pnpm"
        }
      },
      tasks: {
        verify: task({ run: sh`echo verify` })
      },
      jobs: {
        verify: job({ target: "verify" })
      }
    });

    const rendered = await renderGitHubWorkflow(pipeline, { cwd: dir, configPath: join(dir, "pipeline.ts") });

    assert.doesNotMatch(rendered.workflow, /uses: pnpm\/setup@cf03a9b516e09bc5a90f041fc26fc930c9dc631b # v1\.0\.0/);
    assert.match(rendered.workflow, /uses: actions\/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6/);
    assert.match(rendered.workflow, /node-version: 24/);
    assert.match(rendered.workflow, /package-manager-cache: false/);
    assert.match(rendered.workflow, /corepack prepare pnpm@10\.20\.0 --activate/);
    assert.doesNotMatch(rendered.workflow, /runtime: node@24/);
    assert.doesNotMatch(rendered.workflow, /version: 11\.1\.0/);
    assert.equal(rendered.lock.packageManager, "pnpm");
    assert.equal(rendered.lock.packageManagerVersion, "10.20.0");
    assert.equal(rendered.lock.setup, "node");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("renders github workflow with dependency cache disabled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-github-no-dep-cache-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ packageManager: "pnpm@11.1.0" }), "utf8");
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    const pipeline = definePipeline({
      name: "test",
      sync: {
        github: {
          dependencyCache: false
        }
      },
      tasks: {
        verify: task({ run: sh`echo verify` })
      },
      jobs: {
        verify: job({ target: "verify" })
      }
    });

    const rendered = await renderGitHubWorkflow(pipeline, { cwd: dir, configPath: join(dir, "pipeline.ts") });

    assert.match(rendered.workflow, /name: Setup pnpm runtime/);
    assert.match(rendered.workflow, /uses: pnpm\/setup@cf03a9b516e09bc5a90f041fc26fc930c9dc631b # v1\.0\.0/);
    assert.match(rendered.workflow, /install: false/);
    assert.match(rendered.workflow, /pnpm install --frozen-lockfile/);
    assert.match(rendered.workflow, /cache: false/);
    assert.doesNotMatch(rendered.workflow, /async\/actions\/setup@v0/);
    assert.doesNotMatch(rendered.workflow, /actions\/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6/);
    assert.doesNotMatch(rendered.workflow, /cache-dependency-path/);
    assert.doesNotMatch(rendered.workflow, /package-manager-cache: false/);
    assert.doesNotMatch(rendered.workflow, /corepack prepare/);
    assert.equal(rendered.lock.setup, "pnpm");
    assert.equal(rendered.lock.dependencyCache, false);
    assert.equal(rendered.lock.dependencyCachePath, undefined);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("renders github workflow with node setup provider", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-github-node-setup-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ packageManager: "pnpm@11.1.0" }), "utf8");
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    const pipeline = definePipeline({
      name: "test",
      sync: {
        github: {
          setup: "node"
        }
      },
      tasks: {
        verify: task({ run: sh`echo verify` })
      },
      jobs: {
        verify: job({ target: "verify" })
      }
    });

    const rendered = await renderGitHubWorkflow(pipeline, { cwd: dir, configPath: join(dir, "pipeline.ts") });

    assert.match(rendered.workflow, /name: Setup Node/);
    assert.match(rendered.workflow, /actions\/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6/);
    assert.match(rendered.workflow, /package-manager-cache: false/);
    assert.doesNotMatch(rendered.workflow, /cache: "pnpm"/);
    assert.doesNotMatch(rendered.workflow, /cache-dependency-path: "pnpm-lock\.yaml"/);
    assert.match(rendered.workflow, /corepack prepare pnpm@11\.1\.0 --activate/);
    assert.doesNotMatch(rendered.workflow, /pnpm\/setup@/);
    assert.equal(rendered.lock.setup, "node");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("renders node setup provider with the consumer pnpm packageManager version", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-github-node-setup-pnpm-version-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ packageManager: "pnpm@10.20.0" }), "utf8");
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    const pipeline = definePipeline({
      name: "test",
      sync: {
        github: {
          setup: "node"
        }
      },
      tasks: {
        verify: task({ run: sh`echo verify` })
      },
      jobs: {
        verify: job({ target: "verify" })
      }
    });

    const rendered = await renderGitHubWorkflow(pipeline, { cwd: dir, configPath: join(dir, "pipeline.ts") });

    assert.match(rendered.workflow, /corepack prepare pnpm@10\.20\.0 --activate/);
    assert.match(rendered.workflow, /package-manager-cache: false/);
    assert.doesNotMatch(rendered.workflow, /cache: "pnpm"/);
    assert.doesNotMatch(rendered.workflow, /pnpm\/setup@/);
    assert.doesNotMatch(rendered.workflow, /corepack prepare pnpm@11\.1\.0 --activate/);
    assert.equal(rendered.lock.packageManagerVersion, "10.20.0");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("renders deno-only github workflow without package-manager install", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-github-deno-only-"));
  try {
    writeFileSync(join(dir, "deno.json"), JSON.stringify({ tasks: {} }), "utf8");
    writeFileSync(join(dir, "deno.lock"), JSON.stringify({ version: "5", specifiers: {}, npm: {}, workspace: {} }), "utf8");
    const pipeline = definePipeline({
      name: "test",
      sync: {
        github: true
      },
      tasks: {
        verify: task({ requires: { runtime: "deno" }, run: sh`deno test` })
      },
      jobs: {
        verify: job({ target: "verify" })
      }
    });

    const rendered = await renderGitHubWorkflow(pipeline, { cwd: dir, configPath: join(dir, "pipeline.ts") });

    assert.match(rendered.workflow, /name: Setup Deno/);
    assert.match(rendered.workflow, /uses: denoland\/setup-deno@667a34cdef165d8d2b2e98dde39547c9daac7282 # v2\.0\.4/);
    assert.match(rendered.workflow, /deno-version: 2/);
    assert.match(rendered.workflow, /cache: true/);
    assert.match(rendered.workflow, /cache-hash: \$\{\{ hashFiles\('deno\.lock'\) \}\}/);
    assert.match(rendered.workflow, /deno install --frozen=true/);
    assert.match(rendered.workflow, /command: "deno run -A npm:@async\/pipeline\/cli github check && deno run -A npm:@async\/pipeline\/cli run verify"/);
    assert.doesNotMatch(rendered.workflow, /pnpm\/setup@/);
    assert.doesNotMatch(rendered.workflow, /async\/actions\/setup@v0/);
    assert.doesNotMatch(rendered.workflow, /pnpm runtime set deno/);
    assert.doesNotMatch(rendered.workflow, /pnpm install --frozen-lockfile/);
    assert.equal(rendered.lock.packageManager, "deno");
    assert.deepEqual(rendered.lock.runtime, ["deno@2"]);
    assert.equal(rendered.lock.command, "deno run -A npm:@async/pipeline/cli");
    assert.equal(rendered.lock.dependencyCachePath, "deno.lock");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("renders mixed node and deno runtimes through pnpm and setup-deno providers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-github-mixed-runtime-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ packageManager: "pnpm@11.1.0" }), "utf8");
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    const pipeline = definePipeline({
      name: "test",
      sync: {
        github: {
          runtime: ["node@24", "deno@2"]
        }
      },
      tasks: {
        verify: task({ requires: { runtime: "deno" }, run: sh`deno test` })
      },
      jobs: {
        verify: job({ target: "verify" })
      }
    });

    const rendered = await renderGitHubWorkflow(pipeline, { cwd: dir, configPath: join(dir, "pipeline.ts") });

    assert.match(rendered.workflow, /uses: pnpm\/setup@cf03a9b516e09bc5a90f041fc26fc930c9dc631b # v1\.0\.0/);
    assert.match(rendered.workflow, /runtime: node@24/);
    assert.match(rendered.workflow, /uses: denoland\/setup-deno@667a34cdef165d8d2b2e98dde39547c9daac7282 # v2\.0\.4/);
    assert.match(rendered.workflow, /deno-version: 2/);
    assert.doesNotMatch(rendered.workflow, /async\/actions\/setup@v0/);
    assert.doesNotMatch(rendered.workflow, /pnpm runtime set deno/);
    assert.match(rendered.workflow, /command: "pnpm async-pipeline github check && pnpm async-pipeline run verify"/);
    assert.deepEqual(rendered.lock.runtime, ["node@24", "deno@2"]);
    assert.equal(rendered.lock.command, "pnpm async-pipeline");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("renders generated Dependabot auto-merge workflow job", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-github-dependabot-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ packageManager: "pnpm@11.1.0" }), "utf8");
    const pipeline = definePipeline({
      name: "test",
      sync: {
        github: {
          dependabotAutoMerge: true
        }
      },
      triggers: {
        pr: trigger.github({ events: ["pull_request"] })
      },
      tasks: {
        verify: task({ run: sh`echo verify` })
      },
      jobs: {
        verify: job({ target: "verify", trigger: ["pr"] })
      }
    });

    const rendered = await renderGitHubWorkflow(pipeline, { cwd: dir, configPath: join(dir, "pipeline.ts") });

    assert.match(rendered.workflow, /pull_request_target:\n    types:\n      - "opened"\n      - "ready_for_review"\n      - "reopened"\n      - "synchronize"/);
    assert.match(rendered.workflow, /dependabot-auto-merge:\n    name: dependabot-auto-merge/);
    assert.match(rendered.workflow, /if: github\.event\.pull_request\.user\.login == 'dependabot\[bot\]' && github\.event\.pull_request\.draft == false/);
    assert.match(rendered.workflow, /uses: dependabot\/fetch-metadata@25dd0e34f4fe68f24cc83900b1fe3fe149efef98 # v3\.1\.0/);
    assert.match(rendered.workflow, asyncActionUses("dependabot-merge"));
    assert.match(rendered.workflow, /dependency-ecosystem: \$\{\{ steps\.dependabot-metadata\.outputs\.package-ecosystem \}\}/);
    assert.match(rendered.workflow, /allowed-ecosystems: \|\n            github-actions\n            npm\n            deno/);
    assert.deepEqual(rendered.lock.dependabotAutoMerge, {
      enabled: true,
      ecosystems: ["github-actions", "npm", "deno"]
    });
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("renders generated package preview job from packagePreviews true", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-github-package-preview-"));
  try {
    mkdirSync(join(dir, "packages", "pipeline"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "workspace", private: true, packageManager: "pnpm@11.1.0" }), "utf8");
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    writeFileSync(join(dir, "packages", "pipeline", "package.json"), JSON.stringify({ name: "@async/pipeline", version: "0.0.0" }), "utf8");
    const pipeline = definePipeline({
      name: "test",
      sync: {
        github: {
          packagePreviews: true,
          evidence: true
        }
      },
      tasks: {
        pack: task({ run: sh`echo pack` })
      },
      jobs: {
        verify: job({ target: "pack" })
      }
    });

    const rendered = await renderGitHubWorkflow(pipeline, { cwd: dir, configPath: join(dir, "pipeline.ts") });

    assert.match(rendered.workflow, /pull_request:\n    types:\n      - "opened"\n      - "ready_for_review"\n      - "reopened"\n      - "synchronize"/);
    assert.match(rendered.workflow, /package-preview:\n    name: package-preview/);
    assert.match(rendered.workflow, /if: github\.event_name == 'pull_request' && github\.event\.pull_request\.draft == false/);
    assert.match(rendered.workflow, /persist-credentials: false/);
    assert.match(rendered.workflow, /permissions:\n      contents: read\n      issues: write\n      packages: write\n      pull-requests: write/);
    assert.match(rendered.workflow, asyncActionUses("run"));
    assert.match(rendered.workflow, /command: "pnpm async-pipeline github check && pnpm async-pipeline run-task pack"/);
    assert.match(rendered.workflow, asyncActionUses("preview"));
    assert.match(rendered.workflow, /package-path: "packages\/pipeline"/);
    assert.match(rendered.workflow, /target-registry: "https:\/\/npm\.pkg\.github\.com"/);
    assert.match(rendered.workflow, /mode: pr/);
    assert.match(rendered.workflow, /GITHUB_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
    assert.match(rendered.workflow, /name: Publish package preview\n        id: async-package-preview/);
    assert.match(rendered.workflow, asyncActionUses("comment"));
    assert.match(rendered.workflow, /name: Comment package preview[\s\S]+if: github\.event_name == 'pull_request' && github\.event\.pull_request\.head\.repo\.full_name == github\.repository && steps\.async-package-preview\.outputs\.comment-body != ''/);
    assert.match(rendered.workflow, /mode: pr-comment/);
    assert.match(rendered.workflow, /marker: \$\{\{ steps\.async-package-preview\.outputs\.comment-marker \}\}/);
    assert.match(rendered.workflow, /body: \$\{\{ steps\.async-package-preview\.outputs\.comment-body \}\}/);
    assert.match(rendered.workflow, /token: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
    assert.match(rendered.workflow, asyncActionUses("evidence"));
    assert.match(rendered.workflow, /name: Collect evidence manifest[\s\S]+mode: collect[\s\S]+artifact-name: async-evidence-\$\{\{ github\.job \}\}/);
    assert.match(rendered.workflow, /evidence:\n    name: evidence\n    needs: \["package-preview","verify"\]\n    if: always\(\)/);
    assert.match(rendered.workflow, /name: Merge evidence manifests[\s\S]+mode: merge[\s\S]+artifact-pattern: async-evidence-\*/);
    assert.deepEqual(rendered.lock.packagePreviews, {
      enabled: true,
      package: "packages/pipeline",
      target: "pack",
      registry: "https://npm.pkg.github.com",
      tokenEnv: "GITHUB_TOKEN",
      comment: true
    });
    assert.equal(rendered.lock.actions.find((entry) => entry.id === "async.actions.comment")?.sha, asyncActionsSha);
    assert.deepEqual(rendered.lock.evidence, {
      enabled: true,
      job: "evidence",
      paths: [".async/runs"],
      receiptPaths: [".async/actions/receipts/**/*.json"],
      artifactNamePrefix: "async-evidence",
      retentionDays: 14,
      ifNoFilesFound: "warn",
      includeSummary: true
    });
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("renders and plans generated contract evidence jobs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-github-contract-"));
  try {
    mkdirSync(join(dir, "packages", "pipeline"), { recursive: true });
    mkdirSync(join(dir, "schemas"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "workspace", private: true, packageManager: "pnpm@11.1.0" }), "utf8");
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    writeFileSync(join(dir, "packages", "pipeline", "package.json"), JSON.stringify({ name: "@async/pipeline", version: "0.0.0" }), "utf8");
    writeFileSync(join(dir, "schemas", "user.json"), JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" }), "utf8");
    const pipeline = definePipeline({
      name: "test",
      sync: {
        github: {
          evidence: true,
          contract: {
            mode: "check",
            packagePath: "packages/pipeline",
            schema: {
              sources: ["schemas/**/*.json"],
              output: ".async/contract/schema-report.json"
            }
          }
        }
      },
      tasks: {
        verify: task({ run: sh`echo verify` })
      },
      jobs: {
        verify: job({ target: "verify" })
      }
    });

    const rendered = await renderGitHubWorkflow(pipeline, { cwd: dir, configPath: join(dir, "pipeline.ts") });

    assert.match(rendered.workflow, /pull_request:\n    types:/);
    assert.match(rendered.workflow, /workflow_dispatch:\n    inputs:\n      job:/);
    assert.match(rendered.workflow, /- "contract"/);
    assert.match(rendered.workflow, /contract:\n    name: contract/);
    assert.match(rendered.workflow, /github\.event_name == 'pull_request' && github\.event\.pull_request\.draft == false/);
    assert.match(rendered.workflow, asyncActionUses("contract"));
    assert.match(rendered.workflow, /name: Run contract evidence[\s\S]+mode: check/);
    assert.match(rendered.workflow, /checks: "api,claims,schema"/);
    assert.match(rendered.workflow, /package-path: "packages\/pipeline"/);
    assert.match(rendered.workflow, /schema-sources: \|\n            schemas\/\*\*\/\*\.json/);
    assert.match(rendered.workflow, /schema-output: "\.async\/contract\/schema-report\.json"/);
    assert.match(rendered.workflow, /evidence-dir: "\.async\/contract"/);
    assert.match(rendered.workflow, /fail-on: blocking/);
    assert.match(rendered.workflow, /name: Collect evidence manifest[\s\S]+paths: \|\n            \.async\/runs\n            \.async\/contract/);
    assert.match(rendered.workflow, /evidence:\n    name: evidence\n    needs: \["contract","verify"\]\n    if: always\(\)/);
    assert.equal(rendered.lock.actions.find((entry) => entry.id === "async.actions.contract")?.sha, asyncActionsSha);
    assert.deepEqual(rendered.lock.contract, {
      enabled: true,
      mode: "check",
      job: "contract",
      api: true,
      claims: true,
      schema: {
        enabled: true,
        sources: ["schemas/**/*.json"],
        output: ".async/contract/schema-report.json"
      },
      packagePath: "packages/pipeline",
      evidenceDir: ".async/contract",
      annotations: true
    });

    const checkPlan = await planGitHubJobs(pipeline, {
      cwd: dir,
      configPath: join(dir, "pipeline.ts"),
      job: "contract",
      eventName: "pull_request",
      eventAction: "opened",
      network: "deny"
    });
    assert.equal(checkPlan.manifests.length, 1);
    const manifest = checkPlan.manifests[0];
    assert.equal(manifest.job.id, "contract");
    assert.deepEqual(manifest.job.permissions, { contents: "read" });
    const contractStep = manifest.steps.find((entry) => entry.local.contract === "contract");
    assert.ok(contractStep);
    assert.equal(contractStep.with.mode, "check");
    assert.equal(contractStep.with["schema-output"], ".async/contract/schema-report.json");
    assert.equal(contractStep.local.networked, false);
    assert.ok(manifest.steps.some((entry) => entry.local.contract === "evidence" && Array.isArray(entry.with.paths) && entry.with.paths.includes(".async/contract")));
    const receipt = await runGitHubLocalManifest(manifest, dir);
    assert.equal(receipt.status, "passed");
    assert.ok(receipt.stepReceipts.some((entry) => entry.contract === "contract" && entry.decision === "mocked"));

    const reportPipeline = definePipeline({
      name: "test-report",
      sync: {
        github: {
          contract: {
            mode: "report",
            api: true,
            claims: false,
            schema: false
          }
        }
      },
      tasks: {
        verify: task({ run: sh`echo verify` })
      },
      jobs: {
        verify: job({ target: "verify" })
      }
    });
    const reportPlan = await planGitHubJobs(reportPipeline, {
      cwd: dir,
      configPath: join(dir, "pipeline.ts"),
      job: "contract",
      eventName: "pull_request",
      eventAction: "opened",
      network: "deny"
    });
    assert.equal(reportPlan.manifests[0].steps.find((entry) => entry.local.contract === "contract")?.with.mode, "report");
    assert.equal((await runGitHubLocalManifest(reportPlan.manifests[0], dir)).status, "passed");

    const releasePipeline = definePipeline({
      name: "test-release",
      sync: {
        github: {
          contract: {
            mode: "release",
            api: true,
            claims: false,
            schema: false
          }
        }
      },
      tasks: {
        verify: task({ run: sh`echo verify` })
      },
      jobs: {
        verify: job({ target: "verify" })
      }
    });
    const releaseRendered = await renderGitHubWorkflow(releasePipeline, { cwd: dir, configPath: join(dir, "pipeline.ts") });
    assert.match(releaseRendered.workflow, /release:\n    types:\n      - "published"/);
    assert.match(releaseRendered.workflow, /\(github\.event_name == 'release' && github\.event\.action == 'published'\)/);
    const releasePlan = await planGitHubJobs(releasePipeline, {
      cwd: dir,
      configPath: join(dir, "pipeline.ts"),
      eventName: "release",
      eventAction: "published"
    });
    assert.ok(releasePlan.manifests.some((entry) => entry.job.id === "contract"));
    const releasePrPlan = await planGitHubJobs(releasePipeline, {
      cwd: dir,
      configPath: join(dir, "pipeline.ts"),
      eventName: "pull_request"
    });
    assert.ok(releasePrPlan.skippedJobs.some((entry) => entry.id === "contract" && entry.reason === "event_filter"));
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("renders and plans generated hygiene evidence jobs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-github-hygiene-"));
  try {
    mkdirSync(join(dir, "packages", "pipeline"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "workspace", private: true, packageManager: "pnpm@11.1.0" }), "utf8");
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    writeFileSync(join(dir, "packages", "pipeline", "package.json"), JSON.stringify({ name: "@async/pipeline", version: "0.0.0" }), "utf8");
    const pipeline = definePipeline({
      name: "test",
      sync: {
        github: {
          evidence: true,
          hygiene: {
            mode: "report",
            profiles: ["package", "github", "docs", "release"],
            releaseGate: true,
            packagePath: "packages/pipeline"
          }
        }
      },
      tasks: {
        verify: task({ run: sh`echo verify` })
      },
      jobs: {
        verify: job({ target: "verify" })
      }
    });

    const rendered = await renderGitHubWorkflow(pipeline, { cwd: dir, configPath: join(dir, "pipeline.ts") });

    assert.match(rendered.workflow, /pull_request:\n    types:/);
    assert.match(rendered.workflow, /release:\n    types:\n      - "published"/);
    assert.match(rendered.workflow, /- "hygiene"/);
    assert.match(rendered.workflow, /hygiene:\n    name: hygiene/);
    assert.match(rendered.workflow, /github\.event_name == 'pull_request' && github\.event\.pull_request\.draft == false/);
    assert.match(rendered.workflow, /github\.event_name == 'release' && github\.event\.action == 'published'/);
    assert.match(rendered.workflow, asyncActionUses("hygiene"));
    assert.match(rendered.workflow, /name: Run hygiene evidence[\s\S]+mode: report/);
    assert.match(rendered.workflow, /profiles: "package,github,docs,release"/);
    assert.match(rendered.workflow, /package-path: "packages\/pipeline"/);
    assert.match(rendered.workflow, /evidence-dir: "\.async\/hygiene"/);
    assert.match(rendered.workflow, /fail-on: generated-policy/);
    assert.match(rendered.workflow, /release-gate: true/);
    assert.match(rendered.workflow, /name: Collect evidence manifest[\s\S]+paths: \|\n            \.async\/runs\n            \.async\/hygiene/);
    assert.match(rendered.workflow, /evidence:\n    name: evidence\n    needs: \["hygiene","verify"\]\n    if: always\(\)/);
    assert.equal(rendered.lock.actions.find((entry) => entry.id === "async.actions.hygiene")?.sha, asyncActionsSha);
    assert.deepEqual(rendered.lock.hygiene, {
      enabled: true,
      mode: "report",
      job: "hygiene",
      profiles: ["package", "github", "docs", "release"],
      releaseGate: true,
      packagePath: "packages/pipeline",
      evidenceDir: ".async/hygiene",
      annotations: true
    });

    const prPlan = await planGitHubJobs(pipeline, {
      cwd: dir,
      configPath: join(dir, "pipeline.ts"),
      job: "hygiene",
      eventName: "pull_request",
      eventAction: "opened",
      network: "deny"
    });
    assert.equal(prPlan.manifests.length, 1);
    const manifest = prPlan.manifests[0];
    assert.equal(manifest.job.id, "hygiene");
    assert.deepEqual(manifest.job.permissions, { contents: "read" });
    const hygieneStep = manifest.steps.find((entry) => entry.local.contract === "hygiene");
    assert.ok(hygieneStep);
    assert.equal(hygieneStep.with.mode, "report");
    assert.equal(hygieneStep.with["release-gate"], true);
    assert.equal(hygieneStep.with["fail-on"], "generated-policy");
    assert.equal(hygieneStep.local.networked, false);
    assert.ok(manifest.steps.some((entry) => entry.local.contract === "evidence" && Array.isArray(entry.with.paths) && entry.with.paths.includes(".async/hygiene")));
    const receipt = await runGitHubLocalManifest(manifest, dir);
    assert.equal(receipt.status, "passed");
    assert.ok(receipt.stepReceipts.some((entry) => entry.contract === "hygiene" && entry.decision === "mocked"));

    const releasePlan = await planGitHubJobs(pipeline, {
      cwd: dir,
      configPath: join(dir, "pipeline.ts"),
      job: "hygiene",
      eventName: "release",
      eventAction: "published",
      network: "deny"
    });
    assert.equal(releasePlan.manifests[0].job.id, "hygiene");
    assert.equal(releasePlan.manifests[0].steps.find((entry) => entry.local.contract === "hygiene")?.with["release-gate"], true);

    const gatedPipeline = definePipeline({
      name: "test-gated-release",
      sync: {
        github: {
          hygiene: {
            mode: "report",
            releaseGate: true
          }
        }
      },
      triggers: {
        release: trigger.github({ events: ["release"], types: ["published"] }),
        manual: trigger.manual()
      },
      tasks: {
        publish: task({ run: sh`echo publish` })
      },
      jobs: {
        publish: job({ target: "publish", trigger: ["release", "manual"] })
      }
    });
    const gatedRendered = await renderGitHubWorkflow(gatedPipeline, { cwd: dir, configPath: join(dir, "pipeline.ts") });
    assert.match(gatedRendered.workflow, /hygiene:\n    name: hygiene[\s\S]+github\.event\.inputs\.job == 'publish'/);
    assert.match(gatedRendered.workflow, /publish:\n    name: publish[\s\S]+needs: \["hygiene"\]/);
    const manualPublishPlan = await planGitHubJobs(gatedPipeline, {
      cwd: dir,
      configPath: join(dir, "pipeline.ts"),
      eventName: "workflow_dispatch",
      selectedJob: "publish",
      network: "deny"
    });
    assert.ok(manualPublishPlan.manifests.some((entry) => entry.job.id === "hygiene"));
    assert.ok(manualPublishPlan.manifests.some((entry) => entry.job.id === "publish"));

    const checkPipeline = definePipeline({
      name: "test-check",
      sync: {
        github: {
          hygiene: {
            mode: "check",
            profiles: ["repo"]
          }
        }
      },
      tasks: {
        verify: task({ run: sh`echo verify` })
      },
      jobs: {
        verify: job({ target: "verify" })
      }
    });
    const checkPlan = await planGitHubJobs(checkPipeline, {
      cwd: dir,
      configPath: join(dir, "pipeline.ts"),
      job: "hygiene",
      eventName: "pull_request",
      eventAction: "opened",
      network: "deny"
    });
    assert.equal(checkPlan.manifests[0].steps.find((entry) => entry.local.contract === "hygiene")?.with.mode, "check");
    assert.equal((await runGitHubLocalManifest(checkPlan.manifests[0], dir)).status, "passed");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("plans github action manifests with pinned refs, matrix rows, event skips, and artifact contracts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-github-plan-"));
  try {
    mkdirSync(join(dir, "packages", "pipeline"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "workspace", private: true, packageManager: "pnpm@11.1.0" }), "utf8");
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    writeFileSync(join(dir, "packages", "pipeline", "package.json"), JSON.stringify({ name: "@async/pipeline", version: "0.0.0" }), "utf8");
    const pipeline = definePipeline({
      name: "test",
      sync: {
        github: {
          packagePreviews: true,
          evidence: true
        }
      },
      triggers: {
        pr: trigger.github({ events: ["pull_request"] })
      },
      tasks: {
        verify: task({ run: sh`echo verify` }),
        pack: task({ run: sh`echo pack` })
      },
      jobs: {
        verify: job({
          target: "verify",
          trigger: ["pr"],
          github: { runsOnMatrix: ["ubuntu-latest", ["macos-latest", "large"]] }
        })
      }
    });

    const plan = await planGitHubJobs(pipeline, {
      cwd: dir,
      configPath: join(dir, "pipeline.ts"),
      job: "verify",
      eventName: "pull_request",
      eventAction: "opened",
      prNumber: 42,
      headRepo: "async/pipeline",
      headSha: "abc123",
      baseRef: "main"
    });

    assert.equal(plan.version, 1);
    assert.equal(plan.event.name, "pull_request");
    assert.equal(plan.event.pullRequest?.number, 42);
    assert.equal(plan.manifests.length, 1);
    const manifest = plan.manifests[0];
    assert.equal(manifest.version, 1);
    assert.equal(manifest.job.id, "verify");
    assert.equal(manifest.job.kind, "pipeline");
    assert.deepEqual(manifest.job.matrix, [
      { runner: ["ubuntu-latest"], index: 0 },
      { runner: ["macos-latest", "large"], index: 1 }
    ]);
    assert.equal(manifest.trust.actionRefsPinned, true);
    assert.equal(manifest.local.permissionsMode, "enforced");
    assert.ok(manifest.local.mocks.includes("setup"));
    assert.ok(manifest.local.mocks.includes("run"));
    assert.ok(manifest.local.mocks.includes("evidence"));
    for (const step of manifest.steps.filter((entry) => entry.uses)) {
      assert.match(step.uses, /@[0-9a-f]{40}/u);
      assert.doesNotMatch(step.uses, /@v0(?:\s|$)/u);
    }
    assert.ok(manifest.steps.some((entry) => entry.local.contract === "setup"));
    assert.ok(manifest.steps.some((entry) => entry.local.contract === "run"));
    assert.ok(manifest.steps.some((entry) => entry.local.contract === "evidence"));
    assert.ok(manifest.artifacts.some((entry) => entry.name === "async-pipeline-${{ github.job }}-runs" && entry.mode === "local"));
    assert.ok(plan.skippedJobs.some((entry) => entry.id === "package-preview" && entry.reason === "job_filter"));

    const pushPlan = await planGitHubJobs(pipeline, {
      cwd: dir,
      configPath: join(dir, "pipeline.ts"),
      eventName: "push",
      ref: "refs/heads/main"
    });
    assert.ok(pushPlan.skippedJobs.some((entry) => entry.id === "verify" && entry.reason === "event_filter"));
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("runs github manifests locally with receipts, artifact directories, permission checks, and network denial", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-github-local-run-"));
  try {
    mkdirSync(join(dir, "packages", "pipeline"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "workspace", private: true, packageManager: "pnpm@11.1.0" }), "utf8");
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    writeFileSync(join(dir, "packages", "pipeline", "package.json"), JSON.stringify({ name: "@async/pipeline", version: "0.0.0" }), "utf8");
    const pipeline = definePipeline({
      name: "test",
      sync: {
        github: {
          packagePreviews: true,
          evidence: true
        }
      },
      tasks: {
        pack: task({ run: sh`echo pack` })
      },
      jobs: {
        verify: job({ target: "pack" })
      }
    });

    const plan = await planGitHubJobs(pipeline, {
      cwd: dir,
      configPath: join(dir, "pipeline.ts"),
      job: "package-preview",
      eventName: "pull_request",
      eventAction: "opened",
      prNumber: 7,
      headRepo: "async/pipeline",
      baseRef: "main"
    });
    const manifest = plan.manifests[0];

    const receipt = await runGitHubLocalManifest(manifest, dir);
    assert.equal(receipt.status, "passed");
    assert.equal(receipt.network, "mock");
    assert.ok(receipt.manifestPath);
    assert.equal(existsSync(join(dir, receipt.manifestPath)), true);
    assert.equal(existsSync(join(dir, ".async/github-local/jobs/package-preview/receipt.json")), true);
    assert.equal(existsSync(join(dir, ".async/github-local/jobs/package-preview/steps/01-checkout.json")), true);
    assert.ok(receipt.stepReceipts.some((entry) => entry.contract === "preview" && entry.decision === "mocked"));
    for (const artifact of manifest.artifacts) {
      assert.equal(existsSync(join(dir, ".async/github-local/jobs/package-preview/artifacts", localArtifactDirName(artifact.name))), true);
    }

    const deniedNetworkManifest = {
      ...manifest,
      local: { ...manifest.local, network: "deny" }
    };
    const deniedNetwork = await runGitHubLocalManifest(deniedNetworkManifest, dir);
    assert.equal(deniedNetwork.status, "failed");
    assert.match(deniedNetwork.issues.join("\n"), /networked step is denied by --network deny/);

    const missingPermissionManifest = {
      ...manifest,
      job: { ...manifest.job, permissions: { contents: "read" } }
    };
    const deniedPermission = await runGitHubLocalManifest(missingPermissionManifest, dir);
    assert.equal(deniedPermission.status, "failed");
    assert.match(deniedPermission.issues.join("\n"), /requires packages: write/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("plans async bridge manifests with constraints, secrets, and lease-aware receipts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-github-bridge-plan-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "workspace", private: true, packageManager: "pnpm@11.1.0" }), "utf8");
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    const pipeline = definePipeline({
      name: "test",
      sync: {
        github: {
          bridge: {
            mode: "actions",
            schedule: "*/15 * * * *",
            branchPrefix: "async/bridge/",
            allowedPaths: ["pipeline.ts", "package.json", "docs/**"],
            endpointVar: "ASYNC_BRIDGE_URL",
            tokenEnv: "ASYNC_BRIDGE_TOKEN",
            packageVersion: "0.1.1"
          },
          evidence: true
        }
      },
      tasks: {
        verify: task({ run: sh`echo verify` })
      },
      jobs: {
        verify: job({ target: "verify" })
      }
    });

    const plan = await planGitHubJobs(pipeline, {
      cwd: dir,
      configPath: join(dir, "pipeline.ts"),
      job: "async-bridge",
      eventName: "workflow_dispatch"
    });

    assert.equal(plan.manifests.length, 1);
    const manifest = plan.manifests[0];
    assert.equal(manifest.job.id, "async-bridge");
    assert.deepEqual(manifest.job.permissions, { contents: "write", "pull-requests": "write" });
    assert.equal(manifest.job.concurrency, "async-bridge-${{ github.repository }}");
    assert.deepEqual(manifest.job.trigger, ["schedule", "workflow_dispatch"]);
    const bridgeStep = manifest.steps.find((entry) => entry.local.contract === "storage-bridge");
    assert.ok(bridgeStep);
    assert.match(bridgeStep.with.command, /"@async\/github-app@0\.1\.1" actions pull/);
    assert.match(bridgeStep.with.command, /--branch-prefix async\/bridge\//);
    assert.match(bridgeStep.with.command, /--allowed-path pipeline\.ts/);
    assert.match(bridgeStep.with.command, /--allowed-path package\.json/);
    assert.match(bridgeStep.with.command, /--allowed-path "docs\/\*\*"/);
    assert.deepEqual(bridgeStep.secrets, ["ASYNC_BRIDGE_TOKEN", "GITHUB_TOKEN"]);
    assert.equal(bridgeStep.local.networked, true);
    assert.equal(bridgeStep.local.dangerous, true);
    assert.equal(bridgeStep.env.ASYNC_PROJECT_URL, "${{ vars.ASYNC_BRIDGE_URL }}");
    assert.equal(bridgeStep.env.ASYNC_PROJECT_TOKEN, "${{ secrets.ASYNC_BRIDGE_TOKEN }}");
    assert.equal(bridgeStep.env.GITHUB_TOKEN, "${{ secrets.GITHUB_TOKEN }}");
    assert.ok(manifest.artifacts.some((entry) => entry.name === "async-evidence-${{ github.job }}" && entry.mode === "upload"));
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("renders agent evidence bundles and comment handoff for agent jobs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-github-agent-evidence-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "workspace", private: true, packageManager: "pnpm@11.1.0" }), "utf8");
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    const pipeline = definePipeline({
      name: "test",
      sync: { github: { evidence: true } },
      triggers: {
        pr: trigger.github({ events: ["pull_request"] })
      },
      agents: {
        mock: { command: ["node", "scripts/mock-agent.mjs"], model: "mock" }
      },
      tasks: {
        prepare: task({ run: sh`echo prep` }),
        review: task({
          dependsOn: ["prepare"],
          outputs: ["claims.patch", "review.md"],
          run: agent({ use: "mock", prompt: "review the change", stdoutTo: "review.md" })
        })
      },
      jobs: {
        review: job({
          target: "review",
          trigger: ["pr"],
          github: { permissions: { issues: "write", pullRequests: "write" } }
        })
      }
    });

    const rendered = await renderGitHubWorkflow(pipeline, { cwd: dir, configPath: join(dir, "pipeline.ts") });

    assert.match(rendered.workflow, asyncActionUses("agent-evidence"));
    assert.match(rendered.workflow, /name: Bundle agent evidence[\s\S]+id: async-agent-evidence[\s\S]+mode: comment/);
    assert.match(rendered.workflow, /outputs: \|\n            claims\.patch\n            review\.md/);
    assert.match(rendered.workflow, /receipt-path: "\.async\/actions\/receipts\/\$\{\{ github\.job \}\}-agent-evidence\.json"/);
    assert.match(rendered.workflow, /comment-marker: async-agent-evidence-\$\{\{ github\.job \}\}/);
    assert.match(rendered.workflow, /name: Comment agent evidence[\s\S]+if: github\.event_name == 'pull_request' && github\.event\.pull_request\.head\.repo\.full_name == github\.repository && steps\.async-agent-evidence\.outputs\.comment-body != ''/);
    assert.match(rendered.workflow, /body: \$\{\{ steps\.async-agent-evidence\.outputs\.comment-body \}\}/);
    assert.match(rendered.workflow, /token: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
    assert.match(rendered.workflow, /receipt-paths: \|\n            \.async\/actions\/receipts\/\*\*\/\*\.json/);
    assert.equal(rendered.lock.actions.find((entry) => entry.id === "async.actions.agent-evidence")?.sha, asyncActionsSha);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("renders source impact planning and matrix jobs from sync github sourceImpact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-github-source-impact-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ packageManager: "pnpm@11.1.0" }), "utf8");
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    const pipeline = definePipeline({
      name: "test",
      sync: {
        github: {
          sourceImpact: true,
          evidence: true
        }
      },
      sources: {
        app: source.path({
          path: "repos/app",
          pipeline: "pipeline.js",
          writable: true,
          prepare: [sh`node tools/prepare.mjs`]
        })
      },
      tasks: {
        local: task({ run: sh`echo local` }),
        impact: task({ dependsOn: ["local", "app:test"], run: sh`echo impact` })
      },
      jobs: {
        verifyImpact: job({ target: "impact" })
      }
    });

    const rendered = await renderGitHubWorkflow(pipeline, { cwd: dir, configPath: join(dir, "pipeline.ts") });

    assert.match(rendered.workflow, asyncActionUses("source-impact"));
    assert.match(rendered.workflow, /verifyimpact-source-plan:\n    name: verifyimpact-source-plan/);
    assert.match(rendered.workflow, /outputs:\n      matrix: \$\{\{ steps\.source-plan\.outputs\.matrix \}\}/);
    assert.match(rendered.workflow, /cat > \.async\/actions\/source-impact\/verifyImpact-source-plan\.json <<'ASYNC_SOURCE_PLAN'/);
    assert.match(rendered.workflow, /"generatedBy": "@async\/pipeline"/);
    assert.match(rendered.workflow, /"task": "app:test"/);
    assert.match(rendered.workflow, /"prepare": \[\n\s+"node tools\/prepare\.mjs"\n\s+\]/);
    assert.match(rendered.workflow, /verifyimpact-sources:\n    name: verifyImpact source \(\$\{\{ matrix\.source \}\}:\$\{\{ matrix\.taskId \}\}\)/);
    assert.match(rendered.workflow, /needs: "verifyimpact-source-plan"/);
    assert.match(rendered.workflow, /matrix: \$\{\{ fromJSON\(needs\['verifyimpact-source-plan'\]\.outputs\.matrix \|\| '\{"include":\[\]\}'\) \}\}/);
    assert.match(rendered.workflow, /name: Validate source checkout[\s\S]+mode: checkout[\s\S]+source-id: \$\{\{ matrix\.source \}\}/);
    assert.match(rendered.workflow, /name: Prepare source checkout[\s\S]+mode: prepare[\s\S]+path: \$\{\{ matrix\.path \}\}/);
    assert.match(rendered.workflow, /command: "pnpm async-pipeline github check && pnpm async-pipeline run-task \\"\$\{\{ matrix\.task \}\}\\""/);
    assert.match(rendered.workflow, /evidence:\n    name: evidence\n    needs: \["verifyImpact","verifyimpact-source-plan","verifyimpact-sources"\]\n    if: always\(\)/);
    assert.deepEqual(rendered.lock.sourceImpact, {
      enabled: true,
      jobs: [],
      generatedJobs: [
        {
          job: "verifyImpact",
          planJob: "verifyimpact-source-plan",
          matrixJob: "verifyimpact-sources",
          matrixRows: 1,
          sources: ["app"]
        }
      ]
    });
    assert.equal(rendered.lock.actions.find((entry) => entry.id === "async.actions.source-impact")?.sha, asyncActionsSha);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("renders lifecycle publish tasks as async action steps", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-github-lifecycle-actions-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@async/example", version: "1.2.3", packageManager: "pnpm@11.1.0" }), "utf8");
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    const pipeline = definePipeline({
      name: "test",
      sync: {
        github: {
          attest: {
            artifacts: ["dist/*.tgz"],
            subjectManifest: ".async/attest/release-subjects.json",
            sbomPath: ".async/attest/release-sbom.json",
            evidencePath: ".async/actions/receipts/release-attest.json",
            requireNpmProvenance: true,
            tarballScan: true,
            githubAttestation: true
          }
        }
      },
      triggers: {
        main: trigger.github({ events: ["push"], branches: ["main"] }),
        release: trigger.github({ events: ["release"], types: ["published"] })
      },
      tasks: {
        pack: task({ run: sh`npm pack --dry-run` }),
        "release-evidence": task({
          dependsOn: ["pack"],
          outputs: [".async/release/evidence.json"],
          run: sh`pnpm run release:evidence:check`
        }),
        snapshot: task({
          dependsOn: ["pack"],
          run: sh`pnpm async-pipeline publish github main --package .`
        }),
        "release-ensure": task({
          dependsOn: ["release-evidence"],
          run: sh`pnpm async-pipeline release ensure --package .`
        }),
        "publish-github": task({
          dependsOn: ["release-ensure"],
          run: sh`pnpm async-pipeline publish github release --package .`
        }),
        publish: task({
          dependsOn: ["publish-github"],
          run: [
            sh`pnpm async-pipeline publish npm --package .`,
            sh`pnpm async-pipeline release doctor --package .`
          ]
        })
      },
      jobs: {
        snapshot: job({
          target: "snapshot",
          trigger: ["main"],
          env: { GITHUB_TOKEN: env.secret("GITHUB_TOKEN") },
          github: { permissions: { packages: "write" } }
        }),
        publish: job({
          target: "publish",
          trigger: ["release"],
          requires: { provenance: true },
          env: {
            GITHUB_TOKEN: env.secret("GITHUB_TOKEN"),
            NODE_AUTH_TOKEN: env.secret("NPM_TOKEN")
          },
          github: { permissions: { contents: "write", packages: "write" } }
        })
      }
    });

    const rendered = await renderGitHubWorkflow(pipeline, { cwd: dir, configPath: join(dir, "pipeline.ts") });

    assert.doesNotMatch(rendered.workflow, /async-pipeline run snapshot/);
    assert.doesNotMatch(rendered.workflow, /async-pipeline run publish/);
    assert.match(rendered.workflow, /name: Run pipeline task pack/);
    assert.match(rendered.workflow, /command: "pnpm async-pipeline github check && pnpm async-pipeline run-task pack"/);
    assert.match(rendered.workflow, /name: Run pipeline task release-evidence/);
    assert.match(rendered.workflow, /command: "pnpm async-pipeline github check && pnpm async-pipeline run-task release-evidence"/);
    assert.ok(
      rendered.workflow.indexOf("Run pipeline task release-evidence") < rendered.workflow.indexOf("Create or update GitHub Release"),
      "package-owned release evidence must run before generated release publishing steps"
    );
    assert.match(rendered.workflow, /artifact-name: async-pipeline-\$\{\{ github\.job \}\}-pack-runs/);
    assert.match(rendered.workflow, asyncActionUses("preview"));
    assert.match(rendered.workflow, /package-path: "\."/);
    assert.match(rendered.workflow, /target-registry: "https:\/\/npm\.pkg\.github\.com"/);
    assert.match(rendered.workflow, /mode: main/);
    assert.match(rendered.workflow, /comment: false/);
    assert.match(rendered.workflow, asyncActionUses("publish"));
    assert.match(rendered.workflow, /mode: github-release/);
    assert.match(rendered.workflow, /mode: github-packages/);
    assert.match(rendered.workflow, /mode: npm/);
    assert.match(rendered.workflow, /provenance: true/);
    assert.match(rendered.workflow, asyncActionUses("doctor"));
    assert.match(rendered.workflow, /name: Plan release package[\s\S]+mode: plan[\s\S]+release-command: "npx --yes github:async\/release#e8c938ae44f11558fbbac1c805e0ce81ad765080"/);
    assert.match(rendered.workflow, /name: Inspect release package[\s\S]+mode: inspect/);
    assert.match(rendered.workflow, /name: Check release changelog[\s\S]+mode: changelog/);
    assert.match(rendered.workflow, /name: Render release notes[\s\S]+mode: notes/);
    assert.match(rendered.workflow, /name: Create or update GitHub Release[\s\S]+notes-file: \.async\/release\/release-notes\.md/);
    assert.match(rendered.workflow, /mode: doctor/);
    assert.match(rendered.workflow, /NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/);
    assert.match(rendered.workflow, /publish:\n    name: publish[\s\S]+permissions:\n      contents: write\n      id-token: write\n      packages: write/);
    assert.match(rendered.workflow, asyncActionUses("attest"));
    assert.match(rendered.workflow, /name: Create attestation subject manifest[\s\S]+mode: digest[\s\S]+artifacts: \|\n            dist\/\*\.tgz[\s\S]+subject-manifest: \.async\/attest\/release-subjects\.json[\s\S]+tarball-scan: true/);
    assert.match(rendered.workflow, /name: Write attestation SBOM evidence[\s\S]+mode: sbom[\s\S]+sbom-path: \.async\/attest\/release-sbom\.json/);
    assert.match(rendered.workflow, /name: Record GitHub attestation intent[\s\S]+mode: attest[\s\S]+github-attestation: true/);
    assert.deepEqual(rendered.lock.attest, {
      enabled: true,
      packagePath: undefined,
      artifacts: ["dist/*.tgz"],
      subjectManifest: ".async/attest/release-subjects.json",
      sbomPath: ".async/attest/release-sbom.json",
      evidencePath: ".async/actions/receipts/release-attest.json",
      requireNpmProvenance: true,
      tarballScan: true,
      githubAttestation: true
    });
    assert.equal(rendered.lock.actions.find((entry) => entry.id === "async.actions.attest")?.sha, asyncActionsSha);
    assert.equal(rendered.lock.actions.find((entry) => entry.id === "async.actions.doctor")?.sha, asyncActionsSha);

    const packBlock = stepBlock(rendered.workflow, "Run pipeline task pack");
    assert.doesNotMatch(packBlock, /GITHUB_TOKEN/);
    assert.doesNotMatch(packBlock, /NODE_AUTH_TOKEN/);

    const releaseEvidenceBlock = stepBlock(rendered.workflow, "Run pipeline task release-evidence");
    assert.doesNotMatch(releaseEvidenceBlock, /GITHUB_TOKEN/);
    assert.doesNotMatch(releaseEvidenceBlock, /NODE_AUTH_TOKEN/);

    const previewBlock = stepBlock(rendered.workflow, "Publish main package preview");
    assert.match(previewBlock, /GITHUB_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
    assert.doesNotMatch(previewBlock, /NODE_AUTH_TOKEN/);

    const releaseBlock = stepBlock(rendered.workflow, "Create or update GitHub Release");
    assert.match(releaseBlock, /GITHUB_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
    assert.doesNotMatch(releaseBlock, /NODE_AUTH_TOKEN/);

    const githubPackagesBlock = stepBlock(rendered.workflow, "Publish GitHub Packages mirror");
    assert.match(githubPackagesBlock, /token-env-name: GITHUB_TOKEN/);
    assert.match(githubPackagesBlock, /GITHUB_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
    assert.doesNotMatch(githubPackagesBlock, /NODE_AUTH_TOKEN/);

    const npmBlock = stepBlock(rendered.workflow, "Publish npm package");
    assert.match(npmBlock, /token-env-name: NODE_AUTH_TOKEN/);
    assert.match(npmBlock, /NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/);
    assert.doesNotMatch(npmBlock, /GITHUB_TOKEN/);

    const doctorBlock = stepBlock(rendered.workflow, "Run release doctor");
    assert.match(doctorBlock, asyncActionUses("doctor"));
    assert.match(doctorBlock, /GITHUB_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
    assert.doesNotMatch(doctorBlock, /NODE_AUTH_TOKEN/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("renders attestation digest steps without id-token when GitHub attestation is not requested", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-github-attest-no-oidc-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@async/example", version: "1.2.3", packageManager: "pnpm@11.1.0" }), "utf8");
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    const pipeline = definePipeline({
      name: "test",
      sync: {
        github: {
          attest: {
            artifacts: ["package.json"],
            tarballScan: true
          }
        }
      },
      tasks: {
        publish: task({ run: sh`pnpm async-pipeline publish npm --package .` })
      },
      jobs: {
        publish: job({
          target: "publish",
          env: { NODE_AUTH_TOKEN: env.secret("NPM_TOKEN") }
        })
      }
    });

    const rendered = await renderGitHubWorkflow(pipeline, { cwd: dir, configPath: join(dir, "pipeline.ts") });

    assert.match(rendered.workflow, asyncActionUses("attest"));
    const publishJob = jobBlock(rendered.workflow, "publish");
    assert.doesNotMatch(publishJob, /id-token: write/);
    assert.match(publishJob, /name: Create attestation subject manifest/);
    assert.doesNotMatch(publishJob, /name: Record GitHub attestation intent/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("keeps lifecycle publish commands in the pipeline runner when shell semantics are not equivalent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-github-lifecycle-fallback-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@async/example", version: "1.2.3", packageManager: "pnpm@11.1.0" }), "utf8");
    const pipeline = definePipeline({
      name: "test",
      tasks: {
        publish: task({
          run: sh`pnpm async-pipeline publish npm --package . && echo after-publish`
        }),
        retrying: task({
          retry: 2,
          run: sh`pnpm async-pipeline publish npm --package .`
        }),
        timed: task({
          timeout: "2m",
          run: sh`pnpm async-pipeline publish npm --package .`
        })
      },
      jobs: {
        publish: job({ target: "publish", env: { NODE_AUTH_TOKEN: env.secret("NPM_TOKEN") } }),
        retrying: job({ target: "retrying", env: { NODE_AUTH_TOKEN: env.secret("NPM_TOKEN") } }),
        timed: job({ target: "timed", env: { NODE_AUTH_TOKEN: env.secret("NPM_TOKEN") } })
      }
    });

    const rendered = await renderGitHubWorkflow(pipeline, { cwd: dir, configPath: join(dir, "pipeline.ts") });

    assert.match(rendered.workflow, /command: "pnpm async-pipeline github check && pnpm async-pipeline run publish"/);
    assert.match(rendered.workflow, /command: "pnpm async-pipeline github check && pnpm async-pipeline run retrying"/);
    assert.match(rendered.workflow, /command: "pnpm async-pipeline github check && pnpm async-pipeline run timed"/);
    assert.match(rendered.workflow, asyncActionUses("run"));
    assert.doesNotMatch(rendered.workflow, asyncActionUses("publish"));
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("packagePreviews true requires explicit package when multiple public packages exist", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-github-package-preview-ambiguous-"));
  try {
    mkdirSync(join(dir, "packages", "one"), { recursive: true });
    mkdirSync(join(dir, "packages", "two"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "workspace", private: true, packageManager: "pnpm@11.1.0" }), "utf8");
    writeFileSync(join(dir, "packages", "one", "package.json"), JSON.stringify({ name: "@async/one", version: "0.0.0" }), "utf8");
    writeFileSync(join(dir, "packages", "two", "package.json"), JSON.stringify({ name: "@async/two", version: "0.0.0" }), "utf8");
    const pipeline = definePipeline({
      name: "test",
      sync: {
        github: {
          packagePreviews: true
        }
      },
      tasks: {
        pack: task({ run: sh`echo pack` })
      },
      jobs: {
        verify: job({ target: "pack" })
      }
    });

    await assert.rejects(
      () => renderGitHubWorkflow(pipeline, { cwd: dir, configPath: join(dir, "pipeline.ts") }),
      /ASYNC_PIPELINE_PACKAGE_PREVIEWS_AMBIGUOUS_PACKAGE|multiple public packages/
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("renders github job environment and secret env wiring", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-github-env-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ packageManager: "pnpm@11.1.0" }), "utf8");
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
    writeFileSync(join(dir, "package.json"), JSON.stringify({ packageManager: "pnpm@11.1.0" }), "utf8");
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
    writeFileSync(join(dir, "package.json"), JSON.stringify({ packageManager: "pnpm@11.1.0" }), "utf8");
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
    assert.match(rendered.workflow, /command: "pnpm async-pipeline github check && pnpm async-pipeline run pages"/);
    assert.match(rendered.workflow, new RegExp(`uses: async/actions/pages@${asyncActionsRefPattern}\\n        with:\\n          mode: jekyll\\n          source: "\\./docs"\\n          destination: "\\./_site"`));
    assert.match(rendered.workflow, /pages-deploy:\n    name: pages-deploy\n    needs: "pages"\n    if: github\.event_name != 'pull_request'\n    runs-on: ubuntu-latest/);
    assert.match(rendered.workflow, /environment:\n      name: "github-pages"\n      url: "\$\{\{ steps\.deployment\.outputs\.page_url \}\}"/);
    assert.match(rendered.workflow, /permissions:\n      pages: write\n      id-token: write/);
    assert.match(rendered.workflow, new RegExp(`uses: async/actions/pages@${asyncActionsRefPattern}\\n        with:\\n          upload: false\\n          deploy: true`));
    assert.deepEqual(rendered.lock.manualDispatchJobs, ["pages"]);
    assert.deepEqual(rendered.lock.jobs[0].github.pages, {
      build: { kind: "jekyll", source: "./docs", destination: "./_site" }
    });
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("renders generated github pages jobs from sync github pages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-github-sync-pages-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ packageManager: "pnpm@11.1.0" }), "utf8");
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    const pipeline = definePipeline({
      name: "pages-sync-test",
      sync: {
        github: {
          pages: {
            target: "docs.site",
            job: "docs-pages",
            build: { kind: "static", path: ".async/pages" }
          }
        }
      },
      tasks: {
        "docs.site": task({ run: sh`node scripts/build-pages.js` }),
        test: task({ run: sh`node --test` })
      },
      jobs: {
        verify: job({ target: "test" })
      }
    });

    const rendered = await renderGitHubWorkflow(pipeline, { cwd: dir, configPath: join(dir, "pipeline.ts") });

    assert.match(rendered.workflow, /pull_request:/);
    assert.match(rendered.workflow, /push:\n    branches:\n      - "main"/);
    assert.match(rendered.workflow, /options:\n          - "docs-pages"/);
    assert.match(rendered.workflow, /docs-pages:\n    name: docs-pages/);
    assert.match(rendered.workflow, /if: github\.event_name == 'pull_request' \|\| \(github\.event_name == 'push' && \(github\.ref == 'refs\/heads\/main'\)\) \|\| \(github\.event_name == 'workflow_dispatch' && github\.event\.inputs\.job == 'docs-pages'\)/);
    assert.match(rendered.workflow, /command: "pnpm async-pipeline github check && pnpm async-pipeline run-task docs\.site"/);
    assert.doesNotMatch(rendered.workflow, /run: pnpm async-pipeline run docs-pages/);
    assert.match(rendered.workflow, new RegExp(`uses: async/actions/pages@${asyncActionsRefPattern}\\n        with:\\n          mode: static\\n          path: "\\.async/pages"`));
    assert.match(rendered.workflow, /docs-pages-deploy:\n    name: docs-pages-deploy\n    needs: "docs-pages"\n    if: github\.event_name != 'pull_request'/);
    assert.deepEqual(rendered.lock.manualDispatchJobs, ["docs-pages"]);
    assert.equal(rendered.lock.jobs.some((entry) => entry.id === "docs-pages"), false);
    assert.deepEqual(rendered.lock.pages, {
      enabled: true,
      target: "docs.site",
      job: "docs-pages",
      build: { kind: "static", path: ".async/pages" },
      triggers: {
        pullRequest: true,
        main: { branch: "main" },
        manual: true
      }
    });
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("generated github pages rejects missing targets and job conflicts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-github-sync-pages-invalid-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ packageManager: "pnpm@11.1.0" }), "utf8");
    const missingTarget = definePipeline({
      name: "pages-missing",
      sync: { github: { pages: { target: "missing" } } },
      tasks: {
        docs: task({ run: sh`echo docs` })
      },
      jobs: {
        verify: job({ target: "docs" })
      }
    });
    await assert.rejects(
      () => renderGitHubWorkflow(missingTarget, { cwd: dir, configPath: join(dir, "pipeline.ts") }),
      /ASYNC_PIPELINE_GITHUB_PAGES_UNKNOWN_TARGET|references missing task "missing"/
    );

    const jobConflict = definePipeline({
      name: "pages-conflict",
      sync: { github: { pages: true } },
      tasks: {
        pages: task({ run: sh`echo pages` })
      },
      jobs: {
        pages: job({ target: "pages" })
      }
    });
    await assert.rejects(
      () => renderGitHubWorkflow(jobConflict, { cwd: dir, configPath: join(dir, "pipeline.ts") }),
      /ASYNC_PIPELINE_GITHUB_PAGES_JOB_CONFLICT|conflicts with an existing pipeline job/
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("renders prerender github pages build through async pages action", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-github-prerender-pages-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ packageManager: "pnpm@11.1.0" }), "utf8");
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    const pipeline = definePipeline({
      name: "pages-prerender-test",
      sync: {
        github: {
          pages: {
            target: "docs.site",
            build: { kind: "prerender", path: ".async/prerender", validateIndex: true, spaFallback: true }
          }
        }
      },
      tasks: {
        "docs.site": task({ run: sh`node scripts/prerender.js` })
      },
      jobs: {
        verify: job({ target: "docs.site" })
      }
    });

    const rendered = await renderGitHubWorkflow(pipeline, { cwd: dir, configPath: join(dir, "pipeline.ts") });

    assert.match(rendered.workflow, new RegExp(`uses: async/actions/pages@${asyncActionsRefPattern}\\n        with:\\n          mode: prerender\\n          path: "\\.async/prerender"\\n          validate-index: true\\n          spa-fallback: true`));
    assert.deepEqual(rendered.lock.pages.build, {
      kind: "prerender",
      path: ".async/prerender",
      validateIndex: true,
      spaFallback: true
    });
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("renders github job packages, issues, and pull-requests permissions with a contents fallback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-github-permissions-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ packageManager: "pnpm@11.1.0" }), "utf8");
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
    writeFileSync(join(dir, "package.json"), JSON.stringify({ packageManager: "pnpm@11.1.0" }), "utf8");
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
    writeFileSync(join(dir, "package.json"), JSON.stringify({ packageManager: "pnpm@11.1.0" }), "utf8");
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
    assert.match(rendered.workflow, /command: "pnpm async-pipeline github check && pnpm async-pipeline run linux --execution linuxCi"/);
    assert.match(rendered.workflow, /apple:\n    name: apple\n    if: github\.event_name == 'workflow_dispatch' && github\.event\.inputs\.job == 'apple'\n    runs-on: \["self-hosted","macos","arm64","apple-container"\]/);
    assert.match(rendered.workflow, /command: "pnpm async-pipeline github check && pnpm async-pipeline run apple --execution appleCi"/);
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
      published: trigger.github({ events: ["release"], types: ["published"] }),
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
  assert.deepEqual(jobsForGitHubEvent(pipeline, { eventName: "release", action: "published" }).map((entry) => entry.id), ["published"]);
  assert.deepEqual(jobsForGitHubEvent(pipeline, { eventName: "release", action: "deleted" }).map((entry) => entry.id), []);
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
      packageManager: "pnpm@11.1.0",
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
    assert.equal(lock.actions.find((entry) => entry.id === "async.actions.run")?.sha, asyncActionsSha);
    assertAllRemoteActionRefsPinned(readFileSync(join(dir, ".github/workflows/async-pipeline.yml"), "utf8"));
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("github check rejects mutable remote action refs in generated workflows", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-github-mutable-ref-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ packageManager: "pnpm@11.1.0" }), "utf8");
    const pipeline = definePipeline({
      name: "test",
      tasks: {
        verify: task({ run: sh`echo verify` })
      },
      jobs: {
        verify: job({ target: "verify" })
      }
    });
    const rendered = await renderGitHubWorkflow(pipeline, { cwd: dir, configPath: join(dir, "pipeline.ts") });
    await writeGitHubWorkflow(rendered, dir);

    const workflowPath = join(dir, ".github/workflows/async-pipeline.yml");
    writeFileSync(
      workflowPath,
      readFileSync(workflowPath, "utf8").replace(`async/actions/run@${asyncActionsSha} # ${asyncActionsLabel}`, "async/actions/run@v0"),
      "utf8"
    );

    const issues = await checkGitHubWorkflow(rendered, dir);
    assert.match(issues.join("\n"), /mutable action refs \(async\/actions\/run@v0\)/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("github generate and check support custom output paths", () => {
  const dir = mkdtempSyncCompat("async-pipeline-github-custom-");
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({
      type: "module",
      packageManager: "pnpm@11.1.0",
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

function assertAllRemoteActionRefsPinned(workflow) {
  for (const value of remoteActionRefs(workflow)) {
    assert.match(value, /@[0-9a-f]{40}$/u, `${value} should be pinned to a full SHA`);
  }
}

function remoteActionRefs(workflow) {
  const refs = [];
  for (const line of workflow.split("\n")) {
    const match = /^\s*uses:\s*([^#\s]+)/u.exec(line);
    if (!match) continue;
    const value = match[1].replace(/^["']|["']$/gu, "");
    if (value.startsWith("./") || value.startsWith("../") || value.startsWith("docker://")) continue;
    refs.push(value);
  }
  return refs;
}

function stepBlock(workflow, name) {
  const start = workflow.indexOf(`      - name: ${name}`);
  assert.notEqual(start, -1, `missing step ${name}`);
  const next = workflow.indexOf("\n      - name:", start + 1);
  return workflow.slice(start, next < 0 ? undefined : next);
}

function jobBlock(workflow, name) {
  const start = workflow.indexOf(`  ${name}:`);
  assert.notEqual(start, -1, `missing job ${name}`);
  const searchStart = workflow.indexOf("\n", start) + 1;
  const nextMatch = /\n  [A-Za-z0-9_-]+:\n    name:/u.exec(workflow.slice(searchStart));
  const next = nextMatch ? searchStart + nextMatch.index : -1;
  return workflow.slice(start, next < 0 ? undefined : next);
}

function localArtifactDirName(value) {
  return value.replace(/[^A-Za-z0-9_.-]+/gu, "-");
}

function mkdtempSyncCompat(prefix) {
  const dir = join(tmpdir(), `${prefix}${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
