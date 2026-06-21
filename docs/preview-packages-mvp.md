# Preview Packages MVP

Use this setup when a package repo already has normal build, test, and pack
checks, and you want same-repo pull requests to get installable preview
packages before merge.

The important boundary is: `@async/pipeline` owns the preview job, package
selection, permissions, fork policy, and comment policy; `@async/release` owns
preview plan, stage, and inspect evidence; `async/actions/preview` owns the
GitHub Packages write.

This MVP deliberately skips stable npm release publishing, main snapshots,
GitHub Release creation, Pages deploys, source-impact matrices, and release
doctor gates. Add those only when the repo needs them.

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

## Package Rules

`sync.github.packagePreviews: true` needs one public package to preview. It selects the public root package, or the single public `packages/*` package when the root package is private. If there are multiple public packages, set `sync.github.packagePreviews.package` explicitly.

For the fastest path in a private pnpm workspace:

- Keep the workspace root private.
- Pick one publishable package, such as `packages/core`.
- Make that package public in npm terms by removing `private: true`.
- Add a real package version, README or package readme, license, repository
  metadata, and a `files` allowlist.
- Make `exports` point at files that will exist in the package tarball.
- Keep a `pack` task so preview publishing proves the same tarball shape that
  stable publishing will use later.

## Minimal Pipeline

Create `pipeline.ts` at the repo root:

```ts
import { definePipeline, job, sh, task, trigger } from "@async/pipeline";

export default definePipeline({
  name: "package-previews",
  cache: "file:local",

  sync: {
    github: {
      packagePreviews: true
    }
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
      description: "Prove the package tarball is publishable before preview.",
      dependsOn: ["build"],
      inputs: ["package"],
      cache: false,
      run: sh`npm pack --dry-run --ignore-scripts`
    })
  },

  jobs: {
    verify: job({
      target: "pack",
      trigger: ["pr", "main", "manual"]
    })
  }
});
```

With `sync.github.packagePreviews: true`, sync writes a `package-preview` job for pull requests. The job selects the public root package or the single public `packages/*` package when the root is private, runs `pack` when present, runs `@async/release` preview plan, stage, and inspect evidence before publishing, then calls `async/actions/preview` for the selected package path.

Same-repo pull requests publish immutable `0.0.0-pr.<n>.sha.<sha>` previews and can receive one install comment. Fork pull requests skip preview publishing and skip preview comments.

## Nested Package Variant

When inference is ambiguous, or when only one package should preview, use object
form:

```ts
sync: {
  github: {
    packagePreviews: {
      package: "packages/core",
      target: "pack"
    }
  }
}
```

Use a nested package-aware `pack` task:

```ts
pack: task({
  description: "Prove the package tarball is publishable before preview.",
  dependsOn: ["build"],
  inputs: ["package"],
  cache: false,
  run: sh`npm --prefix packages/core pack --dry-run --ignore-scripts`
})
```

GitHub Packages preview publishing uses `GITHUB_TOKEN` by default. If your repo
needs a different token or package namespace, configure it explicitly:

```ts
sync: {
  github: {
    packagePreviews: {
      package: "packages/core",
      target: "pack",
      namespace: "scope",
      tokenEnv: "PACKAGES_TOKEN"
    }
  }
}
```

## Generate The Workflow

Run the local package checks:

```sh
pnpm async-pipeline run verify
```

Write and check the GitHub workflow:

```sh
pnpm async-pipeline sync github generate
pnpm async-pipeline sync github check
```

Inspect the preview job without publishing:

```sh
pnpm async-pipeline github plan --job package-preview --event pull_request --format json
pnpm async-pipeline github run --job package-preview --event pull_request --mock-network
```

Commit the workflow and lock:

```txt
.github/workflows/async-pipeline.yml
.locks/pipeline/github-workflow.lock.json
```

## Pull Request Procedure

1. Open or update a non-draft same-repo pull request.
2. Let the `package-preview` job run after the normal verify path.
3. Install the preview from the comment or from the GitHub Packages tag.
4. Treat fork pull requests as verify-only unless a maintainer moves the change
   into a trusted branch.

For stable npm publishing, add the npm release MVP or the combined package repo
MVP instead of adding ad hoc publish shell to the preview job.
