# Getting Started

This guide covers two paths:

- running the `async-pipeline` repo itself
- adding `@async/pipeline` to another project once the package is published

## Requirements

- pnpm
- Node 24 for `pipeline.ts`
- Node 20+ if you use `pipeline.mjs` or `pipeline.js`
- Optional: Lima installed as `limactl` for future isolated runner work

## Run This Repo

```sh
cd /Users/patrickjs/code/async-framework/async-pipeline
pnpm install --frozen-lockfile
pnpm build
pnpm async-pipeline run verify
```

The `verify` job runs this graph:

```txt
typecheck -> test -> build -> pack
```

Useful follow-up commands:

```sh
pnpm async-pipeline list
pnpm async-pipeline graph --format json
pnpm async-pipeline graph --format dot
pnpm async-pipeline explain build
pnpm async-pipeline run-task test
pnpm async-pipeline doctor
```

## Add A Pipeline To A Project

Install the package after it is published:

```sh
pnpm add -D @async/pipeline
```

Create `pipeline.ts` at the project root:

```ts
import { definePipeline, job, sh, task, trigger } from "@async/pipeline";

export default definePipeline({
  name: "web-app",
  namedInputs: {
    source: [
      "src/**/*.ts",
      "src/**/*.tsx",
      "package.json",
      "pnpm-lock.yaml",
      "tsconfig.json"
    ]
  },
  triggers: {
    push: trigger.github({ events: ["push", "pull_request"] })
  },
  tasks: {
    typecheck: task({
      inputs: ["source"],
      cache: true,
      timeout: "2m",
      run: sh`pnpm typecheck`
    }),
    test: task({
      dependsOn: ["typecheck"],
      inputs: ["source"],
      cache: true,
      retry: { attempts: 2, delayMs: 500 },
      run: sh`pnpm test`
    }),
    build: task({
      dependsOn: ["test"],
      inputs: ["source"],
      outputs: ["dist/**"],
      cache: true,
      run: sh`pnpm build`
    })
  },
  jobs: {
    verify: job({
      target: "build",
      trigger: ["push"]
    })
  }
});
```

Add scripts:

```json
{
  "scripts": {
    "async-pipeline": "async-pipeline",
    "verify": "async-pipeline run verify"
  }
}
```

Run it:

```sh
pnpm async-pipeline run verify
```

Short aliases and smart runner dispatch are intentionally out of scope for `@async/pipeline`; use `@async/run` for that layer.

## What To Commit

Commit:

- `pipeline.ts`, `pipeline.mjs`, or `pipeline.js`
- `.github/workflows/ci.yml`
- package metadata and lockfile changes
- docs that explain the project pipeline

Do not commit:

- `.async/`
- package tarballs from `npm pack`
- `dist/` unless your project already commits build output

## Troubleshooting

If `pipeline` cannot find a config file, make sure one of these exists at the project root:

```txt
pipeline.ts
pipeline.mjs
pipeline.js
```

If `pipeline.ts` fails to load on Node 20, use Node 24 or convert the config to `pipeline.mjs`.

If a task keeps returning a cache hit, check its `inputs`. A task only becomes dirty when its task config or declared input files change.
