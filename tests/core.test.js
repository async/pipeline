import assert from "node:assert/strict";
import { test } from "node:test";
import { buildGraph, cache, command, composePipelines, defineCache, definePipeline, dependsOn, env, fileCache, job, sh, source, task, tasksForJob, trigger, sandbox } from "../packages/pipeline-core/dist/index.js";

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
        lock: ".tmp/lock.json"
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
  assert.deepEqual(pipeline.sync.tasks.runners, ["package"]);
  assert.deepEqual(pipeline.sync.tasks.jobs, ["verify"]);
  assert.deepEqual(pipeline.sync.tasks.tasks, ["build"]);
  assert.equal(pipeline.sync.tasks.scripts["sync:check"], "sync check");

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
    taskDefaults: { t: { catch: true } }
  }), /taskDefaults\["t"\] has unknown field "catch"/);
});
