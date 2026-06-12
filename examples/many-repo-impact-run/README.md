# Many-Repo Impact Run

A "design system" repo that proves a candidate change against two explicitly declared dependent repos before it ships. The dependency map is code you review, not magic:

```ts
sources: {
  storefront: source.path({ path: "repos/storefront", pipeline: "pipeline.mjs", writable: true, prepare: [...] }),
  admin: source.path({ path: "repos/admin", pipeline: "pipeline.ts", writable: true, prepare: [...] })
},
tasks: {
  impact: task({
    dependsOn: ["test", "storefront:test", "admin:test-design-system"]
  })
}
```

The dependent repos are committed under `repos/` so the example runs anywhere, offline, with no cloning. They stand in for real repos you own; the commented `source.git(...)` block in [pipeline.ts](pipeline.ts) shows the production shape (pin `ref` to a SHA for reproducible runs).

## How The Candidate Reaches The Dependents

Each source declares a `prepare` step that runs inside that repo with candidate context:

```ts
prepare: [
  sh((ctx) => sh`node tools/use-candidate.mjs ${ctx.candidate.dir}`)
]
```

`ctx.candidate.dir` points back at this design-system checkout. The dependent repo's `tools/use-candidate.mjs` records it in a local `candidate.json` (gitignored), and its tests import the design system from there. In a real repo the prepare step is usually `pnpm add @acme/design-system@file:${ctx.candidate.dir}` instead — same idea, package-manager edition. Deferred `sh((ctx) => ...)` callbacks stay unevaluated during metadata reads, so inspecting the pipeline never mutates the sources.

## Try It Locally

From this example directory:

```sh
pnpm install
pnpm async-pipeline sources list
pnpm async-pipeline run verifyImpact
```

The run summary shows the namespaced graph:

```txt
| admin:prepare              | passed |
| admin:test-design-system   | passed |
| storefront:prepare         | passed |
| storefront:test            | passed |
| test                       | passed |
| impact                     | passed |
```

Run one dependent repo's task by its namespaced ref:

```sh
pnpm async-pipeline run-task storefront:test
```

A second `run verifyImpact` re-runs the cheap `prepare` wiring but resolves `test`, `storefront:test`, and `admin:test-design-system` as `cached`.

Break the contract to see the point of the example: change `formatPrice` in [src/index.js](src/index.js) to return cents, and `verifyImpact` fails in the dependent repos' tests, not in a consumer's production deploy.

## GitHub Matrix Planning

`matrix` turns the declared source task refs into a GitHub Actions matrix:

```sh
pnpm async-pipeline matrix verifyImpact --format github
```

```json
{"include":[
  {"task":"admin:test-design-system","source":"admin","taskId":"test-design-system","type":"path","path":"repos/admin"},
  {"task":"storefront:test","source":"storefront","taskId":"test","type":"path","path":"repos/storefront"}
]}
```

A workflow can fan dependent repos out across runners with that matrix and run `async-pipeline run-task "$TASK"` per row. The committed bootloader (`sync.github: true`) runs the whole `verifyImpact` job on one runner; matrix fan-out is the scaling step when dependent repos get slow. v1 runs dependent tasks in this repo's CI — it does not dispatch workflows in the consumer repos.

## Git Sources

Swap a path source for `source.git({ url, ref, pipeline, prepare })` and the CLI owns the checkout under `.async/sources/<source-id>/<hash>`, syncing on `sources sync` or at run time. Repeated runs reuse the warm checkout. Everything else — namespaced refs, prepare, matrix — is identical.
