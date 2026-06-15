import { defineConfig } from "@async/hygiene";

export default defineConfig({
  mode: "auto",
  targets: {
    packages: [{ name: "@async/pipeline", path: "packages/pipeline" }]
  },
  workflows: [
    ".github/workflows/*.yml",
    "examples/*/.github/workflows/*.yml"
  ],
  dependencies: {
    sources: ["packages", "scripts", "tests", "pipeline.ts"],
    rules: [
      {
        name: "ignore-local-hygiene-tooling-link",
        severity: "ignore",
        comment: "The self hygiene task imports the local @async/hygiene link; product dependency rules start below it.",
        from: { path: "^(pipeline|hygiene\\.config)\\.ts$" },
        to: { path: "^@async/hygiene" }
      },
      {
        name: "core-stays-runtime-agnostic",
        severity: "error",
        comment: "pipeline-core is the declaration/runtime model and must not import node adapters or the published wrapper.",
        from: { path: "^packages/pipeline-core/src" },
        to: { path: "^packages/(pipeline-node|pipeline-adapter-lima|pipeline)/" }
      },
      {
        name: "node-stays-below-adapters",
        severity: "error",
        comment: "pipeline-node may depend on core, but not on adapter packages or the published wrapper.",
        from: { path: "^packages/pipeline-node/src" },
        to: { path: "^packages/(pipeline-adapter-lima|pipeline)/" }
      },
      {
        name: "internals-do-not-import-published-wrapper",
        severity: "error",
        comment: "Internal packages must not depend on the convenience @async/pipeline wrapper.",
        from: { path: "^packages/(pipeline-core|pipeline-node|pipeline-adapter-lima)/src" },
        to: { path: "^packages/pipeline/src" }
      }
    ],
    options: {
      doNotFollow: {
        path: "^(node_modules|packages/[^/]+/dist)"
      },
      combinedDependencies: true,
      exclude: {
        path: "(^|/)(\\.async|node_modules|dist|build)/"
      },
      preserveSymlinks: true,
      tsConfig: {
        fileName: "tsconfig.hygiene.json"
      }
    }
  },
  unused: {
    config: {
      ignoreDependencies: [
        "@async/api-contract"
      ],
      ignoreExportsUsedInFile: true,
      treatConfigHintsAsErrors: true,
      workspaces: {
        ".": {
          entry: [
            "pipeline.ts",
            "scripts/build-pages.js",
            "scripts/check-*.mjs",
            "scripts/mock-claims-repair.mjs",
            "scripts/publish.mjs",
            "scripts/publish-github.mjs",
            "tests/**/*.test.js"
          ],
          project: [
            "scripts/**/*.{js,mjs}",
            "tests/**/*.test.js"
          ]
        },
        "packages/pipeline-core": {
          entry: [
            "src/index.ts",
            "src/graph.ts",
            "src/runtime.ts"
          ],
          project: [
            "src/**/*.ts"
          ]
        },
        "packages/pipeline-node": {
          entry: [
            "src/index.ts",
            "src/cli.ts"
          ],
          project: [
            "src/**/*.ts"
          ]
        },
        "packages/pipeline-adapter-lima": {
          entry: [
            "src/index.ts"
          ],
          project: [
            "src/**/*.ts"
          ]
        },
        "packages/pipeline": {
          entry: [
            "src/index.ts",
            "src/cli.ts",
            "src/core.ts",
            "src/lima.ts",
            "src/node.ts",
            "src/runtime.ts"
          ],
          project: [
            "src/**/*.ts",
            "scripts/**/*.js"
          ]
        },
        "examples/agent-claims-repair": {
          entry: [
            "pipeline.mjs",
            "scripts/*.mjs"
          ],
          project: [
            "scripts/**/*.mjs"
          ]
        },
        "examples/basic-node-package": {
          entry: [
            "pipeline.ts"
          ],
          project: [
            "src/**/*.ts"
          ]
        },
        "examples/custom-cache-registry": {
          entry: [
            "pipeline.ts",
            "scripts/*.mjs"
          ],
          project: [
            "scripts/**/*.mjs"
          ]
        },
        "examples/deno-worker": {
          entry: [
            "pipeline.ts",
            "worker/main.ts",
            "scripts/*.mjs"
          ],
          project: [
            "worker/**/*.ts",
            "scripts/**/*.mjs"
          ]
        },
        "examples/github-native-npm-preview-package": {
          entry: [
            "pipeline.mjs",
            "scripts/*.mjs"
          ],
          project: [
            "src/**/*.js",
            "scripts/**/*.mjs"
          ]
        },
        "examples/generated-package-previews": {
          entry: [
            "pipeline.ts",
            "src/index.js"
          ],
          project: [
            "scripts/**/*.js",
            "src/**/*.js"
          ]
        },
        "examples/many-repo-impact-run": {
          entry: [
            "pipeline.ts",
            "repos/admin/pipeline.ts",
            "repos/admin/tools/use-candidate.mjs",
            "repos/storefront/pipeline.mjs",
            "repos/storefront/src/app.js",
            "repos/storefront/tools/use-candidate.mjs"
          ],
          project: [
            "src/**/*.js",
            "repos/**/*.js",
            "repos/**/*.mjs",
            "repos/**/*.ts"
          ]
        },
        "examples/monorepo-package-selection": {
          entry: [
            "pipeline.ts",
            "packages/*/src/**/*.js"
          ],
          project: [
            "packages/**/*.js"
          ]
        },
        "examples/runtime-middleware-stack": {
          entry: [
            "pipeline.mjs",
            "src/**/*.mjs"
          ],
          project: [
            "src/**/*.mjs"
          ]
        }
      }
    }
  },
  package: {
    strict: true,
    typeProfile: "esm-only",
    typeFormat: "ascii"
  },
  task: {
    dependsOn: ["build"]
  }
});
