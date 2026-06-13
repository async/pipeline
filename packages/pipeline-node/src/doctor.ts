import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExecutionRecord, NormalizedPipeline } from "@async/pipeline-core";
import { isAgentStep } from "@async/pipeline-core";
import { HostCommandExecutor } from "./runner.js";
import { isPidAlive } from "./store.js";

export interface DoctorCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  message: string;
}

export async function runDoctor(cwd: string = process.cwd(), pipeline?: NormalizedPipeline): Promise<DoctorCheck[]> {
  const host = new HostCommandExecutor();
  const checks: DoctorCheck[] = [];

  if (pipeline) {
    const agentOutputsCheck = checkAgentTaskOutputs(pipeline);
    if (agentOutputsCheck) checks.push(agentOutputsCheck);
  }

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
 * ADR-0001 decision 5: an agent task without declared outputs is
 * unverifiable side effects — nothing for the cache to restore and nothing
 * for a verifier task to check. A warning, not an error: some agent tasks
 * legitimately emit only to the transcript.
 */
function checkAgentTaskOutputs(pipeline: NormalizedPipeline): DoctorCheck | null {
  const agentTasks = Object.values(pipeline.tasks).filter((taskDefinition) => taskDefinition.steps.some((step) => isAgentStep(step)));
  if (agentTasks.length === 0) return null;
  const missingOutputs = agentTasks.filter((taskDefinition) => taskDefinition.outputs.length === 0).map((taskDefinition) => taskDefinition.id);
  if (missingOutputs.length === 0) {
    return { name: "agent-outputs", status: "pass", message: `All ${agentTasks.length} agent task(s) declare outputs.` };
  }
  return {
    name: "agent-outputs",
    status: "warn",
    message: `Agent task(s) without declared outputs: ${missingOutputs.join(", ")}. Declare what each produces (or use agent({ stdoutTo })) so the cache can restore it and a verifier task can check it.`
  };
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
