# GitHub Pages MVP

Use this setup when a repo already has a docs or site build command and you
want GitHub Pages builds checked on pull requests and deployed from the release
branch.

The important boundary is: `@async/pipeline` owns the Pages job id, target task,
triggers, artifact path, and deploy policy; `async/actions/pages` owns Pages
configuration, artifact validation, upload, and deployment.

This MVP deliberately skips package publishing, preview packages, release
doctor gates, source-impact matrices, and custom multi-site routing. Add those
only when the repo needs them.

## Minimum Files

Commit these files:

```txt
package.json
pnpm-lock.yaml
pipeline.ts
.github/workflows/async-pipeline.yml
.locks/pipeline/github-workflow.lock.json
```

Keep local run state and built Pages output out of Git:

```gitignore
.async/
.tmp/
```

Before relying on deploys, configure the repository's Pages source to GitHub
Actions in repository settings.

## Site Task Rules

The site task should:

- build from committed docs or source files,
- write static output to `.async/pages` for the MVP,
- declare `.async/pages/**` as an output,
- avoid writing package tarballs or local-only state into the Pages artifact.

For a package repo, the site task can depend on `build` so API docs, examples,
or typed output are current before Pages uploads.

## Minimal Pipeline

Create `pipeline.ts` at the repo root:

```ts
import { definePipeline, job, sh, task, trigger } from "@async/pipeline";

export default definePipeline({
  name: "docs-site",
  cache: "file:local",

  sync: {
    github: {
      pages: {
        target: "docs.site",
        build: { kind: "static", path: ".async/pages" }
      }
    }
  },

  triggers: {
    pr: trigger.github({ events: ["pull_request"] }),
    main: trigger.github({ events: ["push"], branches: ["main"] }),
    manual: trigger.manual()
  },

  namedInputs: {
    docs: [
      "docs/**",
      "README.md",
      "package.json",
      "pnpm-lock.yaml"
    ]
  },

  tasks: {
    "docs.site": task({
      inputs: ["docs"],
      outputs: [".async/pages/**"],
      cache: false,
      run: sh`pnpm docs:build`
    })
  },

  jobs: {
    verify: job({
      target: "docs.site",
      trigger: ["pr", "main", "manual"]
    })
  }
});
```

`sync.github.pages: true` infers a target from `pages`, `docs.site`, `docs`, then `build-pages`, uploads `.async/pages` as a static artifact, builds on pull requests, and deploys from `main` or selected manual dispatch. Object form lets the repo set `target`, `job`, `build`, `artifactName`, `environment`, and trigger settings explicitly.

The sync-level Pages job runs `async-pipeline run-task <target>` before calling `async/actions/pages`. The paired deploy job is skipped on pull requests and uses the `github-pages` environment on non-PR events.

## Static Build Script

For a very small docs site, a package script can copy prepared static files:

```json
{
  "scripts": {
    "docs:build": "rm -rf .async/pages && mkdir -p .async/pages && cp -R docs/. .async/pages/"
  }
}
```

For a framework docs site, make the framework output path `.async/pages`, or
copy its output there as the last step.

## Prerender Variant

Use `build.kind: "prerender"` when the task already rendered static HTML from an app route tree:

```ts
sync: {
  github: {
    pages: {
      target: "docs.site",
      build: {
        kind: "prerender",
        path: ".async/pages",
        validateIndex: true,
        spaFallback: true
      }
    }
  }
}
```

Prerender still means the task produced static files. It is not a long-running
server deployment.

## Generate The Workflow

Run the site build locally:

```sh
pnpm async-pipeline run-task docs.site
```

Write and check the GitHub workflow:

```sh
pnpm async-pipeline sync github generate
pnpm async-pipeline sync github check
```

Inspect the Pages jobs without deploying:

```sh
pnpm async-pipeline github plan --job pages --event pull_request --format json
pnpm async-pipeline github plan --job pages --event workflow_dispatch --selected-job pages --format json
pnpm async-pipeline github run --job pages --event pull_request --mock-network
```

Commit the workflow and lock:

```txt
.github/workflows/async-pipeline.yml
.locks/pipeline/github-workflow.lock.json
```

## Deploy Procedure

1. Merge the verified docs or package change to `main`.
2. Let the Pages deploy job run from the `main` push, or dispatch the `pages`
   job manually.
3. Check the Pages deployment URL from the workflow summary or repository
   Pages settings.

For package repos that also need npm releases and pull request preview
packages, use the combined package repo MVP.
