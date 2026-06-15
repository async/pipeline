# Examples

These examples show different shapes for `@async/pipeline` projects. Each example is meant to be copyable into a real repo and adapted to its package manager, package names, secrets, and release policy.

Every example runs from its own directory and is exercised by this repo's `release:check` (the self pipeline's `examples` task), so a green build means the examples work as documented.

| Example | Status | What it shows |
| --- | --- | --- |
| [basic-node-package](basic-node-package/README.md) | Ready | One package with `typecheck`, `test`, `build`, `pack`, GitHub sync, and package task sync — the shape to copy first. |
| [github-native-npm-preview-package](github-native-npm-preview-package/README.md) | Ready | A pipeline version of the GitHub-native npm preview package workflow from PatrickJS's Gist. |
| [generated-package-previews](generated-package-previews/README.md) | Ready | `packagePreviews: true` and `dependabotAutoMerge: true` generating PR package previews and Dependabot auto-merge. |
| [monorepo-package-selection](monorepo-package-selection/README.md) | Ready | Syncing package-manager scripts into selected workspace packages by `package.json#name`. |
| [deno-worker](deno-worker/README.md) | Ready | Writing generated commands into `deno.json` tasks alongside `package.json` scripts. |
| [many-repo-impact-run](many-repo-impact-run/README.md) | Ready | Explicit source repos, namespaced tasks, candidate wiring through `prepare`, and GitHub matrix planning. |
| [custom-cache-registry](custom-cache-registry/README.md) | Ready | File, memory, and placeholder remote cache registry definitions, with observable cache behavior per store. |
| [runtime-middleware-stack](runtime-middleware-stack/README.md) | Ready | `defineRuntime(...)` and `createRuntime(...)` for app/background workflow composition. |
| [agent-claims-repair](agent-claims-repair/README.md) | Ready | The propose-only agent pattern (ADR-0006): an `agent()` step drafts a patch via `stdoutTo`, a deterministic checker stays the authority, mock profile in CI. |

## Safety

Examples avoid real tokens and real publish commands unless a README explicitly says otherwise. Treat package publishing, deployment, and GitHub Package writes as actions you must wire deliberately in your own repo.
