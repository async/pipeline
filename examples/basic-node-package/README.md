# Basic Node Package

The smallest realistic `@async/pipeline` shape: one publishable TypeScript package whose `typecheck`, `test`, `build`, and `pack` flow lives in [pipeline.ts](pipeline.ts), with both sync surfaces enabled in their simplest `true` form.

If you are adding `@async/pipeline` to an existing single-package repo, start by copying this example.

## Files

```txt
package.json
pipeline.ts
tsconfig.json
src/index.ts
src/index.test.ts
```

## Pipeline Model

```txt
tasks     = typecheck -> test -> build -> pack
jobs      = verify (PRs, main, manual), nightly (cron)
triggers  = pull_request, push to main, cron, manual
sync      = github: true, tasks: true
```

Each task declares the same `source` named-input group, so a change to `src/`, `package.json`, or `tsconfig.json` invalidates the chain while anything else (README edits, run records) stays `cached`. `build` declares `outputs: ["dist/**"]`, so a file-cache hit restores `dist/` without re-running `tsc`. `pack` sets `cache: false` because proving the tarball is publishable is cheap and worth doing on every run.

Tests are TypeScript too: Node >= 24 runs `src/index.test.ts` directly through native type stripping, no compile step first.

## Try It Locally

From this example directory:

```sh
pnpm install
pnpm async-pipeline list
pnpm async-pipeline run verify
pnpm async-pipeline run verify   # second run: typecheck/test/build resolve as cached
```

Inspect the evidence:

```sh
cat .async/runs/$(ls -t .async/runs | head -1)/summary.md
pnpm async-pipeline explain build
```

## What Sync Generates

`sync.github: true` and `sync.tasks: true` are the whole opt-in:

```sh
pnpm async-pipeline sync generate
pnpm async-pipeline sync check
```

That writes and then guards:

```txt
.github/workflows/async-pipeline.yml   # thin bootloader: checkout, node, cache, delegate to the CLI
.locks/pipeline/github-workflow.lock.json  # hash of the trigger/job metadata it was built from
.locks/pipeline/tasks.lock.json            # ownership record for generated package.json scripts
```

`tasks: true` syncs every job, so `package.json` gains `pipeline:verify` and `pipeline:nightly` next to the hand-written `build`, `test`, and `typecheck` scripts — which sync never touches. Edit a generated script by hand and `sync check` fails, naming the stale script and the command to regenerate it.

## Adapting It

- Keep `pipeline.ts` as the source of truth; add tasks there, not in YAML.
- Commit the three generated files above; gitignore `.async/` and `*.tgz`.
- The cron trigger renders into the workflow `schedule` block; drop the `nightly` trigger and job if you do not want scheduled runs.
