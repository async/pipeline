# Generated Package Previews

This example uses the generated preview system instead of hand-authoring a PR preview job:

```ts
sync: {
  github: {
    dependabotAutoMerge: true,
    packagePreviews: true
  },
  tasks: true
}
```

`packagePreviews: true` finds the single public package, runs the `pack` task, and generates a `package-preview` GitHub Actions job that publishes same-repo PR previews to GitHub Packages. Fork PRs skip inside the lifecycle CLI.

## Files

```txt
package.json
pipeline.ts
scripts/build.js
src/index.js
src/index.test.js
```

## Try It Locally

```sh
pnpm async-pipeline run verify
pnpm async-pipeline sync check
```

The local `verify` job builds and dry-runs the package tarball. Publishing only happens from the generated GitHub Actions `package-preview` job on pull requests.

