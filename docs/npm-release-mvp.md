# npm Release MVP

Use this setup when an existing package already has normal build and test commands, and the only release automation you want from `@async/pipeline` is publishing the current `package.json` version to npm.

The important boundary is: `@async/pipeline` owns the release job graph, triggers, permissions, environment, and package path; `@async/release` owns package-aware release evidence such as the package plan, package inspection, changelog check, and rendered release notes.

The current Pipeline API exposes that boundary through exact lifecycle commands inside `pipeline.ts`. When a task contains the exact whole command `pnpm async-pipeline publish npm --package .`, the GitHub workflow lowers it into Async publish action steps, runs `@async/release` plan, inspect, changelog, and notes evidence first, then publishes npm through `async/actions/publish`. If the command is compound shell, retry-wrapped, or timeout-wrapped, it stays in the normal pipeline runner path instead of being lowered.

This MVP deliberately skips PR previews, main snapshots, GitHub Packages mirrors, Pages deploys, source-impact matrices, and release doctor checks. Add those only when the repo needs them.

## Minimum Files

Commit these files:

```txt
package.json
pnpm-lock.yaml
pipeline.ts
.github/workflows/async-pipeline.yml
.locks/pipeline/github-workflow.lock.json
```

Keep local run state and package artifacts out of Git:

```gitignore
.async/
*.tgz
.tmp/
```

## Package Setup

Install the CLI:

```sh
pnpm add -D @async/pipeline
```

Keep ordinary package scripts for the commands your package already uses:

```json
{
  "type": "module",
  "packageManager": "pnpm@11.1.0",
  "scripts": {
    "async-pipeline": "async-pipeline",
    "build": "tsc -p tsconfig.json",
    "test": "node --test"
  }
}
```

Use Node 24 or newer for the pipeline CLI.

## Private Workspace Roots

For a pnpm workspace with a private root package, do not start by publishing the
root. Pick one package under `packages/*` and make that package release-ready
first:

- Choose the first npm package path, such as `packages/core`.
- Decide whether that package is public now; keep unreleased implementation
  packages private.
- Set the package version to the npm version you intend to publish.
- Add normal npm metadata: license, repository, README or package readme, and
  any package-specific keywords.
- Make package `exports` point at files that belong in the npm tarball. If
  consumers should not import source TypeScript, publish built JavaScript and
  declaration files instead of `src/**/*.ts`.
- Add a `files` allowlist when the package should ship only `dist/`, README,
  license, and package metadata.
- Keep workspace-only dependencies as `workspace:*` until your release process
  deliberately rewrites or publishes the dependent packages in order.

For the MVP, publish one package first. After that works, repeat the package
task for the next package or graduate to a fuller release plan.

## Minimal Pipeline

Create `pipeline.ts` at the repo root:

```ts
import { definePipeline, job, sh, task, trigger } from "@async/pipeline";

const packageName = "@scope/package";

export default definePipeline({
  name: "npm-release",
  cache: "file:local",

  sync: {
    github: true
  },

  triggers: {
    pr: trigger.github({ events: ["pull_request"] }),
    main: trigger.github({ events: ["push"], branches: ["main"] }),
    manual: trigger.manual()
  },

  namedInputs: {
    package: [
      "src/**/*.ts",
      "package.json",
      "pnpm-lock.yaml",
      "tsconfig.json",
      "README.md",
      "LICENSE"
    ]
  },

  tasks: {
    test: task({
      inputs: ["package"],
      cache: "file:local",
      run: sh`pnpm test`
    }),

    build: task({
      dependsOn: ["test"],
      inputs: ["package"],
      outputs: ["dist/**"],
      cache: "file:local",
      run: sh`pnpm build`
    }),

    pack: task({
      description: "Prove the package tarball is publishable before release.",
      dependsOn: ["build"],
      inputs: ["package"],
      cache: false,
      run: sh`npm pack --dry-run --ignore-scripts`
    }),

    publish: task({
      dependsOn: ["pack"],
      inputs: ["package"],
      cache: false,
      run: sh`pnpm async-pipeline publish npm --package .`
    })
  },

  jobs: {
    verify: job({
      target: "pack",
      trigger: ["pr", "main"]
    }),

    publish: job({
      target: "publish",
      trigger: ["manual"],
      environment: {
        name: "npm-publish",
        url: `https://www.npmjs.com/package/${packageName}`
      },
      requires: {
        provenance: true
      }
    })
  }
});
```

For a nested publishable package, change the lifecycle command to the package directory:

```ts
run: sh`pnpm async-pipeline publish npm --package packages/my-package`
```

In a private workspace root, start with the package path in the example instead
of `.`:

```ts
const packagePath = "packages/core";
const packageName = "@scope/core";
```

```ts
namedInputs: {
  package: [
    `${packagePath}/src/**/*.ts`,
    `${packagePath}/package.json`,
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.json",
    "README.md",
    "LICENSE"
  ]
}
```

```ts
pack: task({
  description: "Prove the package tarball is publishable before release.",
  dependsOn: ["build"],
  inputs: ["package"],
  cache: false,
  run: sh`npm --prefix packages/core pack --dry-run --ignore-scripts`
}),

publish: task({
  dependsOn: ["pack"],
  inputs: ["package"],
  cache: false,
  run: sh`pnpm async-pipeline publish npm --package packages/core`
})
```

## npm Authentication

Prefer npm trusted publishing for new repos. Configure npm for the committed workflow file, the `publish` job, and the `npm-publish` environment. `requires.provenance: true` gives the publish job GitHub `id-token: write` for npm provenance.

If the repo still uses an npm token, add `env` to the import and wire the GitHub secret into the publish job:

```ts
import { definePipeline, env, job, sh, task, trigger } from "@async/pipeline";
```

```ts
publish: job({
  target: "publish",
  trigger: ["manual"],
  environment: {
    name: "npm-publish",
    url: `https://www.npmjs.com/package/${packageName}`
  },
  requires: {
    provenance: true
  },
  env: {
    NODE_AUTH_TOKEN: env.secret("NPM_TOKEN")
  }
})
```

When `NODE_AUTH_TOKEN` or `NPM_TOKEN` is present, `async-pipeline publish npm --package .` writes a temporary npmjs auth config for that publish. Without a token, `async-pipeline publish npm --package .` leaves auth to npm trusted publishing and skips npm access changes that tokenless OIDC cannot perform.

## Generate The Workflow

Run the package checks locally:

```sh
pnpm async-pipeline run verify
```

Write and check the GitHub workflow:

```sh
pnpm async-pipeline sync github generate
pnpm async-pipeline sync github check
```

Inspect the publish job without publishing:

```sh
pnpm async-pipeline github plan --job publish --event workflow_dispatch --selected-job publish --format json
pnpm async-pipeline github run --job publish --event workflow_dispatch --dry-run
```

Commit the workflow and lock:

```txt
.github/workflows/async-pipeline.yml
.locks/pipeline/github-workflow.lock.json
```

## Release Procedure

1. Update `package.json` to the version you want to publish.
2. Update the package changelog or release notes if the repo maintains them.
3. Merge the verified change to the release branch.
4. Run the `publish` job from GitHub Actions with `workflow_dispatch`.
5. Confirm the package version is visible on npm.

If the same package version is already on npm, the lifecycle publish command skips the publish instead of failing. For PR preview packages, add the [preview packages MVP](preview-packages-mvp.md). For docs deployment, add the [GitHub Pages MVP](github-pages-mvp.md). For releases, preview packages, and Pages together, use the [package repo MVP](package-repo-mvp.md) instead of adding ad hoc shell around the npm publish step.
