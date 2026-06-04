# GitHub Actions Setup

GitHub Actions should be a thin invocation layer. The workflow should install dependencies, build the CLI, and run the same pipeline that runs locally.

## Minimal Workflow

```yaml
name: CI

on:
  pull_request:
  push:
    branches:
      - main
  workflow_dispatch:

permissions:
  contents: read

jobs:
  verify:
    name: pipeline / verify
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@<pinned-sha>

      - name: Setup Node
        uses: actions/setup-node@<pinned-sha>
        with:
          node-version: 24
          cache: pnpm

      - name: Enable pnpm
        run: corepack enable

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build CLI
        run: pnpm build

      - name: Run TypeScript pipeline
        run: pnpm async-pipeline run verify
        env:
          CI: true
```

The repo workflow uses this shape in [../.github/workflows/ci.yml](../.github/workflows/ci.yml).

## Why Build Before Running

This repo dogfoods the local CLI from source:

```json
{
  "scripts": {
    "async-pipeline": "node packages/pipeline-node/dist/cli.js"
  }
}
```

That means CI must run:

```sh
pnpm build
pnpm async-pipeline run verify
```

In a consumer project that installs a published `@async/pipeline`, the bin already points at built package output, so a pre-build step may not be necessary.

## Pin Actions

Use full commit SHAs for Actions:

```yaml
uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd
```

Keep the version comment nearby if useful:

```yaml
uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
```

## Permissions

For a verify-only workflow, use:

```yaml
permissions:
  contents: read
```

Add write permissions only when the pipeline actually publishes, comments, deploys, or uploads privileged artifacts.

## Cache

Use package-manager cache for dependency installation:

```yaml
with:
  cache: pnpm
```

`@async/pipeline` task cache is local to the runner unless you explicitly persist `.async/cache`. The first tranche does not include remote cache.

## CI Mode

The CLI marks runs as `ci` when `CI` is set:

```yaml
env:
  CI: true
```

The execution record stores the mode:

```json
{
  "mode": "ci"
}
```

## Future Publishing

Before publishing packages:

- recheck npm availability for `@async/pipeline`
- confirm package metadata
- run `pnpm release:check`
- run `npm pack --dry-run` for each publishable package
- add release permissions only to the release workflow
