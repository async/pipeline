import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { definePipeline, env, job, sh, task } from "../packages/pipeline-core/dist/index.js";
import { runJob, runSingleTask } from "../packages/pipeline-node/dist/runner.js";

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

    const record = await runSingleTask(pipeline, "slow", { cwd: dir });

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
            NODE_AUTH_TOKEN: env.secret("ASYNC_PIPELINE_TEST_SECRET")
          }
        })
      }
    });

    const previous = process.env.ASYNC_PIPELINE_TEST_SECRET;
    delete process.env.ASYNC_PIPELINE_TEST_SECRET;
    try {
      const record = await runJob(pipeline, { cwd: dir, jobId: "publish" });

      assert.equal(record.status, "failed");
      assert.equal(record.tasks[0]?.status, "failed");
      assert.match(record.tasks[0]?.error ?? "", /Required secret "ASYNC_PIPELINE_TEST_SECRET" for env "NODE_AUTH_TOKEN"/);
      assert.doesNotMatch(record.tasks[0]?.error ?? "", /exit code 2/);
    } finally {
      if (previous === undefined) delete process.env.ASYNC_PIPELINE_TEST_SECRET;
      else process.env.ASYNC_PIPELINE_TEST_SECRET = previous;
    }
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("pipeline and job env resolve into function task context", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-env-context-"));
  try {
    const previousNodeEnv = process.env.ASYNC_PIPELINE_ENV_TEST_NODE_ENV;
    delete process.env.ASYNC_PIPELINE_ENV_TEST_NODE_ENV;
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

      const record = await runJob(pipeline, { cwd: dir, jobId: "check" });

      assert.equal(record.status, "passed");
    } finally {
      if (previousNodeEnv === undefined) delete process.env.ASYNC_PIPELINE_ENV_TEST_NODE_ENV;
      else process.env.ASYNC_PIPELINE_ENV_TEST_NODE_ENV = previousNodeEnv;
    }
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("env secrets can resolve from rendered destination env", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-secret-destination-"));
  try {
    const previousSource = process.env.ASYNC_PIPELINE_TEST_SECRET_SOURCE;
    const previousDestination = process.env.NODE_AUTH_TOKEN;
    delete process.env.ASYNC_PIPELINE_TEST_SECRET_SOURCE;
    process.env.NODE_AUTH_TOKEN = "rendered-secret";
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

      const record = await runJob(pipeline, { cwd: dir, jobId: "check" });

      assert.equal(record.status, "passed");
    } finally {
      if (previousSource === undefined) delete process.env.ASYNC_PIPELINE_TEST_SECRET_SOURCE;
      else process.env.ASYNC_PIPELINE_TEST_SECRET_SOURCE = previousSource;
      if (previousDestination === undefined) delete process.env.NODE_AUTH_TOKEN;
      else process.env.NODE_AUTH_TOKEN = previousDestination;
    }
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("mapped env vars fail before execution when unmapped", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-env-unmapped-"));
  try {
    const previousNodeEnv = process.env.ASYNC_PIPELINE_ENV_TEST_NODE_ENV;
    process.env.ASYNC_PIPELINE_ENV_TEST_NODE_ENV = "stage";
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

      const record = await runJob(pipeline, { cwd: dir, jobId: "check" });

      assert.equal(record.status, "failed");
      assert.match(record.tasks[0]?.error ?? "", /value "stage" is not mapped/);
      assert.doesNotMatch(record.tasks[0]?.error ?? "", /exit code 2/);
    } finally {
      if (previousNodeEnv === undefined) delete process.env.ASYNC_PIPELINE_ENV_TEST_NODE_ENV;
      else process.env.ASYNC_PIPELINE_ENV_TEST_NODE_ENV = previousNodeEnv;
    }
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});
