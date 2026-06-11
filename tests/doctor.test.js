import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runDoctor } from "../packages/pipeline-node/dist/doctor.js";

test("doctor flags crashed runs stuck in running state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-doctor-"));
  try {
    // A record still "running" whose owning process is dead (kill -9, crash).
    const staleDir = join(dir, ".async", "runs", "2026-01-01T00-00-00-000Z-dead0000");
    await mkdir(staleDir, { recursive: true });
    await writeFile(join(staleDir, "execution.json"), `${JSON.stringify({
      schemaVersion: 1,
      id: "2026-01-01T00-00-00-000Z-dead0000",
      status: "running",
      pid: 999999999,
      tasks: []
    })}\n`, "utf8");

    // A run directory with no readable record at all.
    await mkdir(join(dir, ".async", "runs", "2026-01-01T00-00-01-000Z-dead0001"), { recursive: true });

    const checks = await runDoctor(dir);
    const runs = checks.find((check) => check.name === "runs");
    assert.equal(runs?.status, "warn");
    assert.match(runs?.message ?? "", /stuck in "running"/);
    assert.match(runs?.message ?? "", /without a readable record/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("doctor passes on consistent or absent run records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-doctor-clean-"));
  try {
    let checks = await runDoctor(dir);
    assert.equal(checks.find((check) => check.name === "runs")?.status, "pass");

    const runDir = join(dir, ".async", "runs", "2026-01-01T00-00-00-000Z-aaaa0000");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "execution.json"), `${JSON.stringify({
      schemaVersion: 1,
      id: "2026-01-01T00-00-00-000Z-aaaa0000",
      status: "passed",
      pid: 12345,
      tasks: []
    })}\n`, "utf8");

    // A live "running" record (this test process) is not a crash.
    const liveDir = join(dir, ".async", "runs", "2026-01-01T00-00-01-000Z-bbbb0000");
    await mkdir(liveDir, { recursive: true });
    await writeFile(join(liveDir, "execution.json"), `${JSON.stringify({
      schemaVersion: 1,
      id: "2026-01-01T00-00-01-000Z-bbbb0000",
      status: "running",
      pid: process.pid,
      tasks: []
    })}\n`, "utf8");

    checks = await runDoctor(dir);
    assert.equal(checks.find((check) => check.name === "runs")?.status, "pass");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
