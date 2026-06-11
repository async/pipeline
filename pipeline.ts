import { definePipeline, env, job, sh, task, trigger } from "./packages/pipeline/dist/index.js";

export default definePipeline({
  name: "async-pipeline",
  cache: "file:local",
  triggers: {
    pr: trigger.github({ events: ["pull_request"] }),
    main: trigger.github({ events: ["push"], branches: ["main"] }),
    release: trigger.github({ events: ["release"] }),
    manual: trigger.manual()
  },
  sync: {
    github: true,
    tasks: {
      prefix: "pipeline",
      runners: ["package"],
      targets: [{ package: "async-pipeline-workspace" }],
      jobs: ["verify"],
      scripts: {
        "github:check": "github check",
        "github:generate": "github generate",
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
    build: task({
      inputs: ["production"],
      outputs: ["packages/*/dist/**"],
      cache: true,
      run: sh`pnpm build`
    }),
    typecheck: task({
      dependsOn: ["build"],
      inputs: ["default"],
      cache: true,
      run: sh`pnpm typecheck`
    }),
    test: task({
      dependsOn: ["typecheck"],
      inputs: ["default"],
      cache: true,
      run: sh`pnpm test`
    }),
    pack: task({
      dependsOn: ["test", "drift", "claims"],
      inputs: ["production", "package.json", "packages/*/package.json", "scripts/check-exports.mjs"],
      cache: false,
      run: [sh`pnpm exports:check`, sh`pnpm pack:check`]
    }),
    publish: task({
      dependsOn: ["pack"],
      inputs: ["production", "package.json", "packages/*/package.json", "scripts/publish.mjs"],
      cache: false,
      run: sh`node scripts/publish.mjs`
    })
  },
  jobs: {
    verify: job({
      target: "pack",
      trigger: ["pr", "main", "release"],
      github: {
        // ubuntu is GitHub-hosted; macOS runs on a self-hosted Apple Silicon
        // runner managed by Tart VMs (e.g. Tartelet/ekiden hosts) that
        // registers with these labels. See docs/github-actions.md.
        runsOnMatrix: ["ubuntu-latest", ["self-hosted", "macos", "tart"]]
      }
    }),
    publish: job({
      target: "publish",
      trigger: ["manual"],
      environment: {
        name: "npm-publish",
        url: "https://www.npmjs.com/package/@async/pipeline"
      },
      requires: {
        provenance: true
      },
      env: {
        NODE_AUTH_TOKEN: env.secret("NPM_TOKEN")
      }
    })
  }
});
