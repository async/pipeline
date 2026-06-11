import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { command, definePipeline, env, job, sh, task } from "../packages/pipeline-core/dist/index.js";
import { commandProxy, hostWorkspace, runJob, runSingleTask } from "../packages/pipeline-node/dist/runner.js";

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
