# Deno-only Pipeline

This example has no `package.json`. It runs `@async/pipeline` through Deno and keeps generated commands in `deno.json` tasks.

The checked-in example points `sync.command` at this repository's built CLI so the release gate tests the local checkout:

```ts
sync: {
  command: "deno run -A ../../packages/pipeline/dist/cli.js",
  github: { runtime: "deno@2" },
  tasks: {
    runners: ["deno"],
    targets: "root",
    jobs: ["verify"],
    scripts: { "sync:check": "sync check" }
  }
}
```

In a real Deno-only project that installs from npm, use the published CLI subpath:

```json
{
  "tasks": {
    "async-pipeline": "deno run -A npm:@async/pipeline/cli"
  }
}
```

Then set `sync.command` to `deno task async-pipeline` or directly to `deno run -A npm:@async/pipeline/cli`.

This depends on Deno's npm and `node:` compatibility layer for the pipeline package internals; see the [Deno Node/npm compatibility docs](https://docs.deno.com/runtime/fundamentals/node/).

## Try It Locally

From this example directory:

```sh
deno task pipeline:verify
deno task pipeline:sync:check
deno run -A ../../packages/pipeline/dist/cli.js sync check
```

The pipeline task declares `requires: { runtime: "deno" }`, so a host without Deno fails before running task commands with a clear missing-runtime error.
