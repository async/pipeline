import { agent, definePipeline, env, job, sh, task, trigger } from "./packages/pipeline/dist/index.js";
import { hygieneTask } from "@async/hygiene/pipeline";
import hygieneConfig from "./hygiene.config.ts";

export default definePipeline({
  name: "async-pipeline",
  cache: "file:local",
  // ADR-0006: adapter profiles for the propose-only claims-repair task.
  // `claude` runs locally where credentials live; `mock` is the deterministic
  // stand-in (ASYNC_AGENT=mock) used anywhere without a model.
  agents: {
    claude: {
      command: ["claude", "-p"],
      model: env.var("ASYNC_AGENT_MODEL", { default: "claude-sonnet-4-6" })
    },
    mock: {
      command: ["node", "scripts/mock-claims-repair.mjs"],
      model: "mock"
    }
  },
  triggers: {
    pr: trigger.github({ events: ["pull_request"] }),
    main: trigger.github({ events: ["push"], branches: ["main"] }),
    release: trigger.github({ events: ["release"] }),
    manual: trigger.manual()
  },
  sync: {
    github: {
      dependabotAutoMerge: true,
      packagePreviews: true
    },
    tasks: {
      prefix: "pipeline",
      runners: ["package"],
      targets: [{ package: "async-pipeline-workspace" }],
      jobs: ["pages", "publish", "snapshot", "verify"],
      tasks: ["docs.site"],
      scripts: {
        "api-surface": "run-task api-surface",
        "api-surface:generate": "run-task api-surface-generate",
        "github:check": "github check",
        "github:generate": "github generate",
        "publish:github:main": "publish github main --package packages/pipeline",
        "publish:github:pr": "publish github pr --package packages/pipeline",
        "publish:github:release": "publish github release --package packages/pipeline",
        "publish:npm": "publish npm --package packages/pipeline",
        "release:ensure": "release ensure --package packages/pipeline",
        "release:doctor": "release doctor --package packages/pipeline",
        "sync:check": "sync check"
      }
    }
  },
  namedInputs: {
    default: [
      "packages/**/*.ts",
      "tests/**/*.test.js",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "tsconfig.base.json"
    ],
    production: [
      "packages/**/*.ts",
      "!tests/**/*.test.js"
    ]
  },
  tasks: {
    drift: task({
      description: "Release metadata drift checks: CHANGELOG entry, engines floor, workflow Node versions.",
      inputs: [
        "CHANGELOG.md",
        "package.json",
        "packages/*/package.json",
        ".github/workflows/async-pipeline.yml",
        "examples/*/.github/workflows/*.yml",
        "scripts/check-release-drift.mjs"
      ],
      cache: true,
      run: sh`pnpm drift:check`
    }),
    docs: task({
      description: "Docs-drift checks: every relative link and anchor in README.md and docs/ resolves, for GitHub rendering and the Pages build alike.",
      inputs: [
        "docs/**/*.md",
        "README.md",
        "scripts/check-docs.mjs"
      ],
      cache: true,
      run: sh`pnpm run docs:check`
    }),
    "sync-check": task({
      description: "All synced surfaces (generated workflow, lock, package scripts) still match pipeline.ts.",
      inputs: [
        "pipeline.ts",
        "package.json",
        ".github/workflows/async-pipeline.yml",
        ".github/async-pipeline.lock.json",
        ".async-pipeline/tasks.lock.json"
      ],
      cache: false,
      run: sh`pnpm async-pipeline sync check`
    }),
    hygiene: hygieneTask(hygieneConfig),
    // ADR-0006: propose-only repair for a failing claims task. Not part of
    // any job — run it by hand after a claims failure:
    //   async-pipeline run-task claims-repair        (claude, local)
    //   ASYNC_AGENT=mock async-pipeline run-task claims-repair
    // Review claims.patch, `git apply claims.patch`, re-run `pnpm claims:check`.
    // The checker stays the only authority; this task never edits anything.
    "claims-repair": task({
      description: "Draft a unified diff (claims.patch) updating stale anchors in tests/claims.json to the docs' current wording. Propose-only: a human reviews and applies.",
      inputs: [
        "tests/claims.json",
        "README.md",
        "AGENTS.md",
        "CHANGELOG.md",
        "docs/**/*.md",
        "scripts/check-claims.mjs"
      ],
      outputs: ["claims.patch"],
      cache: true,
      run: agent({
        use: env.var("ASYNC_AGENT", { default: "claude" }),
        stdoutTo: "claims.patch",
        prompt: [
          "You are repairing this repository's claims registry (tests/claims.json).",
          "scripts/check-claims.mjs requires every claim's `anchor` to appear verbatim in its `source` file.",
          "Find each anchor that no longer appears verbatim, locate the reworded sentence in the source doc, and update the anchor to the current exact text.",
          "Output ONLY a unified diff against tests/claims.json (no prose, no code fences) so it can be applied with `git apply claims.patch`.",
          "Preserve claim ids and tests arrays. Never delete a claim entry: if a promise was removed from the docs entirely, leave its entry unchanged — deletions are a human decision."
        ].join("\n")
      })
    }),
    claims: task({
      description: "Claim coverage checks: every registered doc claim still exists verbatim and is enforced by a named test; every PROMISE test is registered.",
      inputs: [
        "tests/claims.json",
        "scripts/check-claims.mjs",
        "README.md",
        "AGENTS.md",
        "CHANGELOG.md",
        "docs/api.md",
        "tests/**/*.test.js"
      ],
      cache: true,
      run: sh`pnpm claims:check`
    }),
    "api-surface-generate": task({
      description: "Regenerate the @async/pipeline API surface review ledgers from the checked-in manifests.",
      inputs: [
        "api-contract.json",
        "packages/pipeline/api-contract.json"
      ],
      outputs: [
        "API_SURFACE.md",
        "packages/pipeline/API_SURFACE.md"
      ],
      cache: false,
      run: [
        sh`pnpm api-contract ledger --manifest api-contract.json --out API_SURFACE.md`,
        sh`pnpm api-contract ledger --manifest packages/pipeline/api-contract.json --out packages/pipeline/API_SURFACE.md`
      ]
    }),
    "api-surface": task({
      description: "API surface drift checks: validate the @async/pipeline manifests and generated review ledgers through @async/api-contract.",
      inputs: [
        "api-contract.json",
        "API_SURFACE.md",
        "packages/pipeline/api-contract.json",
        "packages/pipeline/API_SURFACE.md"
      ],
      cache: true,
      run: [
        sh`pnpm api-contract check --manifest api-contract.json`,
        sh`pnpm api-contract ledger --manifest api-contract.json --check API_SURFACE.md`,
        sh`pnpm api-contract check --manifest packages/pipeline/api-contract.json`,
        sh`pnpm api-contract ledger --manifest packages/pipeline/api-contract.json --check packages/pipeline/API_SURFACE.md`
      ]
    }),
    build: task({
      inputs: ["production"],
      outputs: ["packages/*/dist/**"],
      cache: true,
      run: sh`pnpm run build`
    }),
    typecheck: task({
      dependsOn: ["build"],
      inputs: ["default"],
      cache: true,
      run: sh`pnpm typecheck`
    }),
    "docs.site": task({
      description: "Build the standardized GitHub Pages documentation site.",
      inputs: ["README.md", "docs/**/*.md", "scripts/build-pages.js"],
      outputs: [".async/pages/**"],
      cache: true,
      run: sh`node scripts/build-pages.js`
    }),
    test: task({
      dependsOn: ["typecheck"],
      inputs: ["default"],
      cache: true,
      run: sh`pnpm run test`
    }),
    examples: task({
      description: "Every committed example runs green from its own directory through the public CLI, and its committed sync artifacts are current.",
      dependsOn: ["build"],
      inputs: [
        "examples/**",
        "!examples/*/dist/**",
        "!examples/*/build/**",
        "!examples/**/*.tgz",
        "!examples/many-repo-impact-run/repos/*/candidate.json",
        "tests/examples/examples.test.js"
      ],
      cache: true,
      run: sh`node --test tests/examples/examples.test.js`
    }),
    pack: task({
      dependsOn: ["test", "drift", "claims", "docs", "api-surface", "sync-check", "examples", "hygiene"],
      inputs: ["production", "package.json", "packages/*/package.json", "scripts/check-exports.mjs"],
      cache: false,
      run: [sh`pnpm exports:check`, sh`pnpm pack:check`]
    }),
    // GitHub Packages publishing, adapted from PatrickJS's GitHub-native npm
    // preview packages gist (see examples/github-native-npm-preview-package).
    // PR package previews are generated by sync.github.packagePreviews.
    // The mirror uses the repository-owner scope because GitHub Packages
    // requires the npm scope to match the repo owner.
    snapshot: task({
      description: "Pushes to main publish an immutable 0.0.0-main.sha.<sha> snapshot to GitHub Packages and move the main dist-tag while the commit is still the branch head.",
      dependsOn: ["pack"],
      inputs: ["production", "package.json", "packages/*/package.json"],
      cache: false,
      run: sh`pnpm async-pipeline publish github main --package packages/pipeline`
    }),
    "publish-github": task({
      description: "Stable mirror to GitHub Packages (latest tag). Runs before the npm publish so a stable version always exists on GitHub Packages even when npm has an issue.",
      dependsOn: ["release-ensure"],
      inputs: ["production", "package.json", "packages/*/package.json"],
      cache: false,
      run: sh`pnpm async-pipeline publish github release --package packages/pipeline`
    }),
    "release-ensure": task({
      description: "Create or verify the release tag and GitHub Release before package publishing.",
      dependsOn: ["pack"],
      inputs: ["production", "package.json", "packages/*/package.json"],
      cache: false,
      run: sh`pnpm async-pipeline release ensure --package packages/pipeline`
    }),
    publish: task({
      // GitHub Packages first, then npm: the fallback registry is never
      // behind the primary one.
      dependsOn: ["publish-github"],
      inputs: ["production", "package.json", "packages/*/package.json"],
      cache: false,
      run: [
        sh`pnpm async-pipeline publish npm --package packages/pipeline`,
        sh`pnpm async-pipeline release doctor --package packages/pipeline`
      ]
    })
  },
  jobs: {
    verify: job({
      target: "pack",
      trigger: ["pr", "main", "release"],
      github: {
        // Both GitHub-hosted. Self-hosted label sets (e.g. Tart VMs on Apple
        // Silicon) are supported too; see docs/github-actions.md.
        runsOnMatrix: ["ubuntu-latest", "macos-latest"]
      }
    }),
    pages: job({
      target: "docs.site",
      trigger: ["pr", "main", "manual"],
      github: {
        pages: {
          build: { kind: "static", path: ".async/pages" }
        }
      }
    }),
    snapshot: job({
      target: "snapshot",
      trigger: ["main"],
      env: {
        GITHUB_TOKEN: env.secret("GITHUB_TOKEN")
      },
      github: {
        permissions: {
          packages: "write"
        }
      }
    }),
    publish: job({
      target: "publish",
      trigger: ["manual", "release"],
      environment: {
        name: "npm-publish",
        url: "https://www.npmjs.com/package/@async/pipeline"
      },
      requires: {
        provenance: true
      },
      env: {
        NODE_AUTH_TOKEN: env.secret("NPM_TOKEN"),
        GITHUB_TOKEN: env.secret("GITHUB_TOKEN")
      },
      github: {
        permissions: {
          contents: "write",
          packages: "write"
        }
      }
    })
  }
});
