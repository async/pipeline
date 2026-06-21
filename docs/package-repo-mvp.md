# Package Repo MVP

Use this setup when a package repo needs the three common public surfaces:
stable npm releases, pull request preview packages, and GitHub Pages docs.

The important boundary is: `pipeline.ts` owns the local task graph and the
GitHub job policy; `@async/release` owns package-aware release and preview
evidence; `async/actions` owns the networked npm, GitHub Packages, comment, and
Pages steps.

This MVP assumes one package is being released first. For a private workspace
root, keep the root private and choose one package path under `packages/*`.
After this works, repeat the package path pattern or graduate to a fuller
multi-package release plan.

## Minimum Files

Commit these files:

```txt
package.json
pnpm-lock.yaml
pnpm-workspace.yaml
pipeline.ts
README.md
LICENSE
CHANGELOG.md
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

Make the first package release-ready before adding release jobs:

- Remove `private: true` from the package that should publish.
- Set the npm version you intend to publish.
- Add license, repository, README or package readme, and package-specific
  keywords.
- Make `exports` point at files that belong in the npm tarball.
- Add a `files` allowlist for `dist/`, package metadata, README, and license.
- Keep unreleased implementation packages private.
- Keep workspace dependencies as `workspace:*` until your release process
  deliberately publishes or rewrites them in order.

Configure npm trusted publishing for the committed workflow file, the `publish`
job, and the `npm-publish` environment. If the repo still uses token auth, wire
`NODE_AUTH_TOKEN` to an npm token secret as shown in the npm release MVP.

Configure the repository's Pages source to GitHub Actions before relying on
Pages deploys.

## Minimal Pipeline

Create `pipeline.ts` at the repo root. This example publishes
`packages/core`, publishes PR previews for that package, and deploys static docs
from `.async/pages`.

```ts
import { definePipeline, job, sh, task, trigger } from "@async/pipeline";

const packageName = "@scope/core";

export default definePipeline({
  name: "package-repo",
  cache: "file:local",

  sync: {
    github: {
      packagePreviews: {
        package: "packages/core",
        target: "pack"
      },
      pages: {
        target: "docs.site",
        build: { kind: "static", path: ".async/pages" }
      },
      evidence: true
    }
  },

  triggers: {
    pr: trigger.github({ events: ["pull_request"] }),
    main: trigger.github({ events: ["push"], branches: ["main"] }),
    manual: trigger.manual()
  },

  namedInputs: {
    package: [
      "packages/core/src/**/*.ts",
      "packages/core/package.json",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "tsconfig.json",
      "README.md",
      "LICENSE",
      "CHANGELOG.md"
    ],
    docs: [
      "docs/**",
      "README.md",
      "packages/core/src/**/*.ts",
      "packages/core/package.json",
      "package.json",
      "pnpm-lock.yaml"
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
      outputs: ["packages/core/dist/**"],
      cache: "file:local",
      run: sh`pnpm build`
    }),

    pack: task({
      description: "Prove the package tarball is publishable.",
      dependsOn: ["build"],
      inputs: ["package"],
      cache: false,
      run: sh`npm --prefix packages/core pack --dry-run --ignore-scripts`
    }),

    "docs.site": task({
      description: "Build the static GitHub Pages artifact.",
      dependsOn: ["build"],
      inputs: ["docs"],
      outputs: [".async/pages/**"],
      cache: false,
      run: sh`pnpm docs:build`
    }),

    "release.ensure": task({
      description: "Create or verify the GitHub Release for the package version.",
      dependsOn: ["pack"],
      inputs: ["package"],
      cache: false,
      run: sh`pnpm async-pipeline release ensure --package packages/core`
    }),

    publish: task({
      description: "Publish the current package version to npm.",
      dependsOn: ["release.ensure"],
      inputs: ["package"],
      cache: false,
      run: sh`pnpm async-pipeline publish npm --package packages/core`
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

This combined MVP has four workflow lanes:

- `verify` runs test, build, and pack on pull requests and `main`.
- `package-preview` runs on pull requests, uses the same `pack` target, runs `@async/release` preview evidence, publishes trusted same-repo PR previews to GitHub Packages, and skips forks.
- `pages` builds the static Pages artifact on pull requests and deploys it from `main` or selected manual dispatch.
- `publish` is manual and runs `release ensure` before the npm publish command.

`release ensure` creates or verifies the `v<version>` Git tag and GitHub Release for the package version. The exact `publish npm` command is lowered into Async publish action steps, with `@async/release` evidence before npm publishing.

## Root Package Variant

For a repo whose root package is the package being released, use `.` instead of
`packages/core`:

```ts
sync: {
  github: {
    packagePreviews: true,
    pages: { target: "docs.site" },
    evidence: true
  }
}
```

```ts
pack: task({
  dependsOn: ["build"],
  inputs: ["package"],
  cache: false,
  run: sh`npm pack --dry-run --ignore-scripts`
}),

"release.ensure": task({
  dependsOn: ["pack"],
  inputs: ["package"],
  cache: false,
  run: sh`pnpm async-pipeline release ensure --package .`
}),

publish: task({
  dependsOn: ["release.ensure"],
  inputs: ["package"],
  cache: false,
  run: sh`pnpm async-pipeline publish npm --package .`
})
```

## Generate The Workflow

Run the package and docs checks locally:

```sh
pnpm async-pipeline run verify
pnpm async-pipeline run-task docs.site
```

Write and check the GitHub workflow:

```sh
pnpm async-pipeline sync github generate
pnpm async-pipeline sync github check
```

Inspect the networked jobs without publishing or deploying:

```sh
pnpm async-pipeline github plan --job package-preview --event pull_request --format json
pnpm async-pipeline github run --job package-preview --event pull_request --mock-network
pnpm async-pipeline github plan --job pages --event pull_request --format json
pnpm async-pipeline github run --job pages --event pull_request --mock-network
pnpm async-pipeline github plan --job publish --event workflow_dispatch --selected-job publish --format json
pnpm async-pipeline github run --job publish --event workflow_dispatch --dry-run
```

Commit the workflow and lock:

```txt
.github/workflows/async-pipeline.yml
.locks/pipeline/github-workflow.lock.json
```

## Daily Procedure

Pull request:

1. Run or wait for `verify`.
2. Use the `package-preview` install comment for same-repo PRs.
3. Check the Pages build artifact through the `pages` job.

Main branch:

1. Merge only after `verify` passes.
2. Let the `pages` deploy job publish docs from `main`.

Stable release:

1. Update the package version and `CHANGELOG.md`.
2. Merge the verified release commit.
3. Dispatch the `publish` job.
4. Confirm the package version is visible on npm and the GitHub Release matches
   the changelog section.

Use the narrower npm release, preview packages, or GitHub Pages MVP docs when
the repo needs only one surface.
