# Generated Update Train And Dependency Bump

This example shows the two sides of a generated release train.

Producer repos announce a released package:

```ts
sync: {
  github: {
    updateTrain: {
      package: "packages/pipeline",
      repositories: ["async/flow", "async/framework"],
      event: "async-dep-bump",
      tokenEnv: "ASYNC_RELEASE_TRAIN_TOKEN",
      after: "publish"
    }
  }
}
```

Receiver repos accept the dispatch and update an allowed direct dependency:

```ts
sync: {
  github: {
    dependencyBump: {
      packages: ["@async/pipeline"],
      verify: ["pnpm async-pipeline sync generate", "pnpm test"],
      success: "push",
      failure: "pull-request"
    }
  }
}
```

The producer workflow owns triggers, `needs`, manual inputs, repository targets,
and secret mapping. The receiver workflow owns dispatch filtering, permissions,
package allowlists, verification commands, and landing policy.

## Try It Locally

```sh
pnpm async-pipeline github generate
pnpm async-pipeline sync check
pnpm async-pipeline github plan --job update-train --event release --event-action published
pnpm async-pipeline github plan --job dependency-bump --event repository_dispatch --event-action async-dep-bump
```
