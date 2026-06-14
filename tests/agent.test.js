import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { agent, definePipeline, env, job, sh, task } from "../packages/pipeline-core/dist/index.js";
import { runDoctor } from "../packages/pipeline-node/dist/doctor.js";
import { runJob } from "../packages/pipeline-node/dist/runner.js";

const MOCK_AGENT = `import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const prompt = readFileSync(0, "utf8");
appendFileSync(process.env.MARKER_FILE, \`invoked:\${process.env.ASYNC_PIPELINE_AGENT_PROFILE}:\${process.env.ASYNC_PIPELINE_AGENT_MODEL}\\n\`);
writeFileSync("out.txt", \`agent:\${process.env.ASYNC_PIPELINE_AGENT_MODEL}:\${prompt.trim()}\`);
console.log(\`adapter done secret=\${process.env.AGENT_SECRET ?? "none"}\`);
`;

async function scratchDir(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

function agentPipeline(dir, options = {}) {
  return definePipeline({
    name: "agent-test",
    cache: "file:local",
    env: {
      MARKER_FILE: join(dir, "marker.log"),
      ...(options.env ?? {})
    },
    agents: options.agents ?? {
      mock: { command: ["node", join(dir, "mock-agent.mjs")], model: options.model ?? "mock-1" }
    },
    tasks: {
      gen: task({
        inputs: ["seed.txt"],
        outputs: ["out.txt"],
        cache: true,
        run: agent({ use: options.use ?? "mock", prompt: options.prompt ?? "write the file" })
      })
    },
    jobs: {
      generate: job({ target: "gen" })
    }
  });
}

async function seedScratch(dir) {
  await writeFile(join(dir, "mock-agent.mjs"), MOCK_AGENT);
  await writeFile(join(dir, "seed.txt"), "seed-1\n");
  await writeFile(join(dir, "marker.log"), "");
}

async function markerLines(dir) {
  const marker = await readFile(join(dir, "marker.log"), "utf8");
  return marker.split("\n").filter((line) => line.length > 0);
}

test("PROMISE: an agent step runs the selected profile and records a redacted transcript under the run's agents directory", async () => {
  const dir = await scratchDir("async-pipeline-agent-run-");
  try {
    await seedScratch(dir);
    const secret = "swordfish-topsecret-value-123";
    const pipeline = agentPipeline(dir, {
      env: { AGENT_SECRET: env.secret("ASYNC_PIPELINE_TEST_AGENT_SECRET") }
    });

    const record = await runJob(pipeline, {
      id: "generate",
      cwd: dir,
      env: { PATH: process.env.PATH, ASYNC_PIPELINE_TEST_AGENT_SECRET: secret }
    });

    assert.equal(record.status, "passed");
    assert.equal(record.tasks[0]?.status, "passed");

    const output = await readFile(join(dir, "out.txt"), "utf8");
    assert.equal(output, "agent:mock-1:write the file");

    const agentsDir = join(dir, ".async", "runs", record.id, "agents");
    const artifacts = (await readdir(agentsDir)).sort();
    assert.deepEqual(artifacts, ["gen.jsonl", "gen.prompt.txt"]);

    assert.equal(await readFile(join(agentsDir, "gen.prompt.txt"), "utf8"), "write the file");

    const transcriptLines = (await readFile(join(agentsDir, "gen.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(transcriptLines.length, 2);
    assert.equal(transcriptLines[0].type, "request");
    assert.equal(transcriptLines[0].profile, "mock");
    assert.equal(transcriptLines[0].model, "mock-1");
    assert.equal(transcriptLines[0].prompt, "write the file");
    assert.equal(transcriptLines[1].type, "response");
    assert.equal(transcriptLines[1].code, 0);
    assert.match(transcriptLines[1].stdout, /adapter done/);
    assert.doesNotMatch(transcriptLines[1].stdout, /swordfish-topsecret-value-123/);
    assert.match(transcriptLines[1].stdout, /\[redacted\]/);

    const taskLog = await readFile(join(dir, ".async", "runs", record.id, "logs", "gen.log"), "utf8");
    assert.doesNotMatch(taskLog, /swordfish-topsecret-value-123/);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("PROMISE: a cached agent task replays declared outputs without re-invoking the adapter", async () => {
  const dir = await scratchDir("async-pipeline-agent-cache-");
  try {
    await seedScratch(dir);
    const first = await runJob(agentPipeline(dir), { id: "generate", cwd: dir, env: { PATH: process.env.PATH } });
    assert.equal(first.tasks[0]?.status, "passed");
    assert.equal((await markerLines(dir)).length, 1);

    // Deleting the output forces the hit to actually restore it.
    await rm(join(dir, "out.txt"));

    const second = await runJob(agentPipeline(dir), { id: "generate", cwd: dir, env: { PATH: process.env.PATH } });
    assert.equal(second.tasks[0]?.status, "cached");
    assert.equal((await markerLines(dir)).length, 1, "adapter must not run on a cache hit");
    assert.equal(await readFile(join(dir, "out.txt"), "utf8"), "agent:mock-1:write the file");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("PROMISE: agent tasks do not inherit broad cache defaults", async () => {
  const dir = await scratchDir("async-pipeline-agent-cache-default-");
  try {
    await seedScratch(dir);
    const pipeline = () => definePipeline({
      name: "agent-test",
      cache: "file:local",
      taskDefaults: {
        gen: { cache: true }
      },
      env: { MARKER_FILE: join(dir, "marker.log") },
      agents: { mock: { command: ["node", join(dir, "mock-agent.mjs")], model: "mock-1" } },
      tasks: {
        gen: task({
          inputs: ["seed.txt"],
          outputs: ["out.txt"],
          run: agent({ use: "mock", prompt: "write the file" })
        })
      },
      jobs: { generate: job({ target: "gen" }) }
    });

    const first = await runJob(pipeline(), { id: "generate", cwd: dir, env: { PATH: process.env.PATH } });
    assert.equal(first.tasks[0]?.status, "passed");
    assert.equal(first.tasks[0]?.cacheHit, false);
    assert.equal((await markerLines(dir)).length, 1);

    const second = await runJob(pipeline(), { id: "generate", cwd: dir, env: { PATH: process.env.PATH } });
    assert.equal(second.tasks[0]?.status, "passed");
    assert.equal(second.tasks[0]?.cacheHit, false);
    assert.equal((await markerLines(dir)).length, 2, "broad taskDefaults.cache must not cache agent output");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("PROMISE: agent cache keys ignore the adapter binary path and change with model or prompt", async () => {
  const dir = await scratchDir("async-pipeline-agent-key-");
  try {
    await seedScratch(dir);
    await mkdir(join(dir, "elsewhere"), { recursive: true });
    await cp(join(dir, "mock-agent.mjs"), join(dir, "elsewhere", "mock-agent.mjs"));

    const atPathA = () => definePipeline({
      name: "agent-test",
      cache: "file:local",
      env: { MARKER_FILE: join(dir, "marker.log") },
      agents: { mock: { command: ["node", join(dir, "mock-agent.mjs")], model: "mock-1" } },
      tasks: { gen: task({ inputs: ["seed.txt"], outputs: ["out.txt"], cache: true, run: agent({ use: "mock", prompt: "write the file" }) }) },
      jobs: { generate: job({ target: "gen" }) }
    });
    const atPathB = () => definePipeline({
      name: "agent-test",
      cache: "file:local",
      env: { MARKER_FILE: join(dir, "marker.log") },
      agents: { mock: { command: ["node", join(dir, "elsewhere", "mock-agent.mjs")], model: "mock-1" } },
      tasks: { gen: task({ inputs: ["seed.txt"], outputs: ["out.txt"], cache: true, run: agent({ use: "mock", prompt: "write the file" }) }) },
      jobs: { generate: job({ target: "gen" }) }
    });

    const first = await runJob(atPathA(), { id: "generate", cwd: dir, env: { PATH: process.env.PATH } });
    assert.equal(first.tasks[0]?.status, "passed");

    // Same profile id, model, and prompt from a different binary path: cached.
    const moved = await runJob(atPathB(), { id: "generate", cwd: dir, env: { PATH: process.env.PATH } });
    assert.equal(moved.tasks[0]?.status, "cached", "binary location must not dirty the agent cache");
    assert.equal(first.tasks[0]?.cacheKey, moved.tasks[0]?.cacheKey);

    // A different model is a different artifact: re-run.
    const newModel = await runJob(agentPipeline(dir, { model: "mock-2" }), { id: "generate", cwd: dir, env: { PATH: process.env.PATH } });
    assert.equal(newModel.tasks[0]?.status, "passed");
    assert.notEqual(newModel.tasks[0]?.cacheKey, first.tasks[0]?.cacheKey);

    // A different prompt is a different artifact: re-run.
    const newPrompt = await runJob(agentPipeline(dir, { prompt: "write the file differently" }), { id: "generate", cwd: dir, env: { PATH: process.env.PATH } });
    assert.equal(newPrompt.tasks[0]?.status, "passed");
    assert.notEqual(newPrompt.tasks[0]?.cacheKey, first.tasks[0]?.cacheKey);
    assert.notEqual(newPrompt.tasks[0]?.cacheKey, newModel.tasks[0]?.cacheKey);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("PROMISE: env.var(...) selects the agent profile and model at run time", async () => {
  const dir = await scratchDir("async-pipeline-agent-env-");
  try {
    await seedScratch(dir);
    const pipeline = () => agentPipeline(dir, {
      agents: {
        primary: { command: ["node", join(dir, "mock-agent.mjs")], model: env.var("ASYNC_PIPELINE_TEST_AGENT_MODEL", { default: "model-a" }) },
        fallback: { command: ["node", join(dir, "mock-agent.mjs")], model: "model-b" }
      },
      use: env.var("ASYNC_PIPELINE_TEST_AGENT", { default: "primary" })
    });

    const defaulted = await runJob(pipeline(), { id: "generate", cwd: dir, env: { PATH: process.env.PATH } });
    assert.equal(defaulted.tasks[0]?.status, "passed");
    assert.deepEqual(await markerLines(dir), ["invoked:primary:model-a"]);

    const selected = await runJob(pipeline(), {
      id: "generate",
      cwd: dir,
      env: { PATH: process.env.PATH, ASYNC_PIPELINE_TEST_AGENT: "fallback" }
    });
    assert.equal(selected.tasks[0]?.status, "passed", "a different resolved profile must miss the cache and run");
    assert.deepEqual(await markerLines(dir), ["invoked:primary:model-a", "invoked:fallback:model-b"]);
    assert.notEqual(selected.tasks[0]?.cacheKey, defaulted.tasks[0]?.cacheKey);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("PROMISE: agent stdoutTo lands the adapter's stdout as a task artifact and caches it like any output", async () => {
  const dir = await scratchDir("async-pipeline-agent-stdout-");
  try {
    await seedScratch(dir);
    const pipeline = () => definePipeline({
      name: "agent-test",
      cache: "file:local",
      env: { MARKER_FILE: join(dir, "marker.log") },
      agents: { mock: { command: ["node", join(dir, "mock-agent.mjs")], model: "mock-1" } },
      tasks: {
        draft: task({
          inputs: ["seed.txt"],
          outputs: ["out.txt", "draft.txt"],
          cache: true,
          run: agent({ use: "mock", prompt: "write the file", stdoutTo: "draft.txt" })
        })
      },
      jobs: { generate: job({ target: "draft" }) }
    });

    const first = await runJob(pipeline(), { id: "generate", cwd: dir, env: { PATH: process.env.PATH } });
    assert.equal(first.tasks[0]?.status, "passed");
    const draft = await readFile(join(dir, "draft.txt"), "utf8");
    assert.match(draft, /adapter done/);

    // Declared as an output, the artifact replays from cache without the adapter.
    await rm(join(dir, "draft.txt"));
    const second = await runJob(pipeline(), { id: "generate", cwd: dir, env: { PATH: process.env.PATH } });
    assert.equal(second.tasks[0]?.status, "cached");
    assert.equal((await markerLines(dir)).length, 1, "adapter must not run on a cache hit");
    assert.equal(await readFile(join(dir, "draft.txt"), "utf8"), draft);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("PROMISE: doctor warns when an agent task declares no outputs", async () => {
  const withOutputs = definePipeline({
    name: "p",
    agents: { mock: { command: ["node", "x.mjs"], model: "m" } },
    tasks: { gen: task({ outputs: ["out.txt"], run: agent({ use: "mock", prompt: "p" }) }) },
    jobs: { g: job({ target: "gen" }) }
  });
  const withoutOutputs = definePipeline({
    name: "p",
    agents: { mock: { command: ["node", "x.mjs"], model: "m" } },
    tasks: { gen: task({ run: agent({ use: "mock", prompt: "p" }) }) },
    jobs: { g: job({ target: "gen" }) }
  });
  const noAgents = definePipeline({
    name: "p",
    tasks: { build: task({ run: sh`true` }) },
    jobs: { g: job({ target: "build" }) }
  });

  const dir = await scratchDir("async-pipeline-agent-doctor-");
  try {
    const pass = (await runDoctor(dir, withOutputs)).find((check) => check.name === "agent-outputs");
    assert.equal(pass?.status, "pass");

    const warn = (await runDoctor(dir, withoutOutputs)).find((check) => check.name === "agent-outputs");
    assert.equal(warn?.status, "warn");
    assert.match(warn?.message ?? "", /gen/);
    assert.match(warn?.message ?? "", /stdoutTo/);

    const absent = (await runDoctor(dir, noAgents)).find((check) => check.name === "agent-outputs");
    assert.equal(absent, undefined);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("agent config rejects unknown fields, missing models, and unknown profiles", async () => {
  assert.throws(
    () => agent({ use: "mock", prompt: "p", timout: 5 }),
    (error) => error.code === "ASYNC_PIPELINE_UNKNOWN_FIELD" && /timout/.test(error.message)
  );

  assert.throws(
    () => agent({ use: "mock", prompt: "" }),
    (error) => error.code === "ASYNC_PIPELINE_AGENT_INVALID"
  );

  assert.throws(
    () => agent({ use: "mock", prompt: "p", stdoutTo: "/etc/evil" }),
    (error) => error.code === "ASYNC_PIPELINE_AGENT_INVALID" && /relative/.test(error.message)
  );

  assert.throws(
    () => agent({ use: "mock", prompt: "p", stdoutTo: "../outside.txt" }),
    (error) => error.code === "ASYNC_PIPELINE_AGENT_INVALID" && /relative/.test(error.message)
  );

  assert.throws(
    () => definePipeline({
      name: "p",
      agents: { mock: { command: ["node", "x.mjs"], model: "m", temperture: 1 } },
      tasks: {},
      jobs: {}
    }),
    (error) => error.code === "ASYNC_PIPELINE_UNKNOWN_FIELD" && /temperture/.test(error.message)
  );

  assert.throws(
    () => definePipeline({
      name: "p",
      agents: { mock: { command: ["node", "x.mjs"] } },
      tasks: {},
      jobs: {}
    }),
    (error) => error.code === "ASYNC_PIPELINE_AGENT_INVALID" && /model/.test(error.message)
  );

  assert.throws(
    () => definePipeline({
      name: "p",
      agents: { mock: { command: [], model: "m" } },
      tasks: {},
      jobs: {}
    }),
    (error) => error.code === "ASYNC_PIPELINE_AGENT_INVALID" && /command/.test(error.message)
  );

  assert.throws(
    () => definePipeline({
      name: "p",
      tasks: { gen: task({ run: agent({ use: "ghost", prompt: "p" }) }) },
      jobs: { generate: job({ target: "gen" }) }
    }),
    (error) => error.code === "ASYNC_PIPELINE_AGENT_UNKNOWN" && /ghost/.test(error.message)
  );
});

test("an env-selected profile that resolves to an undeclared id fails the task with the unknown-profile error", async () => {
  const dir = await scratchDir("async-pipeline-agent-unknown-");
  try {
    await seedScratch(dir);
    const pipeline = agentPipeline(dir, { use: env.var("ASYNC_PIPELINE_TEST_AGENT", { default: "mock" }) });
    const record = await runJob(pipeline, {
      id: "generate",
      cwd: dir,
      env: { PATH: process.env.PATH, ASYNC_PIPELINE_TEST_AGENT: "ghost" }
    });
    assert.equal(record.status, "failed");
    assert.match(record.tasks[0]?.error ?? "", /agent profile "ghost"/);
    assert.match(record.tasks[0]?.error ?? "", /Known profiles: mock/);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("agent steps compose with shell steps in one task", async () => {
  const dir = await scratchDir("async-pipeline-agent-mixed-");
  try {
    await seedScratch(dir);
    const pipeline = definePipeline({
      name: "agent-test",
      cache: "file:local",
      env: { MARKER_FILE: join(dir, "marker.log") },
      agents: { mock: { command: ["node", join(dir, "mock-agent.mjs")], model: "mock-1" } },
      tasks: {
        gen: task({
          inputs: ["seed.txt"],
          outputs: ["out.txt", "copy.txt"],
          cache: true,
          run: [
            agent({ use: "mock", prompt: "write the file" }),
            sh`cp out.txt copy.txt`
          ]
        })
      },
      jobs: { generate: job({ target: "gen" }) }
    });
    const record = await runJob(pipeline, { id: "generate", cwd: dir, env: { PATH: process.env.PATH } });
    assert.equal(record.tasks[0]?.status, "passed");
    assert.equal(await readFile(join(dir, "copy.txt"), "utf8"), "agent:mock-1:write the file");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});
