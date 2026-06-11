import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { command, definePipeline, env, job, sh, task } from "../packages/pipeline-core/dist/index.js";
import { commandProxy, hostWorkspace, planJob, runJob, runSingleTask } from "../packages/pipeline-node/dist/runner.js";

test("commandProxy mocks matching commands and records bounded redacted output", async () => {
  const commands = commandProxy(command.policy({
    rules: [
      command.rule({
        exact: ["npm", "publish"],
        action: command.mock({
          code: 0,
          stdout: "published secret-value with extra output"
        })
      })
    ],
    record: true,
    output: {
      maxBytes: 18,
      redactSecrets: true
    }
  }));

  const result = await commands.run({
    argv: ["npm", "publish"],
    cwd: "/repo",
    env: {
      NPM_TOKEN: "secret-value"
    }
  }, async () => ({
    code: 9,
    stdout: "should not run",
    stderr: ""
  }));

  assert.equal(result.code, 0);
  assert.equal(result.stdout, "published secret-value with extra output");
  const records = commands.records();
  assert.equal(records.length, 1);
  assert.equal(records[0]?.status, "mocked");
  assert.doesNotMatch(records[0]?.stdout ?? "", /secret-value/);
  assert.match(records[0]?.stdout ?? "", /output truncated/);
});

test("commandProxy denies matching commands and allows unmatched commands by default", async () => {
  const commands = commandProxy(command.policy({
    rules: [
      command.rule({
        prefix: ["npm", "publish"],
        action: command.deny({ message: "publish disabled" })
      })
    ],
    record: true
  }));

  const denied = await commands.run({
    argv: ["npm", "publish", "--provenance"],
    cwd: "/repo",
    env: {}
  }, async () => ({
    code: 0,
    stdout: "should not run",
    stderr: ""
  }));

  const allowed = await commands.run({
    argv: ["pnpm", "test"],
    cwd: "/repo",
    env: {}
  }, async () => ({
    code: 0,
    stdout: "tests passed\n",
    stderr: ""
  }));

  assert.equal(denied.code, 1);
  assert.match(denied.stderr, /publish disabled/);
  assert.equal(allowed.code, 0);
  assert.equal(allowed.stdout, "tests passed\n");
  assert.deepEqual(commands.records().map((record) => record.status), ["denied", "allowed"]);
});

test("task timeout fails the execution and records the error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-timeout-"));
  try {
    const pipeline = definePipeline({
      name: "timeout-test",
      tasks: {
        slow: task({
          cache: false,
          timeout: 50,
          run: sh`node -e "setTimeout(() => {}, 250)"`
        })
      },
      jobs: {
        verify: job({ target: "slow" })
      }
    });

    const record = await runSingleTask(pipeline, "slow", {
      workspace: hostWorkspace({ cwd: dir })
    });

    assert.equal(record.status, "failed");
    assert.equal(record.tasks[0]?.status, "failed");
    assert.match(record.tasks[0]?.error ?? "", /timed out/);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("job env secrets fail before execution when missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-secret-"));
  try {
    const pipeline = definePipeline({
      name: "secret-test",
      tasks: {
        publish: task({
          cache: false,
          run: sh`node -e "process.exit(2)"`
        })
      },
      jobs: {
        publish: job({
          target: "publish",
          env: {
            ASYNC_PIPELINE_TEST_SECRET_DESTINATION: env.secret("ASYNC_PIPELINE_TEST_SECRET")
          }
        })
      }
    });

    const record = await runJob(pipeline, {
      id: "publish",
      workspace: hostWorkspace({
        cwd: dir,
        env: { PATH: process.env.PATH }
      })
    });

    assert.equal(record.status, "failed");
    assert.equal(record.tasks[0]?.status, "failed");
    assert.match(record.tasks[0]?.error ?? "", /Required secret "ASYNC_PIPELINE_TEST_SECRET" for env "ASYNC_PIPELINE_TEST_SECRET_DESTINATION"/);
    assert.doesNotMatch(record.tasks[0]?.error ?? "", /exit code 2/);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("pipeline and job env resolve into function task context", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-env-context-"));
  try {
    const pipeline = definePipeline({
      name: "env-test",
      env: {
        NODE_ENV: env.var("ASYNC_PIPELINE_ENV_TEST_NODE_ENV", { default: "dev" }),
        API_URL: env.var("NODE_ENV", {
          dev: "http://localhost:3000",
          prod: "https://api.example.com"
        }, {
          default: "dev"
        }),
        SHARED: "pipeline"
      },
      tasks: {
        check: task({
          cache: false,
          run(context) {
            assert.equal(context.env.NODE_ENV, "dev");
            assert.equal(context.env.API_URL, "http://localhost:3000");
            assert.equal(context.env.SHARED, "job");
          }
        })
      },
      jobs: {
        check: job({
          target: "check",
          env: {
            SHARED: "job"
          }
        })
      }
    });

    const record = await runJob(pipeline, {
      id: "check",
      workspace: hostWorkspace({
        cwd: dir,
        env: { PATH: process.env.PATH }
      })
    });

    assert.equal(record.status, "passed");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("run records include schema version and owner pid", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-record-version-"));
  try {
    const pipeline = definePipeline({
      name: "record-version-test",
      tasks: {
        check: task({
          cache: false,
          run() {}
        })
      },
      jobs: {
        check: job({ target: "check" })
      }
    });

    const record = await runJob(pipeline, {
      id: "check",
      workspace: hostWorkspace({ cwd: dir })
    });

    assert.equal(record.status, "passed");
    assert.equal(record.schemaVersion, 1);
    assert.equal(record.pid, process.pid);

    const persisted = JSON.parse(await readFile(join(dir, ".async", "runs", record.id, "execution.json"), "utf8"));
    assert.equal(persisted.schemaVersion, 1);
    assert.equal(persisted.pid, process.pid);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("CI env records ci execution mode", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-ci-mode-"));
  try {
    const pipeline = definePipeline({
      name: "ci-mode-test",
      tasks: {
        check: task({
          cache: false,
          run() {}
        })
      },
      jobs: {
        check: job({ target: "check" })
      }
    });

    const record = await runJob(pipeline, {
      id: "check",
      workspace: hostWorkspace({ cwd: dir, env: { CI: "true" } })
    });

    assert.equal(record.status, "passed");
    assert.equal(record.mode, "ci");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("env secrets can resolve from rendered destination env", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-secret-destination-"));
  try {
    const pipeline = definePipeline({
      name: "secret-destination-test",
      tasks: {
        check: task({
          cache: false,
          run(context) {
            assert.equal(context.env.NODE_AUTH_TOKEN, "rendered-secret");
          }
        })
      },
      jobs: {
        check: job({
          target: "check",
          env: {
            NODE_AUTH_TOKEN: env.secret("ASYNC_PIPELINE_TEST_SECRET_SOURCE")
          }
        })
      }
    });

    const record = await runJob(pipeline, {
      id: "check",
      workspace: hostWorkspace({
        cwd: dir,
        env: {
          PATH: process.env.PATH,
          NODE_AUTH_TOKEN: "rendered-secret"
        }
      })
    });

    assert.equal(record.status, "passed");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("mapped env vars fail before execution when unmapped", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-env-unmapped-"));
  try {
    const pipeline = definePipeline({
      name: "env-unmapped-test",
      env: {
        API_URL: env.var("ASYNC_PIPELINE_ENV_TEST_NODE_ENV", {
          dev: "http://localhost:3000",
          prod: "https://api.example.com"
        })
      },
      tasks: {
        check: task({
          cache: false,
          run: sh`node -e "process.exit(2)"`
        })
      },
      jobs: {
        check: job({ target: "check" })
      }
    });

    const record = await runJob(pipeline, {
      id: "check",
      workspace: hostWorkspace({
        cwd: dir,
        env: {
          PATH: process.env.PATH,
          ASYNC_PIPELINE_ENV_TEST_NODE_ENV: "stage"
        }
      })
    });

    assert.equal(record.status, "failed");
    assert.match(record.tasks[0]?.error ?? "", /value "stage" is not mapped/);
    assert.doesNotMatch(record.tasks[0]?.error ?? "", /exit code 2/);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("runJob schedules ready tasks in parallel up to concurrency", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-parallel-"));
  let releaseA = () => {};
  let releaseB = () => {};
  let bothStarted = () => {};
  const waitA = new Promise((resolve) => {
    releaseA = resolve;
  });
  const waitB = new Promise((resolve) => {
    releaseB = resolve;
  });
  const bothStartedPromise = new Promise((resolve) => {
    bothStarted = resolve;
  });
  const events = [];
  const markStarted = (taskId) => {
    events.push(`${taskId}:start`);
    if (events.includes("a:start") && events.includes("b:start")) bothStarted();
  };

  try {
    const pipeline = definePipeline({
      name: "parallel-test",
      tasks: {
        a: task({
          cache: false,
          async run() {
            markStarted("a");
            await waitA;
            events.push("a:end");
          }
        }),
        b: task({
          cache: false,
          async run() {
            markStarted("b");
            await waitB;
            events.push("b:end");
          }
        }),
        c: task({
          dependsOn: ["a", "b"],
          cache: false,
          run() {
            events.push("c:start");
          }
        })
      },
      jobs: {
        verify: job({ target: "c" })
      }
    });

    const run = runJob(pipeline, {
      id: "verify",
      concurrency: 2,
      workspace: hostWorkspace({ cwd: dir })
    });
    await Promise.race([
      bothStartedPromise,
      delay(1000).then(() => assert.fail(`ready tasks did not start in parallel: ${events.join(", ")}`))
    ]);
    assert.deepEqual(new Set(events), new Set(["a:start", "b:start"]));

    releaseA();
    releaseB();
    const record = await run;

    assert.equal(record.status, "passed");
    assert.deepEqual(record.tasks.map((entry) => entry.id), ["a", "b", "c"]);
    assert.equal(events.at(-1), "c:start");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("runJob rejects invalid concurrency", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-invalid-concurrency-"));
  try {
    const pipeline = definePipeline({
      name: "invalid-concurrency-test",
      tasks: {
        test: task({ cache: false, run() {} })
      },
      jobs: {
        verify: job({ target: "test" })
      }
    });

    await assert.rejects(
      () => runJob(pipeline, { id: "verify", concurrency: 0, workspace: hostWorkspace({ cwd: dir }) }),
      /Task concurrency must be a positive integer/
    );
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("file cache restores declared outputs on cache hit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-output-restore-"));
  try {
    const pipeline = definePipeline({
      name: "output-restore-test",
      tasks: {
        build: task({
          cache: true,
          outputs: ["dist/**"],
          async run() {
            await mkdir(join(dir, "dist"), { recursive: true });
            await writeFile(join(dir, "dist", "artifact.txt"), "restored output\n", "utf8");
          }
        })
      },
      jobs: {
        verify: job({ target: "build" })
      }
    });

    const first = await runJob(pipeline, {
      id: "verify",
      workspace: hostWorkspace({ cwd: dir })
    });
    assert.equal(first.tasks[0]?.status, "passed");

    await rm(join(dir, "dist"), { force: true, recursive: true });
    const second = await runJob(pipeline, {
      id: "verify",
      workspace: hostWorkspace({ cwd: dir })
    });

    assert.equal(second.tasks[0]?.status, "cached");
    assert.equal(await readFile(join(dir, "dist", "artifact.txt"), "utf8"), "restored output\n");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("result-only file cache entries for output tasks rerun and repopulate outputs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-legacy-output-cache-"));
  let runs = 0;
  try {
    const pipeline = definePipeline({
      name: "legacy-output-test",
      tasks: {
        build: task({
          cache: true,
          outputs: ["dist/**"],
          async run() {
            runs += 1;
            await mkdir(join(dir, "dist"), { recursive: true });
            await writeFile(join(dir, "dist", "artifact.txt"), `run ${runs}\n`, "utf8");
          }
        })
      },
      jobs: {
        verify: job({ target: "build" })
      }
    });

    const first = await runJob(pipeline, {
      id: "verify",
      workspace: hostWorkspace({ cwd: dir })
    });
    const cacheKey = first.tasks[0]?.cacheKey;
    assert.equal(first.tasks[0]?.status, "passed");
    assert.ok(cacheKey);

    await rm(join(dir, "dist"), { force: true, recursive: true });
    await rm(join(dir, ".async", "cache", "tasks", cacheKey, "outputs.json"), { force: true });
    await rm(join(dir, ".async", "cache", "tasks", cacheKey, "outputs"), { force: true, recursive: true });

    const second = await runJob(pipeline, {
      id: "verify",
      workspace: hostWorkspace({ cwd: dir })
    });

    assert.equal(second.tasks[0]?.status, "passed");
    assert.equal(runs, 2);
    assert.equal(await readFile(join(dir, "dist", "artifact.txt"), "utf8"), "run 2\n");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("ttlMs expires otherwise valid cache entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-cache-ttl-"));
  let runs = 0;
  try {
    const pipeline = definePipeline({
      name: "ttl-test",
      tasks: {
        test: task({
          cache: { ttlMs: 1 },
          run() {
            runs += 1;
          }
        })
      },
      jobs: {
        verify: job({ target: "test" })
      }
    });

    const first = await runJob(pipeline, {
      id: "verify",
      workspace: hostWorkspace({ cwd: dir })
    });
    assert.equal(first.tasks[0]?.status, "passed");
    await new Promise((resolve) => setTimeout(resolve, 20));

    const second = await runJob(pipeline, {
      id: "verify",
      workspace: hostWorkspace({ cwd: dir })
    });

    assert.equal(second.tasks[0]?.status, "passed");
    assert.equal(runs, 2);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("dependency cache keys invalidate direct dependents", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-dependency-cache-"));
  let buildRuns = 0;
  let testRuns = 0;
  try {
    await writeFile(join(dir, "build-input.txt"), "one\n", "utf8");
    await writeFile(join(dir, "test-input.txt"), "stable\n", "utf8");
    const pipeline = definePipeline({
      name: "dependency-cache-test",
      tasks: {
        build: task({
          cache: true,
          inputs: ["build-input.txt"],
          run() {
            buildRuns += 1;
          }
        }),
        test: task({
          dependsOn: ["build"],
          cache: true,
          inputs: ["test-input.txt"],
          run() {
            testRuns += 1;
          }
        })
      },
      jobs: {
        verify: job({ target: "test" })
      }
    });

    const first = await runJob(pipeline, {
      id: "verify",
      workspace: hostWorkspace({ cwd: dir })
    });
    assert.deepEqual(first.tasks.map((entry) => entry.status), ["passed", "passed"]);

    const second = await runJob(pipeline, {
      id: "verify",
      workspace: hostWorkspace({ cwd: dir })
    });
    assert.deepEqual(second.tasks.map((entry) => entry.status), ["cached", "cached"]);

    await writeFile(join(dir, "build-input.txt"), "two\n", "utf8");
    const third = await runJob(pipeline, {
      id: "verify",
      workspace: hostWorkspace({ cwd: dir })
    });

    assert.deepEqual(third.tasks.map((entry) => entry.status), ["passed", "passed"]);
    assert.equal(buildRuns, 2);
    assert.equal(testRuns, 2);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("memory cache only honors output task hits while outputs still exist", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-memory-output-cache-"));
  let runs = 0;
  try {
    const pipeline = definePipeline({
      name: "memory-output-test",
      tasks: {
        build: task({
          cache: "memory:session",
          outputs: ["dist/**"],
          async run() {
            runs += 1;
            await mkdir(join(dir, "dist"), { recursive: true });
            await writeFile(join(dir, "dist", "artifact.txt"), `run ${runs}\n`, "utf8");
          }
        })
      },
      jobs: {
        verify: job({ target: "build" })
      }
    });

    const first = await runJob(pipeline, {
      id: "verify",
      workspace: hostWorkspace({ cwd: dir })
    });
    const second = await runJob(pipeline, {
      id: "verify",
      workspace: hostWorkspace({ cwd: dir })
    });
    await rm(join(dir, "dist"), { force: true, recursive: true });
    const third = await runJob(pipeline, {
      id: "verify",
      workspace: hostWorkspace({ cwd: dir })
    });

    assert.equal(first.tasks[0]?.status, "passed");
    assert.equal(second.tasks[0]?.status, "cached");
    assert.equal(third.tasks[0]?.status, "passed");
    assert.equal(runs, 2);
    assert.equal(await readFile(join(dir, "dist", "artifact.txt"), "utf8"), "run 2\n");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("resolved secret values are redacted from stored task logs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-redact-"));
  try {
    const pipeline = definePipeline({
      name: "redact-test",
      tasks: {
        leak: task({
          cache: false,
          run: sh`node -e "console.log('value: ' + process.env.LEAKED_DESTINATION)"`
        })
      },
      jobs: {
        leak: job({
          target: "leak",
          env: {
            LEAKED_DESTINATION: env.secret("ASYNC_PIPELINE_REDACT_SECRET")
          }
        })
      }
    });

    const record = await runJob(pipeline, {
      id: "leak",
      workspace: hostWorkspace({
        cwd: dir,
        env: { PATH: process.env.PATH, ASYNC_PIPELINE_REDACT_SECRET: "super-secret-value" }
      })
    });

    assert.equal(record.status, "passed");
    const log = await readFile(join(dir, ".async", "runs", record.id, "logs", "leak.log"), "utf8");
    assert.doesNotMatch(log, /super-secret-value/);
    assert.match(log, /value: \[redacted\]/);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("force re-runs cached tasks and refreshes the cache entry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-force-"));
  try {
    await writeFile(join(dir, "input.txt"), "stable\n", "utf8");
    const pipeline = () => definePipeline({
      name: "force-test",
      cache: "file:local",
      tasks: {
        build: task({
          inputs: ["input.txt"],
          cache: true,
          run: sh`node -e "process.exit(0)"`
        })
      },
      jobs: { build: job({ target: "build" }) }
    });
    const workspace = hostWorkspace({ cwd: dir, env: { PATH: process.env.PATH } });

    const cold = await runJob(pipeline(), { id: "build", workspace });
    assert.equal(cold.tasks[0]?.status, "passed");
    const warm = await runJob(pipeline(), { id: "build", workspace });
    assert.equal(warm.tasks[0]?.status, "cached");
    const forced = await runJob(pipeline(), { id: "build", workspace, force: true });
    assert.equal(forced.tasks[0]?.status, "passed");
    const warmAgain = await runJob(pipeline(), { id: "build", workspace });
    assert.equal(warmAgain.tasks[0]?.status, "cached");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("planJob predicts cache hits without executing tasks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-plan-"));
  try {
    await writeFile(join(dir, "input.txt"), "stable\n", "utf8");
    const pipeline = () => definePipeline({
      name: "plan-test",
      cache: "file:local",
      tasks: {
        build: task({
          inputs: ["input.txt"],
          cache: true,
          run: sh`node -e "process.exit(0)"`
        })
      },
      jobs: { build: job({ target: "build" }) }
    });
    const workspace = hostWorkspace({ cwd: dir, env: { PATH: process.env.PATH } });

    const coldPlan = await planJob(pipeline(), { id: "build", workspace });
    assert.deepEqual(coldPlan.executionOrder, ["build"]);
    assert.equal(coldPlan.entries[0]?.predicted, "run");

    await runJob(pipeline(), { id: "build", workspace });
    const warmPlan = await planJob(pipeline(), { id: "build", workspace });
    assert.equal(warmPlan.entries[0]?.predicted, "cached");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("a throwing deferred step factory fails the task and finalizes the record", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-crash-"));
  try {
    const pipeline = definePipeline({
      name: "crash-test",
      tasks: {
        boom: task({
          cache: false,
          run: sh(() => {
            throw new Error("factory exploded");
          })
        })
      },
      jobs: { boom: job({ target: "boom" }) }
    });

    const record = await runJob(pipeline, {
      id: "boom",
      workspace: hostWorkspace({ cwd: dir, env: { PATH: process.env.PATH } })
    });

    assert.equal(record.status, "failed");
    assert.match(record.tasks[0]?.error ?? "", /factory exploded/);
    const persisted = JSON.parse(await readFile(join(dir, ".async", "runs", record.id, "execution.json"), "utf8"));
    assert.equal(persisted.status, "failed");
    assert.ok(persisted.finishedAt, "record must not be left in running state");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("requireEnvironment command policy denies unless ASYNC_PIPELINE_ENVIRONMENT matches", async () => {
  const proxy = commandProxy({
    rules: [command.rule({ exact: [["deploy"]][0], action: command.requireEnvironment({ name: "prod" }) })],
    record: true
  });

  const denied = await proxy.run(
    { argv: ["deploy"], cwd: process.cwd(), env: {} },
    async () => ({ code: 0, stdout: "ran\n", stderr: "" })
  );
  assert.equal(denied.code, 1);
  assert.match(denied.stderr, /requires environment "prod"/);

  const allowed = await proxy.run(
    { argv: ["deploy"], cwd: process.cwd(), env: { ASYNC_PIPELINE_ENVIRONMENT: "prod" } },
    async () => ({ code: 0, stdout: "ran\n", stderr: "" })
  );
  assert.equal(allowed.code, 0);
  assert.equal(allowed.stdout, "ran\n");
});

test("docker commands forward only allowlisted env keys", async () => {
  const { DockerCommandExecutor } = await import("../packages/pipeline-node/dist/runner.js");
  const executor = new DockerCommandExecutor({
    image: "node:24",
    hostCwd: "/repo",
    workdir: "/workspace",
    volumes: [{ source: "/repo", target: "/workspace" }]
  });
  // TS-private is erased at runtime; reach in to verify the rendered command.
  const rendered = executor["dockerCommand"](
    "echo hi",
    "/repo",
    { HOST_SECRET_TOKEN: "leak-me", ASYNC_PIPELINE_ROOT_DIR: "/repo", CI: "true" },
    ["ASYNC_PIPELINE_ROOT_DIR", "CI", "MISSING_KEY"]
  );
  assert.match(rendered, /-e 'ASYNC_PIPELINE_ROOT_DIR'/);
  assert.match(rendered, /-e 'CI'/);
  assert.doesNotMatch(rendered, /HOST_SECRET_TOKEN/);
  assert.doesNotMatch(rendered, /MISSING_KEY/);
});

test("task logs are capped by ASYNC_PIPELINE_MAX_LOG_BYTES with a truncation marker", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-logcap-"));
  try {
    const pipeline = definePipeline({
      name: "logcap-test",
      tasks: {
        noisy: task({
          cache: false,
          run: sh`node -e "process.stdout.write('x'.repeat(64 * 1024))"`
        })
      },
      jobs: { noisy: job({ target: "noisy" }) }
    });

    const record = await runJob(pipeline, {
      id: "noisy",
      workspace: hostWorkspace({
        cwd: dir,
        env: { PATH: process.env.PATH, ASYNC_PIPELINE_MAX_LOG_BYTES: "4096" }
      })
    });

    assert.equal(record.status, "passed");
    const log = await readFile(join(dir, ".async", "runs", record.id, "logs", "noisy.log"), "utf8");
    assert.ok(log.length < 16 * 1024, `log should be capped, saw ${log.length} chars`);
    assert.match(log, /output truncated: dropped \d+ leading bytes/);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("concurrent runs in the same project fail fast with ASYNC_PIPELINE_RUN_ACTIVE", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-lock-"));
  try {
    const pipeline = definePipeline({
      name: "lock-test",
      tasks: { slow: task({ cache: false, run: sh`sleep 1` }) },
      jobs: { slow: job({ target: "slow" }) }
    });
    const workspace = () => hostWorkspace({ cwd: dir, env: { PATH: process.env.PATH } });

    const first = runJob(pipeline, { id: "slow", workspace: workspace() });
    await delay(300);
    await assert.rejects(
      runJob(pipeline, { id: "slow", workspace: workspace() }),
      /Another async-pipeline run/
    );

    const record = await first;
    assert.equal(record.status, "passed");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("execution records and cache entries carry schemaVersion 1", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-schema-"));
  try {
    const pipeline = definePipeline({
      name: "schema-test",
      cache: "file:local",
      tasks: { emit: task({ cache: true, run: sh`echo emitted` }) },
      jobs: { emit: job({ target: "emit" }) }
    });
    const record = await runJob(pipeline, {
      id: "emit",
      workspace: hostWorkspace({ cwd: dir, env: { PATH: process.env.PATH } })
    });

    assert.equal(record.schemaVersion, 1);
    assert.equal(record.pid, process.pid);

    const stored = JSON.parse(await readFile(join(dir, ".async", "runs", record.id, "execution.json"), "utf8"));
    assert.equal(stored.schemaVersion, 1);

    const cacheKey = record.tasks[0]?.cacheKey;
    assert.ok(cacheKey, "task must record its cache key");
    const cacheEntry = JSON.parse(await readFile(join(dir, ".async", "cache", "tasks", cacheKey, "result.json"), "utf8"));
    assert.equal(cacheEntry.schemaVersion, 1);

    // The lock must be released once the run finishes.
    await assert.rejects(readFile(join(dir, ".async", "run.lock"), "utf8"));
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});
