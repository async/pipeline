import assert from "node:assert/strict";
import { test } from "node:test";
import { ASYNC_PIPELINE_DECLARATION, agent, brandDeclaration, buildGraph, cache, command, composePipelines, customCache, defineCache, definePipeline, dependsOn, env, execution, fileCache, githubConfigForJob, job, jobs as jobSection, parseTaskRef, readDeclaration, sh, source, task, tasks as taskSection, tasksForJob, trigger, sandbox } from "../packages/pipeline-core/dist/index.js";

test("declaration factories expose non-enumerable metadata without changing JSON output", () => {
  const examples = [
    [task({}), "task"],
    [job({ target: "build" }), "job"],
    [sh`echo build`, "shell"],
    [sh(() => sh`echo deferred`), "deferred-shell"],
    [dependsOn("build"), "directive.dependsOn"],
    [env.secret("TOKEN"), "env.secret"],
    [env.var("MODE"), "env.var"],
    [source.path({ path: "../app" }), "source.path"],
    [trigger.manual(), "trigger.manual"],
    [sandbox.host(), "sandbox.host"],
    [execution.local(), "execution.local"],
    [command.allow(), "command.allow"],
    [cache.use("file:local"), "directive.cache"],
    [defineCache(), "cache.registry"],
    [fileCache(), "cache.store.file"],
    [taskSection({}), "section.tasks"]
  ];

  for (const [value, kind] of examples) {
    assert.equal(readDeclaration(value).kind, kind);
    const descriptor = Object.getOwnPropertyDescriptor(value, ASYNC_PIPELINE_DECLARATION);
    assert.equal(descriptor?.enumerable, false);
    assert.equal(JSON.stringify(value).includes("@async/pipeline.declaration"), false);
  }
});

test("explicit section factories are accepted and mismatched sections are rejected", () => {
  const taskDefinitions = taskSection({
    build: task({ run: sh`echo build` })
  });

  const pipeline = definePipeline({
    name: "sections",
    tasks: taskDefinitions,
    jobs: jobSection({
      verify: job({ target: "build" })
    })
  });

  assert.equal(readDeclaration(taskDefinitions).kind, "section.tasks");
  assert.deepEqual(Object.keys(pipeline.tasks), ["build"]);

  assert.throws(() => definePipeline({
    name: "bad-sections",
    tasks: jobSection({}),
    jobs: {
      verify: job({ target: "build" })
    }
  }), (error) => error.code === "ASYNC_PIPELINE_SECTION_KIND_MISMATCH");
});

test("normalizes sync command and github runtime declarations", () => {
  const pipeline = definePipeline({
    name: "deno-sync",
    sync: {
      command: "deno task async-pipeline",
      github: {
        runtime: ["node@24", "deno@2"]
      }
    },
    tasks: {
      verify: task({ requires: { runtime: "deno" }, run: sh`deno test` })
    },
    jobs: {
      verify: job({ target: "verify" })
    }
  });

  assert.equal(pipeline.sync.command, "deno task async-pipeline");
  assert.deepEqual(pipeline.sync.github.runtime, ["node@24", "deno@2"]);
  assert.equal(pipeline.tasks.verify.requires.runtime, "deno");

  assert.throws(() => definePipeline({
    name: "bad-command",
    sync: { command: "" },
    tasks: { verify: task({ run: sh`echo ok` }) },
    jobs: { verify: job({ target: "verify" }) }
  }), (error) => error.code === "ASYNC_PIPELINE_SYNC_INVALID_COMMAND");

  assert.throws(() => definePipeline({
    name: "bad-runtime",
    sync: { github: { runtime: "python@3" } },
    tasks: { verify: task({ run: sh`echo ok` }) },
    jobs: { verify: job({ target: "verify" }) }
  }), (error) => error.code === "ASYNC_PIPELINE_SYNC_INVALID_RUNTIME");
});

test("portable branded task and shell nodes normalize through validation", () => {
  const portableShell = brandDeclaration({ command: "echo portable" }, "shell");
  const pipeline = definePipeline({
    name: "portable",
    tasks: {
      portable: brandDeclaration({ run: portableShell }, "task")
    },
    jobs: {
      verify: job({ target: "portable" })
    }
  });

  assert.deepEqual(pipeline.tasks.portable.steps, [{ kind: "shell", command: "echo portable" }]);

  assert.throws(() => definePipeline({
    name: "portable-bad",
    tasks: {
      portable: brandDeclaration({ run: brandDeclaration({ command: "echo portable", extra: true }, "shell") }, "task")
    },
    jobs: {
      verify: job({ target: "portable" })
    }
  }), /unknown field "extra"/);
});

test("task groups flatten default paths and resolve group-local dependencies", () => {
  const pipeline = definePipeline({
    name: "groups",
    tasks: {
      build: task({ run: sh`echo build` }),
      claims: {
        default: task({ run: sh`echo claims` }),
        report: task({ run: sh`echo report` }),
        repair: task({ dependsOn: ["report"], run: sh`echo repair` })
      }
    },
    jobs: {
      verify: job({ target: "claims.repair" })
    }
  });

  assert.deepEqual(Object.keys(pipeline.tasks).sort(), ["build", "claims", "claims.repair", "claims.report"]);
  assert.deepEqual(pipeline.tasks["claims.repair"].dependsOn, ["claims.report"]);
  assert.deepEqual(tasksForJob(pipeline, "verify").executionOrder, ["claims.report", "claims.repair"]);
});

test("task groups keep index as a compatibility alias for group defaults", () => {
  const pipeline = definePipeline({
    name: "groups-index-alias",
    tasks: {
      claims: {
        index: task({ run: sh`echo claims` })
      }
    },
    jobs: {
      verify: job({ target: "claims" })
    }
  });

  assert.deepEqual(Object.keys(pipeline.tasks), ["claims"]);
  assert.deepEqual(tasksForJob(pipeline, "verify").executionOrder, ["claims"]);
});

test("task groups reject invalid keys, collisions, and ambiguous dependencies", () => {
  assert.throws(() => definePipeline({
    name: "bad-dot",
    tasks: {
      claims: {
        "bad.key": task({ run: sh`echo bad` })
      }
    },
    jobs: {
      verify: job({ target: "claims.bad.key" })
    }
  }), (error) => error.code === "ASYNC_PIPELINE_TASK_GROUP_INVALID_KEY");

  assert.throws(() => definePipeline({
    name: "collision",
    tasks: {
      "claims.report": task({ run: sh`echo flat` }),
      claims: {
        report: task({ run: sh`echo grouped` })
      }
    },
    jobs: {
      verify: job({ target: "claims.report" })
    }
  }), (error) => error.code === "ASYNC_PIPELINE_TASK_ID_COLLISION");

  assert.throws(() => definePipeline({
    name: "ambiguous",
    tasks: {
      report: task({ run: sh`echo root` }),
      claims: {
        report: task({ run: sh`echo local` }),
        repair: task({ dependsOn: ["report"], run: sh`echo repair` })
      }
    },
    jobs: {
      verify: job({ target: "claims.repair" })
    }
  }), (error) => error.code === "ASYNC_PIPELINE_TASK_DEPENDENCY_AMBIGUOUS");
});

test("task groups keep source namespace parsing unchanged", () => {
  assert.deepEqual(parseTaskRef("storefront:claims.report"), {
    source: "storefront",
    taskId: "claims.report"
  });
});

test("orders tasks deterministically with dependencies before dependents", () => {
  const pipeline = definePipeline({
    name: "test",
    tasks: {
      build: task({ dependsOn: ["typecheck", "test"], run: sh`echo build` }),
      typecheck: task({ run: sh`echo typecheck` }),
      test: task({ dependsOn: ["typecheck"], run: sh`echo test` })
    },
    jobs: {
      verify: job({ target: "build" })
    }
  });

  assert.deepEqual(tasksForJob(pipeline, "verify").executionOrder, ["typecheck", "test", "build"]);
});

test("buildGraph projection preserves public dependency and dependent shape", () => {
  const pipeline = definePipeline({
    name: "graph-projection",
    tasks: {
      build: task({ dependsOn: ["typecheck", "test"], run: sh`echo build` }),
      typecheck: task({ run: sh`echo typecheck` }),
      test: task({ dependsOn: ["typecheck"], run: sh`echo test` })
    },
    jobs: {
      verify: job({ target: "build" })
    }
  });

  assert.deepEqual(buildGraph(pipeline), {
    tasks: [
      { id: "build", dependsOn: ["test", "typecheck"], dependents: [] },
      { id: "test", dependsOn: ["typecheck"], dependents: ["build"] },
      { id: "typecheck", dependsOn: [], dependents: ["build", "test"] }
    ],
    executionOrder: ["typecheck", "test", "build"]
  });
});

test("rejects missing dependencies", () => {
  assert.throws(() => definePipeline({
    name: "test",
    tasks: {
      build: task({ dependsOn: ["missing"], run: sh`echo build` })
    },
    jobs: {
      verify: job({ target: "build" })
    }
  }), /missing task/);
});

test("rejects cycles", () => {
  assert.throws(() => buildGraph(definePipeline({
    name: "test",
    tasks: {
      a: task({ dependsOn: ["b"], run: sh`echo a` }),
      b: task({ dependsOn: ["a"], run: sh`echo b` })
    },
    jobs: {
      verify: job({ target: "a" })
    }
  })), /cycle/);
});

test("normalizes cache and retry defaults", () => {
  const pipeline = definePipeline({
    name: "test",
    tasks: {
      build: task({ cache: true, retry: 2, run: sh`echo build` })
    },
    jobs: {
      verify: job({ target: "build" })
    }
  });

  assert.equal(pipeline.tasks.build.cache.enabled, true);
  assert.equal(pipeline.tasks.build.retry.attempts, 2);
  assert.equal(pipeline.tasks.build.cache.store, "file");
  assert.equal(pipeline.tasks.build.cache.policy, "local");
});

test("normalizes cache refs and custom registries", () => {
  const registry = defineCache({
    default: "custom:local",
    stores: {
      custom: fileCache({ root: ".async/custom-cache" })
    }
  });
  const pipeline = definePipeline({
    name: "test",
    cache: registry,
    tasks: {
      build: task({ cache: "custom:local", run: sh`echo build` })
    },
    jobs: {
      verify: job({ target: "build" })
    }
  });

  assert.equal(pipeline.cache.stores.custom.root, ".async/custom-cache");
  assert.equal(pipeline.tasks.build.cache.ref, "custom:local");
  assert.equal(pipeline.tasks.build.cache.store, "custom");
  assert.equal(pipeline.tasks.build.cache.policy, "local");
});

test("custom cache stores can carry executable blob adapters", () => {
  const adapter = {
    async get() {
      return null;
    },
    async put() {},
    async touch() {},
    async delete() {},
    async *list() {},
    async prune() {
      return { removed: 0, bytesRemoved: 0 };
    }
  };
  const registry = defineCache({
    default: "remote:local",
    stores: {
      remote: customCache({ adapter, namespace: "suite" })
    }
  });

  assert.equal(registry.stores.remote.adapter, adapter);
  assert.deepEqual(registry.stores.remote.config, { namespace: "suite" });
  assert.throws(
    () => customCache({ adapter: { get() {} } }),
    (error) => error.code === "ASYNC_PIPELINE_INVALID_CACHE_ADAPTER"
  );
  assert.throws(
    () => customCache({ adapter: { async get() {}, async put() {}, prune: true } }),
    (error) => error.code === "ASYNC_PIPELINE_INVALID_CACHE_ADAPTER"
  );
});

test("agent tasks normalize uncached unless the task explicitly opts in", () => {
  const pipeline = definePipeline({
    name: "test",
    agents: { mock: { command: ["node", "mock-agent.mjs"], model: "mock" } },
    tasks: {
      gen: task({ run: agent({ use: "mock", prompt: "write the file" }) })
    },
    jobs: {
      verify: job({ target: "gen" })
    }
  });

  assert.equal(pipeline.tasks.gen.cache.enabled, false);
});

test("agent tasks ignore taskDefaults cache true unless the task opts in", () => {
  const pipeline = definePipeline({
    name: "test",
    agents: { mock: { command: ["node", "mock-agent.mjs"], model: "mock" } },
    taskDefaults: {
      gen: { cache: true }
    },
    tasks: {
      gen: task({ run: agent({ use: "mock", prompt: "write the file" }) })
    },
    jobs: {
      verify: job({ target: "gen" })
    }
  });

  assert.equal(pipeline.tasks.gen.cache.enabled, false);
});

test("agent tasks with explicit cache true stay cached", () => {
  const pipeline = definePipeline({
    name: "test",
    agents: { mock: { command: ["node", "mock-agent.mjs"], model: "mock" } },
    tasks: {
      gen: task({
        cache: true,
        outputs: ["draft.txt"],
        run: agent({ use: "mock", prompt: "write the file" })
      })
    },
    jobs: {
      verify: job({ target: "gen" })
    }
  });

  assert.equal(pipeline.tasks.gen.cache.enabled, true);
  assert.equal(pipeline.tasks.gen.cache.store, "file");
  assert.equal(pipeline.tasks.gen.cache.policy, "local");
});

test("agent tasks with task-owned cache directives stay cached", () => {
  const pipeline = definePipeline({
    name: "test",
    agents: { mock: { command: ["node", "mock-agent.mjs"], model: "mock" } },
    tasks: {
      gen: task({}, [
        cache.use("file:local"),
        agent({ use: "mock", prompt: "write the file" })
      ])
    },
    jobs: {
      verify: job({ target: "gen" })
    }
  });

  assert.equal(pipeline.tasks.gen.cache.enabled, true);
  assert.equal(pipeline.tasks.gen.cache.store, "file");
  assert.equal(pipeline.tasks.gen.cache.policy, "local");
});

test("non-agent tasks still inherit taskDefaults cache", () => {
  const pipeline = definePipeline({
    name: "test",
    taskDefaults: {
      build: { cache: true }
    },
    tasks: {
      build: task({ run: sh`echo build` })
    },
    jobs: {
      verify: job({ target: "build" })
    }
  });

  assert.equal(pipeline.tasks.build.cache.enabled, true);
  assert.equal(pipeline.tasks.build.cache.store, "file");
  assert.equal(pipeline.tasks.build.cache.policy, "local");
});

test("mixed shell and agent tasks follow agent cache inference", () => {
  const pipeline = definePipeline({
    name: "test",
    agents: { mock: { command: ["node", "mock-agent.mjs"], model: "mock" } },
    taskDefaults: {
      gen: { cache: true }
    },
    tasks: {
      gen: task({
        run: [
          sh`echo prepare`,
          agent({ use: "mock", prompt: "write the file" })
        ]
      })
    },
    jobs: {
      verify: job({ target: "gen" })
    }
  });

  assert.equal(pipeline.tasks.gen.cache.enabled, false);
});

test("rejects stale cache-first refs", () => {
  assert.throws(() => definePipeline({
    name: "test",
    tasks: {
      build: task({ cache: "file:cache-first", run: sh`echo build` })
    },
    jobs: {
      verify: job({ target: "build" })
    }
  }), (error) => error.code === "ASYNC_PIPELINE_UNKNOWN_CACHE_POLICY");
});

test("normalizes pipeline and job env definitions", () => {
  const pipeline = definePipeline({
    name: "test",
    env: {
      NODE_ENV: env.var("NODE_ENV", { default: "dev" }),
      API_URL: env.var("NODE_ENV", {
        dev: "http://localhost:3000",
        prod: "https://api.example.com"
      }, {
        default: "dev"
      }),
      LITERAL: "root"
    },
    tasks: {
      build: task({ run: sh`echo build` })
    },
    jobs: {
      verify: job({
        target: "build",
        environment: {
          name: "npm-publish",
          url: "https://www.npmjs.com/package/@async/pipeline"
        },
        requires: {
          provenance: true
        },
        env: {
          LITERAL: "job",
          NODE_AUTH_TOKEN: env.secret("NPM_TOKEN")
        }
      })
    }
  });

  assert.equal(pipeline.env.NODE_ENV.kind, "async-pipeline.env.var");
  assert.equal(pipeline.env.API_URL.kind, "async-pipeline.env.var");
  assert.equal(pipeline.env.LITERAL, "root");
  assert.deepEqual(pipeline.jobs.verify.environment, {
    name: "npm-publish",
    url: "https://www.npmjs.com/package/@async/pipeline"
  });
  assert.deepEqual(pipeline.jobs.verify.requires, { provenance: true });
  assert.equal(pipeline.jobs.verify.env?.LITERAL, "job");
  assert.equal(pipeline.jobs.verify.env?.NODE_AUTH_TOKEN.kind, "async-pipeline.env.secret");
});

test("normalizes sandbox and command policy definitions", () => {
  const pipeline = definePipeline({
    name: "test",
    sandboxes: {
      lima: sandbox.lima({ vm: "async-pipeline" }),
      docker: sandbox.docker({ image: "node:24", workdir: "/workspace" })
    },
    commands: command.policy({
      rules: [
        command.rule({
          prefix: ["npm", "publish"],
          action: command.deny()
        }),
        command.rule({
          exact: ["async-pipeline", "github", "check"],
          action: command.mock({ code: 0, stdout: "current\n" })
        })
      ],
      fallback: command.allow(),
      record: true,
      output: {
        maxBytes: 20_000,
        redactSecrets: true
      }
    }),
    tasks: {
      build: task({ run: sh`echo build` })
    },
    jobs: {
      verify: job({ target: "build" })
    }
  });

  assert.deepEqual(pipeline.sandboxes.lima, { kind: "lima", vm: "async-pipeline" });
  assert.equal(pipeline.sandboxes.docker.kind, "docker");
  assert.equal(pipeline.commands?.rules[0]?.action.kind, "async-pipeline.command.deny");
  assert.equal(pipeline.commands?.rules[1]?.action.kind, "async-pipeline.command.mock");
  assert.equal(pipeline.commands?.fallback?.kind, "async-pipeline.command.allow");
  assert.equal(pipeline.commands?.record, true);
  assert.equal(pipeline.commands?.output?.redactSecrets, true);
});

test("normalizes container sandboxes and execution profiles", () => {
  const pipeline = definePipeline({
    name: "test",
    sandboxes: {
      node24: sandbox.container({
        image: "node:24",
        workdir: "/workspace",
        volumes: [{ source: ".", target: "/workspace" }]
      })
    },
    execution: {
      local: execution.local({ sandbox: "node24", provider: "auto" }),
      linuxCi: execution.github({ sandbox: "node24", provider: "docker", runsOn: "ubuntu-latest" }),
      appleCi: execution.github({ sandbox: "node24", provider: "apple-container", runsOn: ["self-hosted", "macos", "arm64", "apple-container"] })
    },
    tasks: {
      verify: task({ run: sh`echo verify` })
    },
    jobs: {
      verify: job({ target: "verify", execution: "linuxCi", github: { runsOn: "ubuntu-24.04" } })
    }
  });

  assert.equal(pipeline.sandboxes.node24.kind, "container");
  assert.equal(pipeline.execution.local.kind, "local");
  assert.equal(pipeline.execution.linuxCi.provider, "docker");
  assert.equal(pipeline.execution.appleCi.provider, "apple-container");
  assert.equal(pipeline.jobs.verify.execution, "linuxCi");
  assert.equal(githubConfigForJob(pipeline, pipeline.jobs.verify)?.runsOn, "ubuntu-24.04");
});

test("execution profiles reject unknown sandboxes and unsupported apple container runners", () => {
  assert.throws(() => definePipeline({
    name: "missing-sandbox",
    execution: {
      local: execution.local({ sandbox: "missing", provider: "docker" })
    },
    tasks: {
      verify: task({ run: sh`echo verify` })
    },
    jobs: {
      verify: job({ target: "verify", execution: "local" })
    }
  }), (error) => error.code === "ASYNC_PIPELINE_EXECUTION_UNKNOWN_SANDBOX");

  assert.throws(() => definePipeline({
    name: "bad-provider",
    sandboxes: {
      docker: sandbox.docker({ image: "node:24" })
    },
    execution: {
      local: execution.local({ sandbox: "docker", provider: "docker" })
    },
    tasks: {
      verify: task({ run: sh`echo verify` })
    },
    jobs: {
      verify: job({ target: "verify", execution: "local" })
    }
  }), (error) => error.code === "ASYNC_PIPELINE_EXECUTION_PROVIDER_MISMATCH");

  assert.throws(() => definePipeline({
    name: "bad-apple-runner",
    sandboxes: {
      node24: sandbox.container({ image: "node:24" })
    },
    execution: {
      appleCi: execution.github({ sandbox: "node24", provider: "apple-container", runsOn: "ubuntu-latest" })
    },
    tasks: {
      verify: task({ run: sh`echo verify` })
    },
    jobs: {
      verify: job({ target: "verify", execution: "appleCi" })
    }
  }), (error) => error.code === "ASYNC_PIPELINE_EXECUTION_RUNNER_UNSUPPORTED");

  assert.throws(() => definePipeline({
    name: "missing-apple-runner",
    sandboxes: {
      node24: sandbox.container({ image: "node:24" })
    },
    execution: {
      appleCi: execution.github({ sandbox: "node24", provider: "apple-container" })
    },
    tasks: {
      verify: task({ run: sh`echo verify` })
    },
    jobs: {
      verify: job({ target: "verify", execution: "appleCi" })
    }
  }), (error) => error.code === "ASYNC_PIPELINE_EXECUTION_RUNNER_UNSUPPORTED");
});

test("rejects unknown cache stores and policies", () => {
  assert.throws(() => definePipeline({
    name: "test",
    tasks: {
      build: task({ cache: "redis:local", run: sh`echo build` })
    },
    jobs: {
      verify: job({ target: "build" })
    }
  }), (error) => error.code === "ASYNC_PIPELINE_UNKNOWN_CACHE_STORE");

  assert.throws(() => definePipeline({
    name: "test",
    tasks: {
      build: task({ cache: "file:unknown", run: sh`echo build` })
    },
    jobs: {
      verify: job({ target: "build" })
    }
  }), (error) => error.code === "ASYNC_PIPELINE_UNKNOWN_CACHE_POLICY");
});

test("lifts run-array cache and dependsOn directives into task metadata", () => {
  const pipeline = definePipeline({
    name: "test",
    tasks: {
      build: task({ run: sh`echo build` }),
      deploy: task({}, [
        dependsOn("build"),
        cache.use("file:local"),
        sh`echo deploy`
      ])
    },
    jobs: {
      verify: job({ target: "deploy" })
    }
  });

  assert.deepEqual(pipeline.tasks.deploy.dependsOn, ["build"]);
  assert.equal(pipeline.tasks.deploy.cache.store, "file");
  assert.deepEqual(tasksForJob(pipeline, "verify").executionOrder, ["build", "deploy"]);
});

test("rejects task config run with a second run argument", () => {
  assert.throws(() => task({ run: sh`echo config` }, sh`echo arg`), (error) => error.code === "ASYNC_PIPELINE_TASK_ARGUMENT_CONFLICT");
});

test("normalizes cron and filtered github triggers", () => {
  const pipeline = definePipeline({
    name: "test",
    triggers: {
      main: trigger.github({ events: ["push"], branches: ["main"] }),
      release: trigger.github({ events: ["release"], types: ["published"] }),
      nightly: trigger.cron("17 2 * * *", { timezone: "UTC" })
    },
    tasks: {
      build: task({ run: sh`echo build` })
    },
    jobs: {
      verify: job({ target: "build", trigger: ["main", "nightly"] })
    }
  });

  assert.deepEqual(pipeline.triggers.main.branches, ["main"]);
  assert.deepEqual(pipeline.triggers.release.types, ["published"]);
  assert.equal(pipeline.triggers.nightly.cron, "17 2 * * *");
  assert.equal(pipeline.triggers.nightly.timezone, "UTC");
});

test("normalizes sync github and task defaults independently from triggers", () => {
  const pipeline = definePipeline({
    name: "test",
    triggers: {
      main: trigger.github({ events: ["push"], branches: ["main"] })
    },
    sync: {
      github: true,
      tasks: true
    },
    tasks: {
      build: task({ run: sh`echo build` })
    },
    jobs: {
      verify: job({ target: "build", trigger: ["main"] })
    }
  });

  assert.equal(pipeline.sync.github.enabled, true);
  assert.equal(pipeline.sync.github.workflow, ".github/workflows/async-pipeline.yml");
  assert.equal(pipeline.sync.github.setup, "pnpm");
  assert.equal(pipeline.sync.github.cache, true);
  assert.equal(pipeline.sync.github.dependencyCache, true);
  assert.deepEqual(pipeline.sync.github.dependabotAutoMerge, {
    enabled: false,
    ecosystems: ["github-actions", "npm", "deno"]
  });
  assert.deepEqual(pipeline.sync.github.packagePreviews, {
    enabled: false,
    registry: "https://npm.pkg.github.com",
    tokenEnv: "GITHUB_TOKEN",
    comment: true
  });
  assert.deepEqual(pipeline.sync.github.pages, {
    enabled: false,
    job: "pages",
    build: { kind: "static", path: ".async/pages" },
    triggers: {
      pullRequest: true,
      main: { branch: "main" },
      manual: true
    }
  });
  assert.equal(pipeline.sync.tasks.enabled, true);
  assert.equal(pipeline.sync.tasks.prefix, "pipeline");
  assert.equal(pipeline.sync.tasks.runners, "all");
  assert.equal(pipeline.sync.tasks.targets, "root");
  assert.equal(pipeline.sync.tasks.jobs, "all");
  assert.deepEqual(pipeline.triggers.main.branches, ["main"]);
});

test("normalizes explicit sync task config and validates selected ids", () => {
  const pipeline = definePipeline({
    name: "test",
    sync: {
      github: {
        workflow: ".tmp/workflow.yml",
        lock: ".tmp/lock.json",
        setup: "node",
        dependabotAutoMerge: { ecosystems: ["github-actions"] },
        packagePreviews: {
          package: "packages/example",
          target: "pack",
          registry: "https://registry.example.test",
          namespace: "preview",
          tokenEnv: "PACKAGES_TOKEN",
          comment: false
        },
        pages: {
          target: "docs.site",
          job: "docs-pages",
          build: { kind: "static", path: ".async/site" },
          artifactName: "docs-site",
          environment: { name: "docs", url: "https://example.test" },
          triggers: {
            pullRequest: false,
            main: { branch: "stable" },
            manual: true
          }
        }
      },
      tasks: {
        prefix: "ci",
        runners: ["package"],
        targets: [{ package: "fixture" }],
        jobs: ["verify"],
        tasks: ["build"],
        scripts: {
          "sync:check": "sync check"
        }
      }
    },
    tasks: {
      build: task({ run: sh`echo build` })
    },
    jobs: {
      verify: job({ target: "build" })
    }
  });

  assert.equal(pipeline.sync.github.workflow, ".tmp/workflow.yml");
  assert.equal(pipeline.sync.github.setup, "node");
  assert.equal(pipeline.sync.github.dependencyCache, true);
  assert.deepEqual(pipeline.sync.github.dependabotAutoMerge, {
    enabled: true,
    ecosystems: ["github-actions"]
  });
  assert.deepEqual(pipeline.sync.github.packagePreviews, {
    enabled: true,
    package: "packages/example",
    target: "pack",
    registry: "https://registry.example.test",
    namespace: "preview",
    tokenEnv: "PACKAGES_TOKEN",
    comment: false
  });
  assert.deepEqual(pipeline.sync.github.pages, {
    enabled: true,
    target: "docs.site",
    job: "docs-pages",
    build: { kind: "static", path: ".async/site" },
    artifactName: "docs-site",
    environment: { name: "docs", url: "https://example.test" },
    triggers: {
      pullRequest: false,
      main: { branch: "stable" },
      manual: true
    }
  });
  assert.deepEqual(pipeline.sync.tasks.runners, ["package"]);
  assert.deepEqual(pipeline.sync.tasks.jobs, ["verify"]);
  assert.deepEqual(pipeline.sync.tasks.tasks, ["build"]);
  assert.equal(pipeline.sync.tasks.scripts["sync:check"], "sync check");

  assert.throws(() => definePipeline({
    name: "bad",
    sync: {
      github: {
        setup: "python"
      }
    },
    tasks: { build: task({ run: sh`echo build` }) },
    jobs: { verify: job({ target: "build" }) }
  }), (error) => error.code === "ASYNC_PIPELINE_SYNC_INVALID_GITHUB_SETUP" && /python/.test(error.message));

  assert.throws(() => definePipeline({
    name: "bad",
    sync: {
      tasks: {
        jobs: ["missing"]
      }
    },
    tasks: {
      build: task({ run: sh`echo build` })
    },
    jobs: {
      verify: job({ target: "build" })
    }
  }), (error) => error.code === "ASYNC_PIPELINE_SYNC_UNKNOWN_JOB");
});

test("normalizes timeout durations", () => {
  const pipeline = definePipeline({
    name: "test",
    tasks: {
      build: task({ timeout: "2s", run: sh`echo build` })
    },
    jobs: {
      verify: job({ target: "build" })
    }
  });

  assert.equal(pipeline.tasks.build.timeoutMs, 2000);
});

test("normalizes sources and allows declared external task refs as metadata", () => {
  let evaluated = 0;
  const pipeline = definePipeline({
    name: "design-system",
    sources: {
      app: source.path({
        path: "../app",
        pipeline: "pipeline.ts",
        prepare: [sh((ctx) => {
          evaluated += 1;
          return sh`echo ${ctx.candidate.dir}`;
        })]
      })
    },
    tasks: {
      impact: task({ dependsOn: ["app:test"], run: sh`echo impact` })
    },
    jobs: {
      verifyImpact: job({ target: "impact" })
    }
  });

  assert.equal(evaluated, 0);
  assert.equal(pipeline.sources.app.type, "path");
  assert.equal(pipeline.sources.app.prepare[0]?.kind, "deferred-shell");
  assert.deepEqual(tasksForJob(pipeline, "verifyImpact").executionOrder, ["app:test", "impact"]);
});

test("rejects local task ids containing source namespace delimiter", () => {
  assert.throws(() => definePipeline({
    name: "bad",
    tasks: {
      "app:test": task({ run: sh`echo bad` })
    },
    jobs: {
      verify: job({ target: "app:test" })
    }
  }), /cannot contain ":"/);
});

test("composes source pipeline tasks into a namespaced graph", () => {
  const root = definePipeline({
    name: "root",
    sources: {
      app: source.path({ path: "../app" })
    },
    tasks: {
      impact: task({ dependsOn: ["app:test"], run: sh`echo impact` })
    },
    jobs: {
      verifyImpact: job({ target: "impact" })
    }
  });
  const app = definePipeline({
    name: "app",
    tasks: {
      build: task({ run: sh`echo build` }),
      test: task({ dependsOn: ["build"], run: sh`echo test` })
    },
    jobs: {
      verify: job({ target: "test" })
    }
  });

  const composed = composePipelines(root, {
    app: {
      pipeline: app,
      context: { name: "app", dir: "/tmp/app", type: "path" }
    }
  });

  assert.deepEqual(tasksForJob(composed, "verifyImpact").executionOrder, ["app:build", "app:test", "impact"]);
  assert.equal(composed.tasks["app:test"].source.dir, "/tmp/app");
});

test("detects missing tasks when loaded source metadata is composed", () => {
  const root = definePipeline({
    name: "root",
    sources: {
      app: source.path({ path: "../app" })
    },
    tasks: {
      impact: task({ dependsOn: ["app:missing"], run: sh`echo impact` })
    },
    jobs: {
      verifyImpact: job({ target: "impact" })
    }
  });
  const app = definePipeline({
    name: "app",
    tasks: {
      test: task({ run: sh`echo test` })
    },
    jobs: {
      verify: job({ target: "test" })
    }
  });

  assert.throws(() => composePipelines(root, { app: { pipeline: app } }), /missing task "app:missing"/);
});

test("named input cycles fail fast at definePipeline time", () => {
  assert.throws(() => definePipeline({
    name: "cycle",
    namedInputs: { a: ["b"], b: ["a"] },
    tasks: { t: task({ inputs: ["a"], cache: false, run: sh`true` }) },
    jobs: { j: job({ target: "t" }) }
  }), /ASYNC_PIPELINE_INPUT_CYCLE|Named input cycle/);
});

test("github runner config rejects invalid and conflicting settings", () => {
  const base = {
    name: "runners",
    tasks: { t: task({ cache: false, run: sh`true` }) }
  };
  assert.throws(() => definePipeline({
    ...base,
    jobs: { j: job({ target: "t", github: { runsOn: "" } }) }
  }), /ASYNC_PIPELINE_RUNS_ON_INVALID|invalid github\.runsOn/);

  assert.throws(() => definePipeline({
    ...base,
    jobs: { j: job({ target: "t", github: { runsOnMatrix: [] } }) }
  }), /ASYNC_PIPELINE_RUNS_ON_INVALID|runsOnMatrix must be a non-empty array/);

  assert.throws(() => definePipeline({
    ...base,
    jobs: { j: job({ target: "t", github: { runsOn: "ubuntu-latest", runsOnMatrix: ["ubuntu-latest"] } }) }
  }), /ASYNC_PIPELINE_RUNS_ON_CONFLICT|sets both github\.runsOn and github\.runsOnMatrix/);
});

test("rejects unknown config fields with the field name", () => {
  const base = {
    name: "strict",
    tasks: { t: task({ cache: false, run: sh`true` }) },
    jobs: { j: job({ target: "t" }) }
  };

  assert.throws(() => definePipeline({ ...base, sycn: { github: true } }),
    /ASYNC_PIPELINE_UNKNOWN_FIELD|unknown field "sycn"/);

  assert.throws(() => definePipeline({
    ...base,
    tasks: { t: { cache: false, timout: "2m", run: sh`true` } }
  }), /unknown field "timout"/);

  assert.throws(() => definePipeline({
    ...base,
    jobs: { j: { target: "t", mode: "ci" } }
  }), /Job "j" has unknown field "mode"/);

  assert.throws(() => definePipeline({
    ...base,
    jobs: { j: { target: "t", github: { runson: "ubuntu-latest" } } }
  }), /github config has unknown field "runson"/);

  assert.throws(() => definePipeline({
    ...base,
    sync: { github: { packagePreviews: { namespacee: "async" } } }
  }), /sync\.github\.packagePreviews has unknown field "namespacee"/);

  assert.throws(() => definePipeline({
    ...base,
    sync: { github: { pages: { targt: "docs.site" } } }
  }), /sync\.github\.pages has unknown field "targt"/);

  assert.throws(() => definePipeline({
    ...base,
    sync: { github: { pages: { triggers: { manuel: true } } } }
  }), /sync\.github\.pages\.triggers has unknown field "manuel"/);

  assert.throws(() => definePipeline({
    ...base,
    sync: { github: { dependabotAutoMerge: { ecosystems: ["docker"] } } }
  }), /ASYNC_PIPELINE_DEPENDABOT_AUTO_MERGE_INVALID|Unsupported Dependabot auto-merge ecosystem/);

  assert.throws(() => definePipeline({
    ...base,
    taskDefaults: { t: { catch: true } }
  }), /taskDefaults\["t"\] has unknown field "catch"/);
});
