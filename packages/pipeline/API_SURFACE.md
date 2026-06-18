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
| `config.sync.github.pages` | Generated GitHub Pages sync declaration | beta | preview | active |  | [docs](https://github.com/async/pipeline/blob/main/docs/github-actions.md) |
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
| `cli.publish.github` | GitHub Packages preview, snapshot, and release publishing | beta | preview | deprecated | `async/actions/publish` | [docs](https://github.com/async/pipeline/blob/main/docs/api.md#package-lifecycle-actions) |
| `cli.publish.npm` | npm publish with provenance and idempotent existing-version skip | beta | preview | deprecated | `async/actions/publish` | [docs](https://github.com/async/pipeline/blob/main/docs/api.md#package-lifecycle-actions) |
| `cli.release.doctor` | Release doctor verification for npm, GitHub Packages, and GitHub Releases | beta | preview | deprecated | `async/actions/publish` | [docs](https://github.com/async/pipeline/blob/main/docs/api.md#package-lifecycle-actions) |

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
| `runtime.cache.adapter` | Custom cache store adapter execution | beta | preview | active |  | [docs](https://github.com/async/pipeline/blob/main/docs/api.md#definecache) |
| `runtime.cache.file` | File cache execution and output restoration | public | stable | active |  | [docs](https://github.com/async/pipeline/blob/main/docs/api.md#definecache) |
| `runtime.cache.lifecycle` | Cache store lifecycle hooks | beta | preview | active |  | [docs](https://github.com/async/pipeline/blob/main/docs/api.md#definecache) |
| `runtime.cache.redis` | Redis cache execution | beta | preview | active |  | [docs](https://github.com/async/pipeline/blob/main/docs/api.md#definecache) |

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
| `@async/pipeline.declaration` | `sha256:64f2e3ce33470a013cb4e5fa3a8d3a22eede253c29d1f9f3aae96446d5697a22` | `agent.stdoutTo`, `agent.step`, `config.definePipeline`, `config.env`, `config.github.pages`, `config.job`, `config.source`, `config.sync.github`, `config.sync.github.pages`, `config.sync.tasks`, `config.task`, `config.trigger.github`, `config.trigger.manual`, `step.shell` |
| `@async/pipeline.runtime` | `sha256:71c3e018e8def16f9fd73fe9551169dff6672b21a082fea776a7d101a2932a30` | `runtime.cache.adapter`, `runtime.cache.file`, `runtime.cache.redis`, `runtime.context-packs`, `runtime.execution-records`, `runtime.run-lock`, `runtime.sandbox.container` |

## Required Surfaces

| Contract | Hash | Features |
| --- | --- | --- |
| `@async/pipeline.cli` | `sha256:16a9b6bef958d2482e45d16f86c7097d159f3ab29a8ce1da915678b3ed27b9ce` | `cli.github.check`, `cli.github.generate`, `cli.run`, `cli.sync.check` |
| `@async/pipeline.declaration` | `sha256:ff6973d05adc084697e2972341ebb5443645e02c39938a7b2d33707e3f69a72e` | `config.definePipeline`, `config.job`, `config.task`, `config.trigger.github`, `step.shell` |

## Deprecated And Removed Features

| Feature | Lifecycle | Since | Replacement |
| --- | --- | --- | --- |
| `cli.publish.github` | deprecated | 0.9.0 | `async/actions/publish` |
| `cli.publish.npm` | deprecated | 0.9.0 | `async/actions/publish` |
| `cli.release.doctor` | deprecated | 0.9.0 | `async/actions/publish` |
