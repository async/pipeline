import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExecutionRecord } from "@async/pipeline-core";
import { HostCommandExecutor } from "./runner.js";
import { isPidAlive } from "./store.js";

export interface DoctorCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  message: string;
}

export async function runDoctor(cwd: string = process.cwd()): Promise<DoctorCheck[]> {
  const host = new HostCommandExecutor();
  const checks: DoctorCheck[] = [];

  for (const tool of ["node", "pnpm"]) {
    const available = await host.checkTool(tool);
    checks.push({
      name: tool,
      status: available ? "pass" : "fail",
      message: available ? `${tool} is available.` : `${tool} is missing.`
    });
  }

  const limaAvailable = await host.checkTool("limactl");
  checks.push({
    name: "limactl",
    status: limaAvailable ? "pass" : "warn",
    message: limaAvailable ? "Lima is available." : "Lima is not installed; Lima-backed tasks will be unavailable."
  });

  checks.push(await checkRunRecords(cwd));

  return checks;
}

/**
 * Detect crashed runs: record directories without a readable execution.json,
 * or records still `"running"` whose owning process is gone (kill -9, power
 * loss). `async-pipeline gc` prunes them with the normal retention rules.
 */
async function checkRunRecords(cwd: string): Promise<DoctorCheck> {
  const runsDir = join(cwd, ".async", "runs");
  let entries;
  try {
    entries = await readdir(runsDir, { withFileTypes: true });
  } catch {
    return { name: "runs", status: "pass", message: "No local run records." };
  }

  let crashed = 0;
  let staleRunning = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let record: ExecutionRecord;
    try {
      record = JSON.parse(await readFile(join(runsDir, entry.name, "execution.json"), "utf8")) as ExecutionRecord;
    } catch {
      crashed += 1;
      continue;
    }
    if (record.status === "running" && (typeof record.pid !== "number" || !isPidAlive(record.pid))) {
      staleRunning += 1;
    }
  }

  if (crashed === 0 && staleRunning === 0) {
    return { name: "runs", status: "pass", message: "Run records are consistent." };
  }
  const parts: string[] = [];
  if (staleRunning > 0) parts.push(`${staleRunning} record(s) stuck in "running" from a dead process`);
  if (crashed > 0) parts.push(`${crashed} run director${crashed === 1 ? "y" : "ies"} without a readable record`);
  return {
    name: "runs",
    status: "warn",
    message: `Crashed runs detected: ${parts.join("; ")}. Run \`async-pipeline gc\` to prune old records.`
  };
}
