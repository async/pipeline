# Examples

These examples show different shapes for `@async/pipeline` projects. Each example is meant to be copyable into a real repo and adapted to its package manager, package names, secrets, and release policy.

| Example | Status | What it shows |
| --- | --- | --- |
| [github-native-npm-preview-package](github-native-npm-preview-package/README.md) | Ready | A TypeScript pipeline version of the GitHub-native npm preview package workflow from PatrickJS's Gist. |
| `basic-node-package` | Planned | One package with `typecheck`, `test`, `build`, `pack`, GitHub sync, and package task sync. |
| `monorepo-package-selection` | Planned | Syncing package-manager scripts into selected workspace packages by `package.json#name`. |
| `deno-worker` | Planned | Writing generated commands into `deno.json` tasks. |
| `many-repo-impact-run` | Planned | Explicit source repos, namespaced tasks, and GitHub matrix planning. |
| `custom-cache-registry` | Planned | File, memory, and placeholder remote cache registry definitions. |
| `runtime-middleware-stack` | Planned | `defineRuntime(...)` and `createRuntime(...)` for app/background workflow composition. |

## Safety

Examples avoid real tokens and real publish commands unless a README explicitly says otherwise. Treat package publishing, deployment, and GitHub Package writes as actions you must wire deliberately in your own repo.
