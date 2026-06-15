# @async/pipeline API Surface Ledger

This file is the generated review ledger for semantic API contract features. It is current-state contract documentation, not a changelog or tutorial.

## Async Pipeline Declarations

Contract: `@async/pipeline.declaration`

### Agents

| Feature | Title | Release | Stability | Lifecycle | Replacement | Docs |
| --- | --- | --- | --- | --- | --- | --- |
| `agent.stdoutTo` | Agent stdout artifact routing | beta | preview | active |  | [docs](https://github.com/async/pipeline/blob/main/docs/api.md#agents) |
| `agent.step` | Agent step declaration | beta | preview | active |  | [docs](https://github.com/async/pipeline/blob/main/docs/api.md#agents) |

### Config

| Feature | Title | Release | Stability | Lifecycle | Replacement | Docs |
| --- | --- | --- | --- | --- | --- | --- |
| `config.definePipeline` | definePipeline config entrypoint | public | stable | active |  | [docs](https://github.com/async/pipeline/blob/main/docs/api.md#definepipeline) |
| `config.env` | Environment variable and secret declarations | public | stable | active |  | [docs](https://github.com/async/pipeline/blob/main/docs/api.md#env) |
| `config.github.dependabotAutoMerge` | Generated Dependabot auto-merge job declaration | beta | preview | active |  | [docs](https://github.com/async/pipeline/blob/main/docs/github-actions.md) |
| `config.github.packagePreviews` | Generated GitHub Packages PR preview job declaration | beta | preview | active |  | [docs](https://github.com/async/pipeline/blob/main/docs/github-actions.md) |
| `config.github.pages` | Generated GitHub Pages job declaration | beta | preview | active |  | [docs](https://github.com/async/pipeline/blob/main/docs/github-actions.md) |
| `config.job` | Job declaration | public | stable | active |  | [docs](https://github.com/async/pipeline/blob/main/docs/api.md#job) |
| `config.source` | Source pipeline declaration | public | stable | active |  | [docs](https://github.com/async/pipeline/blob/main/docs/api.md#source) |
| `config.sync.github` | Generated GitHub Actions sync declaration | public | stable | active |  | [docs](https://github.com/async/pipeline/blob/main/docs/sync.md) |
| `config.sync.tasks` | Generated package script and task sync declaration | public | stable | active |  | [docs](https://github.com/async/pipeline/blob/main/docs/sync.md) |
| `config.task` | Task declaration | public | stable | active |  | [docs](https://github.com/async/pipeline/blob/main/docs/api.md#task) |
| `config.trigger.github` | GitHub trigger declaration | public | stable | active |  | [docs](https://github.com/async/pipeline/blob/main/docs/api.md#trigger) |
| `config.trigger.manual` | Manual trigger declaration | public | stable | active |  | [docs](https://github.com/async/pipeline/blob/main/docs/api.md#trigger) |

### Steps

| Feature | Title | Release | Stability | Lifecycle | Replacement | Docs |
| --- | --- | --- | --- | --- | --- | --- |
| `step.shell` | Shell step declaration | public | stable | active |  | [docs](https://github.com/async/pipeline/blob/main/docs/api.md#sh) |

## Async Pipeline CLI

Contract: `@async/pipeline.cli`

### Github

| Feature | Title | Release | Stability | Lifecycle | Replacement | Docs |
| --- | --- | --- | --- | --- | --- | --- |
| `cli.github.check` | Generated GitHub workflow drift check | public | stable | active |  | [docs](https://github.com/async/pipeline/blob/main/docs/github-actions.md) |
| `cli.github.generate` | Generated GitHub workflow writer | public | stable | active |  | [docs](https://github.com/async/pipeline/blob/main/docs/github-actions.md) |

### Lifecycle

| Feature | Title | Release | Stability | Lifecycle | Replacement | Docs |
| --- | --- | --- | --- | --- | --- | --- |
| `cli.publish.github` | GitHub Packages preview, snapshot, and release publishing | beta | preview | active |  | [docs](https://github.com/async/pipeline/blob/main/docs/api.md#package-lifecycle-cli) |
| `cli.publish.npm` | npm publish with provenance and idempotent existing-version skip | beta | preview | active |  | [docs](https://github.com/async/pipeline/blob/main/docs/api.md#package-lifecycle-cli) |
| `cli.release.doctor` | Release doctor verification for npm, GitHub Packages, and GitHub Releases | beta | preview | active |  | [docs](https://github.com/async/pipeline/blob/main/docs/api.md#package-lifecycle-cli) |

### Mcp

| Feature | Title | Release | Stability | Lifecycle | Replacement | Docs |
| --- | --- | --- | --- | --- | --- | --- |
| `cli.mcp` | Read-only MCP inspection server | beta | preview | active |  | [docs](https://github.com/async/pipeline/blob/main/docs/api.md#mcp) |

### Runner

| Feature | Title | Release | Stability | Lifecycle | Replacement | Docs |
| --- | --- | --- | --- | --- | --- | --- |
| `cli.run` | Pipeline job runner | public | stable | active |  | [docs](https://github.com/async/pipeline/blob/main/docs/api.md) |
| `cli.run-task` | Single task runner | public | stable | active |  | [docs](https://github.com/async/pipeline/blob/main/docs/api.md) |

### Sync

| Feature | Title | Release | Stability | Lifecycle | Replacement | Docs |
| --- | --- | --- | --- | --- | --- | --- |
| `cli.sync.check` | Generated package script and task drift check | public | stable | active |  | [docs](https://github.com/async/pipeline/blob/main/docs/sync.md) |
| `cli.sync.generate` | Generated package script and task writer | public | stable | active |  | [docs](https://github.com/async/pipeline/blob/main/docs/sync.md) |

## Async Pipeline Runtime

Contract: `@async/pipeline.runtime`

### Cache

| Feature | Title | Release | Stability | Lifecycle | Replacement | Docs |
| --- | --- | --- | --- | --- | --- | --- |
| `runtime.cache.file` | File cache execution and output restoration | public | stable | active |  | [docs](https://github.com/async/pipeline/blob/main/docs/api.md#definecache) |

### Diagnostics

| Feature | Title | Release | Stability | Lifecycle | Replacement | Docs |
| --- | --- | --- | --- | --- | --- | --- |
| `runtime.context-packs` | Failure context packs | beta | preview | active |  | [docs](https://github.com/async/pipeline/blob/main/docs/api.md#failure-context-packs) |

### Records

| Feature | Title | Release | Stability | Lifecycle | Replacement | Docs |
| --- | --- | --- | --- | --- | --- | --- |
| `runtime.execution-records` | Execution records and run state | public | stable | active |  | [docs](https://github.com/async/pipeline/blob/main/docs/api.md#execution-record-shape) |
| `runtime.run-lock` | Per-project run lock | public | stable | active |  | [docs](https://github.com/async/pipeline/blob/main/docs/api.md#run-lock) |

### Sandbox

| Feature | Title | Release | Stability | Lifecycle | Replacement | Docs |
| --- | --- | --- | --- | --- | --- | --- |
| `runtime.sandbox.container` | Container sandbox declaration and execution profiles | beta | preview | active |  | [docs](https://github.com/async/pipeline/blob/main/docs/api.md#sandboxes) |

## Supported Surfaces

| Contract | Hash | Features |
| --- | --- | --- |
| `@async/pipeline.cli` | `sha256:b2c8e70d98df0154ebaf48b36dfae473f9b06887c5ad2ddfcc8d0f35c071ebf7` | `cli.github.check`, `cli.github.generate`, `cli.mcp`, `cli.publish.github`, `cli.publish.npm`, `cli.release.doctor`, `cli.run`, `cli.run-task`, `cli.sync.check`, `cli.sync.generate` |
| `@async/pipeline.declaration` | `sha256:470a50761f909c6c36f133dd906287a656b646742f59fd0534fd75f148563071` | `agent.stdoutTo`, `agent.step`, `config.definePipeline`, `config.env`, `config.github.pages`, `config.job`, `config.source`, `config.sync.github`, `config.sync.tasks`, `config.task`, `config.trigger.github`, `config.trigger.manual`, `step.shell` |
| `@async/pipeline.runtime` | `sha256:4f7a485135832d86e4f628b632ec6ebd648fe5fefea0cc9a4d34224d96ae66f9` | `runtime.cache.file`, `runtime.context-packs`, `runtime.execution-records`, `runtime.run-lock`, `runtime.sandbox.container` |

## Required Surfaces

| Contract | Hash | Features |
| --- | --- | --- |
| `@async/pipeline.cli` | `sha256:16a9b6bef958d2482e45d16f86c7097d159f3ab29a8ce1da915678b3ed27b9ce` | `cli.github.check`, `cli.github.generate`, `cli.run`, `cli.sync.check` |
| `@async/pipeline.declaration` | `sha256:ff6973d05adc084697e2972341ebb5443645e02c39938a7b2d33707e3f69a72e` | `config.definePipeline`, `config.job`, `config.task`, `config.trigger.github`, `step.shell` |
