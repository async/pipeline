# GitHub-Native npm Preview Package

This example adapts PatrickJS's [GitHub-Native npm Preview Packages Gist](https://gist.github.com/PatrickJS/3fa2925713fcdf75a27a505ce2cd0d80) into a single `pipeline.mjs`.

For normal PR preview package publishing, prefer the generated path in [generated-package-previews](../generated-package-previews/README.md): `sync.github.packagePreviews: true`. This example shows the lower-level task/job shape that the generated preview system replaces for the common case.

The Gist uses separate GitHub Actions workflow templates for:

- PR preview packages in GitHub Packages.
- Main branch snapshot packages in GitHub Packages.
- Stable npm releases mirrored to GitHub Packages.

This example keeps the same model but makes `pipeline.mjs` the source of truth for jobs, triggers, local verification, and generated command sync.

The repo dogfoods this model for real: the root `pipeline.ts` generates `@async/pipeline` PR previews with `packagePreviews: true`, and still publishes `main` snapshots plus stable mirrors to GitHub Packages through lifecycle tasks. This example stays print-only so it is safe to run anywhere.

## Files

```txt
package.json
pipeline.mjs
scripts/validate-package-metadata.mjs
scripts/print-publish-plan.mjs
src/index.js
```

## Pipeline Model

```txt
tasks     = validate metadata, verify package, pack package, print publish plans
jobs      = prPreview, mainSnapshot, stableRelease
triggers  = pull_request, push to main, release
sync      = generated GitHub workflow and package-manager commands
```

Triggers describe when jobs should run. Sync describes which generated files should be kept current.

## Try It Locally

From this example directory:

```sh
pnpm install
pnpm async-pipeline list
pnpm async-pipeline run prPreview
pnpm async-pipeline sync list
```

The publish tasks print the npm/GitHub Packages commands they would run. They do not publish anything.

## Generate External Files

```sh
pnpm async-pipeline sync generate
pnpm async-pipeline sync check
```

That can generate:

```txt
.github/workflows/async-pipeline.yml
.locks/pipeline/github-workflow.lock.json
.locks/pipeline/tasks.lock.json
```

The generated workflow is still only a bootloader. GitHub starts from YAML; `pipeline.mjs` decides which matching job to run after the workflow starts.

## Turning This Into A Real Publisher

Before replacing the print-only publish plan with real `npm publish` commands:

- Remove `"private": true` or set it appropriately for your package.
- Use a real scoped lowercase package name.
- Configure npm Trusted Publishing for the generated or hand-authored release workflow.
- Configure package write permissions for GitHub Packages.
- Keep fork PR publishing disabled unless you have a separate trust model.
- Use a package matrix if your publishable package is not at the repo root.

The original Gist includes hardened workflow templates for production publishing. This example shows how the same workflow shape maps into `@async/pipeline`.
