#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs";
import { readFile, readdir, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildGraph, composePipelines, tasksForJob, type NormalizedPipeline } from "@async/pipeline-core";
import { runDoctor } from "./doctor.js";
import { checkGitHubWorkflow, jobsForGitHubEvent, readGitHubEventContext, renderGitHubWorkflow, writeGitHubWorkflow } from "./github.js";
import { loadPipeline } from "./loader.js";
import { beginShutdown, commandProxy, planJob, runJob, runSingleTask, shutdownExitCode, type CommandResult, type PipelineCommands } from "./runner.js";
import { runMcpServer } from "./mcp.js";
import { computeTaskInputManifest, createStore, diffInputManifests, pruneCacheEntries, readCacheInputManifest, readContextPacks, readTaskBaseline } from "./store.js";
import { matrixForJob, readPipelineMetadata, resolveSources, sourceContext } from "./sources.js";
import { checkTaskSync, describeTaskSync, renderTaskSync, writeTaskSync } from "./sync.js";

export interface PipelineCliOptions {
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  commands?: PipelineCommands;
  program?: string;
  stdout?(text: string): void;
  stderr?(text: string): void;
}

interface PipelineCliContext {
  concurrency?: number;
  force: boolean;
  dryRun: boolean;
  cwd: string;
  configPath: string;
  pipeline: NormalizedPipeline;
  env: NodeJS.ProcessEnv;
  commands?: PipelineCommands;
  sandboxId?: string;
  stdout(text: string): void;
  stderr(text: string): void;
}

interface ParsedGlobalOptions {
  args: string[];
  concurrency?: number;
  force: boolean;
  dryRun: boolean;
  sandboxId?: string;
}

export async function runPipelineCli(options: PipelineCliOptions): Promise<CommandResult> {
  const sinkStdout = options.stdout ?? ((text: string): void => { process.stdout.write(text); });
  const sinkStderr = options.stderr ?? ((text: string): void => { process.stderr.write(text); });
  let streamedStdout = 0;
  let streamedStderr = 0;

  const result = await runPipelineCliBuffered({
    args: options.args,
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    commands: options.commands,
    program: options.program,
    onStdout(text) {
      streamedStdout += text.length;
      sinkStdout(text);
    },
    onStderr(text) {
      streamedStderr += text.length;
      sinkStderr(text);
    },
    applyCommandPolicy: true
  });

  // Streamed text is always a prefix of the final result text; replaced output
  // (command policy deny/mock, or errors) was never streamed, so flush the rest.
  if (result.stdout.length > streamedStdout) sinkStdout(result.stdout.slice(streamedStdout));
  if (result.stderr.length > streamedStderr) sinkStderr(result.stderr.slice(streamedStderr));
  return result;
}

interface PipelineCliStreamOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  commands?: PipelineCommands;
  applyCommandPolicy: boolean;
  onStdout?(text: string): void;
  onStderr?(text: string): void;
}

async function runPipelineCliBuffered(options: Omit<PipelineCliOptions, "stdout" | "stderr"> & PipelineCliStreamOptions): Promise<CommandResult> {
  try {
    const parsed = parseGlobalOptions(options.args);
    const [commandName, ...args] = parsed.args;
    const program = options.program ?? programName();
    const cwd = options.cwd;
    const configPath = findPipelineConfig(cwd);
    let stdout = "";
    let stderr = "";
    const out = (text: string): void => {
      stdout += text;
      options.onStdout?.(text);
    };
    const err = (text: string): void => {
      stderr += text;
      options.onStderr?.(text);
    };

    if (commandName === "doctor") {
      // Best-effort pipeline load: doctor must still work in projects where
      // the config is missing or broken — pipeline-aware checks just skip.
      const doctorPipeline = configPath ? await loadPipeline(configPath).catch(() => undefined) : undefined;
      const checks = await runDoctor(cwd, doctorPipeline);
      for (const check of checks) out(`${check.status.toUpperCase()} ${check.name}: ${check.message}\n`);
      return { code: checks.some((check) => check.status === "fail") ? 1 : 0, stdout, stderr };
    }

    if (!commandName || commandName === "help" || commandName === "--help") {
      out(printHelp(program));
      return { code: 0, stdout, stderr };
    }

    if (!configPath) {
      throw new Error(`No pipeline.ts, pipeline.mjs, or pipeline.js found in ${cwd}.`);
    }

    const pipeline = await loadPipeline(configPath);
    const configDir = dirname(configPath);
    // Validate the sandbox id before the command policy can mock the
    // invocation, so typos fail loudly even under mocked CLI commands.
    if (parsed.sandboxId && parsed.sandboxId !== "host" && !pipeline.sandboxes[parsed.sandboxId]) {
      throw new Error(`Unknown sandbox "${parsed.sandboxId}". Declare it under \`sandboxes\` in the pipeline config.`);
    }
    const commands = options.commands ?? (pipeline.commands ? commandProxy(pipeline.commands) : undefined);

    if (options.applyCommandPolicy && commands) {
      return commands.run({
        argv: ["async-pipeline", ...options.args],
        cwd: configDir,
        env: options.env
      }, () => runPipelineCliBuffered({
        ...options,
        args: options.args,
        cwd: configDir,
        commands,
        applyCommandPolicy: false
      }));
    }

    const context: PipelineCliContext = {
      concurrency: parsed.concurrency,
      force: parsed.force,
      dryRun: parsed.dryRun,
      cwd: configDir,
      configPath,
      pipeline,
      env: options.env,
      commands,
      sandboxId: parsed.sandboxId,
      stdout: out,
      stderr: err
    };

    const code = await dispatchCommand(commandName, args, context, program);
    return { code, stdout, stderr };
  } catch (error) {
    const message = `${error instanceof Error ? error.message : String(error)}\n`;
    return { code: 1, stdout: "", stderr: message };
  }
}

async function dispatchCommand(commandName: string, args: string[], context: PipelineCliContext, program: string): Promise<number> {
  if (commandName === "sync") {
    return handleSyncCommand(args, context);
  }

  if (commandName === "github") {
    const subcommand = args[0] ?? "help";
    const paths = githubGenerationPaths(args.slice(1));
    const rendered = await renderGitHubWorkflow(context.pipeline, { cwd: context.cwd, configPath: context.configPath, ...paths });
    if (subcommand === "generate") {
      await writeGitHubWorkflow(rendered, context.cwd);
      context.stdout(`Generated ${rendered.workflowPath}\n`);
      context.stdout(`Generated ${rendered.lockPath}\n`);
      return 0;
    }
    if (subcommand === "check") {
      const issues = await checkGitHubWorkflow(rendered, context.cwd);
      if (issues.length > 0) {
        for (const issue of issues) context.stderr(`${issue}\n`);
        return 1;
      }
      context.stdout("GitHub workflow is current.\n");
      return 0;
    }
    if (subcommand === "run") {
      const explicitJobs = collectFlagValues(args.slice(1), "--job");
      const eventContext = await readGitHubEventContext(context.env);
      const jobs = explicitJobs.length > 0
        ? explicitJobs.map((jobId) => {
            const selected = context.pipeline.jobs[jobId];
            if (!selected) throw new Error(`Unknown job "${jobId}".`);
            return selected;
          })
        : jobsForGitHubEvent(context.pipeline, eventContext);
      if (jobs.length === 0) {
        context.stdout(`No pipeline jobs matched GitHub event "${eventContext.eventName}". Jobs without a manual trigger need an explicit --job <id> on workflow_dispatch.\n`);
        return 0;
      }
      let failed = false;
      for (const selectedJob of jobs) {
        const graph = tasksForJob(context.pipeline, selectedJob.id);
        context.stdout(`Running ${context.pipeline.name}:${selectedJob.id} (${graph.executionOrder.join(" -> ")})\n`);
        const result = await runJob(context.pipeline, { id: selectedJob.id, mode: "ci", cwd: context.cwd, env: context.env, commands: context.commands, sandbox: context.sandboxId, concurrency: context.concurrency });
        reportFailedTasks(context, result.tasks);
        context.stdout(`Pipeline ${result.status}: ${result.id}\n`);
        if (result.status !== "passed") failed = true;
      }
      return failed ? 1 : 0;
    }
    throw new Error(`Unknown github command "${subcommand}".`);
  }

  if (commandName === "list") {
    context.stdout("Jobs:\n");
    for (const jobId of Object.keys(context.pipeline.jobs).sort()) context.stdout(`  ${jobId}\n`);
    context.stdout("Tasks:\n");
    for (const taskId of Object.keys(context.pipeline.tasks).sort()) context.stdout(`  ${taskId}\n`);
    if (Object.keys(context.pipeline.sources).length > 0) {
      context.stdout("Sources:\n");
      for (const sourceId of Object.keys(context.pipeline.sources).sort()) context.stdout(`  ${sourceId}\n`);
    }
    return 0;
  }

  if (commandName === "graph") {
    const formatIndex = args.indexOf("--format");
    const format = formatIndex >= 0 ? args[formatIndex + 1] : "json";
    const store = virtualStore(context.cwd);
    const graphPipeline = await loadAvailableSourceGraph(context.pipeline, context.cwd, store);
    const graph = buildGraph(graphPipeline);
    if (format === "json") {
      context.stdout(`${JSON.stringify(graph, null, 2)}\n`);
      return 0;
    }
    if (format === "dot") {
      context.stdout("digraph pipeline {\n");
      for (const task of graph.tasks) {
        if (task.dependsOn.length === 0) context.stdout(`  "${task.id}";\n`);
        for (const dependency of task.dependsOn) context.stdout(`  "${dependency}" -> "${task.id}";\n`);
      }
      context.stdout("}\n");
      return 0;
    }
    throw new Error(`Unsupported graph format "${format}".`);
  }

  if (commandName === "explain") {
    const store = virtualStore(context.cwd);
    const formatIndex = args.indexOf("--format");
    const explainFormat = formatIndex >= 0 ? args[formatIndex + 1] : "text";
    if (explainFormat !== "text" && explainFormat !== "json") throw new Error(`Unsupported explain format "${explainFormat}".`);

    const runIndex = args.indexOf("--run");
    if (runIndex >= 0) {
      const runId = args[runIndex + 1];
      if (!runId || runId.startsWith("--")) throw new Error(`Usage: ${program} explain --run <run-id> [--format json]`);
      const packs = await readContextPacks(store, runId);
      if (explainFormat === "json") {
        context.stdout(`${JSON.stringify(packs, null, 2)}\n`);
        return 0;
      }
      if (packs.length === 0) {
        context.stdout(`No context packs recorded for run ${runId}.\n`);
        return 0;
      }
      for (const pack of packs) {
        context.stdout(`Task ${pack.task} failed after ${pack.attempts} attempt${pack.attempts === 1 ? "" : "s"}: ${pack.error}\n`);
        if ("baselineMissing" in pack.inputDiff) {
          context.stdout("  inputs: no passing baseline recorded\n");
        } else {
          const diff = pack.inputDiff;
          context.stdout(`  inputs vs last pass: ${diff.changed.length} changed, ${diff.added.length} added, ${diff.removed.length} removed\n`);
          for (const path of diff.changed) context.stdout(`    ~ ${path}\n`);
          for (const path of diff.added) context.stdout(`    + ${path}\n`);
          for (const path of diff.removed) context.stdout(`    - ${path}\n`);
        }
        if (pack.claims?.length) context.stdout(`  claims touched: ${pack.claims.join(", ")}\n`);
        context.stdout(`  reproduce: ${pack.reproduce}\n`);
      }
      return 0;
    }

    const taskId = args[0];
    if (!taskId || taskId.startsWith("--")) throw new Error(`Usage: ${program} explain <task> [--diff-inputs] | explain --run <run-id>`);
    const explainPipeline = await loadAvailableSourceGraph(context.pipeline, context.cwd, store);
    const task = explainPipeline.tasks[taskId];
    if (!task) throw new Error(`Unknown task "${taskId}".`);

    if (args.includes("--diff-inputs")) {
      const baseline = await readTaskBaseline(store, taskId);
      const baselineManifest = baseline ? await readCacheInputManifest(store, baseline.cacheKey) : null;
      const current = await computeTaskInputManifest(explainPipeline, task, context.cwd);
      if (!baseline || !baselineManifest) {
        if (explainFormat === "json") {
          context.stdout(`${JSON.stringify({ task: taskId, baselineMissing: true, current }, null, 2)}\n`);
        } else {
          context.stdout(`No passing baseline recorded for task "${taskId}" (${Object.keys(current.files).length} current input file(s)). Run the task to record one.\n`);
        }
        return 0;
      }
      const diff = diffInputManifests(baselineManifest, current);
      if (explainFormat === "json") {
        context.stdout(`${JSON.stringify({ task: taskId, baselineCacheKey: baseline.cacheKey, baselineRecordedAt: baseline.recordedAt, ...diff }, null, 2)}\n`);
        return 0;
      }
      const total = diff.changed.length + diff.added.length + diff.removed.length;
      context.stdout(`Inputs for "${taskId}" vs last passing entry (recorded ${baseline.recordedAt}):\n`);
      if (total === 0) {
        context.stdout("  unchanged\n");
        return 0;
      }
      for (const path of diff.changed) context.stdout(`  ~ ${path}\n`);
      for (const path of diff.added) context.stdout(`  + ${path}\n`);
      for (const path of diff.removed) context.stdout(`  - ${path}\n`);
      return 0;
    }

    context.stdout(`${JSON.stringify(task, jsonReplacer, 2)}\n`);
    return 0;
  }

  if (commandName === "sources") {
    return handleSourcesCommand(args, context);
  }

  if (commandName === "metadata") {
    const formatIndex = args.indexOf("--format");
    const format = formatIndex >= 0 ? args[formatIndex + 1] : "json";
    if (format !== "json") throw new Error(`Unsupported metadata format "${format}".`);
    const includeSources = args.includes("--include-sources");
    const store = virtualStore(context.cwd);
    const metadata = await readPipelineMetadata(context.configPath, { cwd: context.cwd, includeSources, store });
    context.stdout(`${JSON.stringify(metadata, jsonReplacer, 2)}\n`);
    return 0;
  }

  if (commandName === "mcp") {
    return runMcpServer({
      pipeline: context.pipeline,
      configPath: context.configPath,
      cwd: context.cwd,
      env: context.env,
      store: virtualStore(context.cwd),
      allowRun: args.includes("--allow-run"),
      serverVersion: await ownPackageVersion(),
      input: process.stdin,
      write: (line) => context.stdout(`${line}\n`)
    });
  }

  if (commandName === "matrix") {
    const jobId = args[0];
    if (!jobId) throw new Error(`Usage: ${program} matrix <job> --format github`);
    const formatIndex = args.indexOf("--format");
    const format = formatIndex >= 0 ? args[formatIndex + 1] : "github";
    if (format !== "github") throw new Error(`Unsupported matrix format "${format}".`);
    context.stdout(`${JSON.stringify(matrixForJob(context.pipeline, jobId))}\n`);
    return 0;
  }

  if (commandName === "run") {
    const jobId = args[0];
    if (!jobId) throw new Error(`Usage: ${program} run <job>`);
    const format = runOutputFormat(args, program);
    const graph = tasksForJob(context.pipeline, jobId);
    if (context.dryRun) {
      return printDryRun(context, format, jobId);
    }
    if (format === "text") context.stdout(`Running ${context.pipeline.name}:${jobId} (${graph.executionOrder.join(" -> ")})\n`);
    const result = await runJob(context.pipeline, { id: jobId, mode: context.env.CI ? "ci" : "manual", cwd: context.cwd, env: context.env, commands: context.commands, sandbox: context.sandboxId, concurrency: context.concurrency, force: context.force, echo: format === "text" });
    if (format === "json") {
      context.stdout(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      reportFailedTasks(context, result.tasks);
      context.stdout(`Pipeline ${result.status}: ${result.id}\n`);
    }
    await pruneRunsAfterRun(context);
    return result.status === "passed" ? 0 : 1;
  }

  if (commandName === "run-task") {
    const taskId = args[0];
    if (!taskId) throw new Error(`Usage: ${program} run-task <task>`);
    const format = runOutputFormat(args, program);
    if (context.dryRun) {
      return printDryRun(context, format, undefined, taskId);
    }
    const result = await runSingleTask(context.pipeline, taskId, { mode: context.env.CI ? "ci" : "manual", cwd: context.cwd, env: context.env, commands: context.commands, sandbox: context.sandboxId, concurrency: context.concurrency, force: context.force, echo: format === "text" });
    if (format === "json") {
      context.stdout(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      reportFailedTasks(context, result.tasks);
      context.stdout(`Task run ${result.status}: ${result.id}\n`);
    }
    await pruneRunsAfterRun(context);
    return result.status === "passed" ? 0 : 1;
  }

  if (commandName === "cache") {
    const subcommand = args[0];
    if (subcommand === "clear") {
      await rm(join(context.cwd, ".async", "cache", "tasks"), { recursive: true, force: true });
      context.stdout("Cleared task cache.\n");
      return 0;
    }
    throw new Error(`Unknown cache command "${subcommand ?? ""}". Use: ${program} cache clear`);
  }

  if (commandName === "gc") {
    const keep = parsePositiveInteger(args, "--keep", 20);
    const cacheDays = parsePositiveInteger(args, "--cache-days", 30);
    const removed = await pruneRuns(context.cwd, keep);
    const remaining = await countRuns(context.cwd);
    const removedCacheEntries = await pruneCacheEntries(context.cwd, cacheDays);
    context.stdout(`Removed ${removed} run record${removed === 1 ? "" : "s"}; kept ${remaining}.\n`);
    context.stdout(
      cacheDays > 0
        ? `Removed ${removedCacheEntries} cache entr${removedCacheEntries === 1 ? "y" : "ies"} unused for ${cacheDays}+ days.\n`
        : "Cache pruning disabled (--cache-days 0).\n"
    );
    return 0;
  }

  throw new Error(`Unknown command "${commandName}".`);
}

async function printDryRun(context: PipelineCliContext, format: "text" | "json", jobId?: string, taskId?: string): Promise<number> {
  let pipeline = context.pipeline;
  let id = jobId;
  if (taskId !== undefined) {
    id = `task:${taskId}`;
    pipeline = {
      ...pipeline,
      jobs: { ...pipeline.jobs, [id]: { id, target: [taskId], trigger: [] } }
    };
  }
  if (!id) throw new Error("Dry run requires a job or task.");
  const plan = await planJob(pipeline, { id, cwd: context.cwd, env: context.env, sandbox: context.sandboxId });
  if (format === "json") {
    context.stdout(`${JSON.stringify(plan, null, 2)}\n`);
    return 0;
  }
  context.stdout(`Plan ${context.pipeline.name}:${jobId ?? taskId} (${plan.executionOrder.join(" -> ")})\n`);
  for (const entry of plan.entries) {
    const note = context.force && entry.predicted === "cached"
      ? "run (cache ignored by --force)"
      : entry.predicted;
    context.stdout(`  ${entry.id}\t${note}${entry.reason ? `\t${entry.reason}` : ""}\n`);
  }
  context.stdout("Dry run: no tasks executed. Cached predictions do not verify restored output files.\n");
  return 0;
}

function runOutputFormat(args: string[], program: string): "text" | "json" {
  const formatIndex = args.indexOf("--format");
  if (formatIndex < 0) return "text";
  const format = args[formatIndex + 1];
  if (format !== "text" && format !== "json") {
    throw new Error(`Usage: ${program} run <job> --format text|json`);
  }
  return format;
}

const DEFAULT_KEPT_RUNS = 50;

async function pruneRunsAfterRun(context: PipelineCliContext): Promise<void> {
  const raw = context.env.ASYNC_PIPELINE_KEEP_RUNS;
  let keep = DEFAULT_KEPT_RUNS;
  if (raw !== undefined && raw !== "") {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 0) return;
    if (parsed === 0) return; // 0 disables automatic pruning.
    keep = parsed;
  }
  await pruneRuns(context.cwd, keep);
}

async function pruneRuns(cwd: string, keep: number): Promise<number> {
  const runsDir = join(cwd, ".async", "runs");
  let runIds: string[] = [];
  try {
    runIds = (await readdir(runsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left));
  } catch {
    return 0;
  }
  const stale = runIds.slice(keep);
  for (const runId of stale) {
    await rm(join(runsDir, runId), { recursive: true, force: true });
  }
  return stale.length;
}

async function countRuns(cwd: string): Promise<number> {
  try {
    const entries = await readdir(join(cwd, ".async", "runs"), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).length;
  } catch {
    return 0;
  }
}

function collectFlagValues(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== flag) continue;
    const value = args[index + 1];
    if (!value) throw new Error(`${flag} requires a value.`);
    values.push(value);
    index += 1;
  }
  return values;
}

function parsePositiveInteger(args: string[], flag: string, fallback: number): number {
  const index = args.indexOf(flag);
  if (index < 0) return fallback;
  const raw = args[index + 1];
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${flag} requires a non-negative integer.`);
  }
  return value;
}

async function handleSourcesCommand(args: string[], context: PipelineCliContext): Promise<number> {
  const subcommand = args[0] ?? "list";
  if (subcommand === "list") {
    const store = virtualStore(context.cwd);
    const sources = await resolveSources(context.pipeline, context.cwd, store, { sync: false, loadPipelines: false });
    for (const source of Object.values(sources)) {
      const detail = source.definition.type === "git"
        ? `${source.definition.url}#${source.definition.ref}`
        : source.definition.path;
      context.stdout(`${source.id}\t${source.definition.type}\t${detail}\t${source.dir}\n`);
    }
    return 0;
  }
  if (subcommand === "sync") {
    const store = await createStore(context.cwd);
    const sources = await resolveSources(context.pipeline, context.cwd, store, { sync: true, loadPipelines: true });
    for (const source of Object.values(sources)) context.stdout(`${source.id}\t${source.record.commit ?? "unknown"}\t${source.dir}\n`);
    return 0;
  }
  throw new Error(`Unknown sources command "${subcommand}".`);
}

function printHelp(program: string): string {
  return `Usage:
  ${program} run <job> [--sandbox <id>] [--concurrency <n>] [--force] [--dry-run] [--format text|json]
  ${program} run-task <task> [--sandbox <id>] [--concurrency <n>] [--force] [--dry-run] [--format text|json]
  ${program} list
  ${program} graph --format json|dot
  ${program} explain <task> [--diff-inputs] [--format text|json]
  ${program} explain --run <run-id> [--format text|json]
  ${program} mcp [--allow-run]
  ${program} sources list
  ${program} sources sync
  ${program} metadata --format json [--include-sources]
  ${program} matrix <job> --format github
  ${program} sync list
  ${program} sync generate
  ${program} sync check
  ${program} sync github list
  ${program} sync github generate [--workflow <path>] [--lock <path>]
  ${program} sync github check [--workflow <path>] [--lock <path>]
  ${program} sync tasks list
  ${program} sync tasks generate
  ${program} sync tasks check
  ${program} github generate [--workflow <path>] [--lock <path>]
  ${program} github check [--workflow <path>] [--lock <path>]
  ${program} github run [--job <id>] [--sandbox <id>] [--concurrency <n>]
  ${program} cache clear
  ${program} gc [--keep <n>] [--cache-days <n>]
  ${program} doctor\n`;
}

async function handleSyncCommand(args: string[], context: PipelineCliContext): Promise<number> {
  const targetNames = new Set(["github", "tasks"]);
  const maybeTarget = args[0];
  const target = targetNames.has(maybeTarget ?? "") ? maybeTarget : undefined;
  const subcommand = target ? args[1] ?? "list" : args[0] ?? "list";
  const rest = target ? args.slice(2) : args.slice(1);

  if (target === "github") return handleSyncGitHubCommand(subcommand, rest, context, { requireConfigured: true });
  if (target === "tasks") return handleSyncTasksCommand(subcommand, context, { requireConfigured: true });

  if (subcommand === "list") {
    let listed = false;
    if (context.pipeline.sync.github.enabled) {
      context.stdout(`GitHub workflow: ${context.pipeline.sync.github.workflow}\n`);
      context.stdout(`GitHub lock: ${context.pipeline.sync.github.lock}\n`);
      listed = true;
    }
    if (context.pipeline.sync.tasks.enabled) {
      for (const line of describeTaskSync(await renderTaskSync(context.pipeline, context))) context.stdout(`${line}\n`);
      listed = true;
    }
    if (!listed) context.stdout("No sync targets configured.\n");
    return 0;
  }

  if (subcommand === "generate") {
    let generated = false;
    if (context.pipeline.sync.github.enabled) {
      await handleSyncGitHubCommand("generate", rest, context, { requireConfigured: false });
      generated = true;
    }
    if (context.pipeline.sync.tasks.enabled) {
      await handleSyncTasksCommand("generate", context, { requireConfigured: false });
      generated = true;
    }
    if (!generated) throw new Error("No sync targets configured.");
    return 0;
  }

  if (subcommand === "check") {
    const issues: string[] = [];
    let checked = false;
    if (context.pipeline.sync.github.enabled) {
      const paths = githubGenerationPaths(rest);
      const rendered = await renderGitHubWorkflow(context.pipeline, { cwd: context.cwd, configPath: context.configPath, ...paths });
      issues.push(...await checkGitHubWorkflow(rendered, context.cwd));
      checked = true;
    }
    if (context.pipeline.sync.tasks.enabled) {
      const rendered = await renderTaskSync(context.pipeline, context);
      issues.push(...await checkTaskSync(rendered, context.cwd));
      checked = true;
    }
    if (!checked) throw new Error("No sync targets configured.");
    if (issues.length > 0) {
      for (const issue of issues) context.stderr(`${issue}\n`);
      return 1;
    }
    context.stdout("Sync targets are current.\n");
    return 0;
  }

  throw new Error(`Unknown sync command "${subcommand}".`);
}

async function handleSyncGitHubCommand(
  subcommand: string,
  args: string[],
  context: PipelineCliContext,
  options: { requireConfigured: boolean }
): Promise<number> {
  if (options.requireConfigured && !context.pipeline.sync.github.enabled) {
    throw new Error("GitHub sync is not configured. Add sync.github to pipeline.ts.");
  }
  const paths = githubGenerationPaths(args);
  const rendered = await renderGitHubWorkflow(context.pipeline, { cwd: context.cwd, configPath: context.configPath, ...paths });
  if (subcommand === "list") {
    context.stdout(`GitHub workflow: ${rendered.workflowPath}\n`);
    context.stdout(`GitHub lock: ${rendered.lockPath}\n`);
    return 0;
  }
  if (subcommand === "generate") {
    await writeGitHubWorkflow(rendered, context.cwd);
    context.stdout(`Generated ${rendered.workflowPath}\n`);
    context.stdout(`Generated ${rendered.lockPath}\n`);
    return 0;
  }
  if (subcommand === "check") {
    const issues = await checkGitHubWorkflow(rendered, context.cwd);
    if (issues.length > 0) {
      for (const issue of issues) context.stderr(`${issue}\n`);
      return 1;
    }
    context.stdout("GitHub workflow is current.\n");
    return 0;
  }
  throw new Error(`Unknown sync github command "${subcommand}".`);
}

async function handleSyncTasksCommand(
  subcommand: string,
  context: PipelineCliContext,
  options: { requireConfigured: boolean }
): Promise<number> {
  const rendered = await renderTaskSync(context.pipeline, context);
  if (subcommand === "list") {
    for (const line of describeTaskSync(rendered)) context.stdout(`${line}\n`);
    return options.requireConfigured && !rendered.enabled ? 1 : 0;
  }
  if (subcommand === "generate") {
    if (options.requireConfigured && !rendered.enabled) throw new Error("Task sync is not configured. Add sync.tasks to pipeline.ts.");
    await writeTaskSync(rendered, context.cwd);
    for (const manifest of rendered.manifests) context.stdout(`Generated ${manifest.path}\n`);
    context.stdout(`Generated ${rendered.lockPath}\n`);
    return 0;
  }
  if (subcommand === "check") {
    const issues = await checkTaskSync(rendered, context.cwd, { requireConfigured: options.requireConfigured });
    if (issues.length > 0) {
      for (const issue of issues) context.stderr(`${issue}\n`);
      return 1;
    }
    context.stdout("Task sync is current.\n");
    return 0;
  }
  throw new Error(`Unknown sync tasks command "${subcommand}".`);
}

function parseGlobalOptions(args: string[]): ParsedGlobalOptions {
  const rest: string[] = [];
  let concurrency: number | undefined;
  let sandboxId: string | undefined;
  let force = false;
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--sandbox") {
      sandboxId = args[index + 1];
      if (!sandboxId) throw new Error("Usage: async-pipeline <command> --sandbox <id>");
      index += 1;
      continue;
    }
    if (arg === "--concurrency") {
      const raw = args[index + 1];
      if (!raw) throw new Error("Usage: async-pipeline <command> --concurrency <n>");
      concurrency = Number(raw);
      index += 1;
      continue;
    }
    rest.push(arg);
  }
  return { args: rest, concurrency, sandboxId, force, dryRun };
}


function findPipelineConfig(cwd: string): string | null {
  let current = resolve(cwd);
  for (;;) {
    for (const fileName of ["pipeline.ts", "pipeline.mjs", "pipeline.js"]) {
      const configPath = join(current, fileName);
      if (existsSync(configPath)) return configPath;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function programName(): string {
  const name = basename(process.argv[1] ?? "async-pipeline");
  return name === "cli.js" ? "async-pipeline" : name;
}

// Failed runs must name the reason on the terminal, not only inside
// .async/runs/<id>/execution.json. Task output was already streamed; this
// repeats the recorded per-task error next to the final status line.
function reportFailedTasks(context: PipelineCliContext, tasks: { id: string; status: string; error?: string }[]): void {
  for (const failed of tasks.filter((task) => task.status === "failed")) {
    context.stderr(`Task ${failed.id} failed${failed.error ? `: ${failed.error}` : ""}\n`);
  }
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "function") return "[function]";
  return value;
}

/**
 * The published package's version for MCP serverInfo, falling back to this
 * internal package's own. Best-effort: identity metadata, not behavior.
 */
async function ownPackageVersion(): Promise<string | undefined> {
  for (const candidate of ["../../pipeline/package.json", "../package.json"]) {
    try {
      const manifest = JSON.parse(await readFile(new URL(candidate, import.meta.url), "utf8")) as { version?: string };
      if (typeof manifest.version === "string") return manifest.version;
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

function githubGenerationPaths(args: string[]): { workflowPath?: string; lockPath?: string } {
  const workflowIndex = args.indexOf("--workflow");
  const lockIndex = args.indexOf("--lock");
  const workflowPath = workflowIndex >= 0 ? args[workflowIndex + 1] : undefined;
  const lockPath = lockIndex >= 0 ? args[lockIndex + 1] : undefined;
  if (workflowIndex >= 0 && !workflowPath) throw new Error("Usage: async-pipeline github <generate|check> --workflow <path>");
  if (lockIndex >= 0 && !lockPath) throw new Error("Usage: async-pipeline github <generate|check> --lock <path>");
  return { workflowPath, lockPath };
}

async function loadAvailableSourceGraph(pipeline: NormalizedPipeline, cwd: string, store: Awaited<ReturnType<typeof createStore>>) {
  const sources = await resolveSources(pipeline, cwd, store, { sync: false, loadPipelines: true });
  const sourcePipelines: Parameters<typeof composePipelines>[1] = {};
  for (const [sourceId, resolved] of Object.entries(sources)) {
    if (!resolved.pipeline) continue;
    sourcePipelines[sourceId] = {
      pipeline: resolved.pipeline,
      context: sourceContext(resolved)
    };
  }
  return composePipelines(pipeline, sourcePipelines);
}

function virtualStore(root: string): Awaited<ReturnType<typeof createStore>> {
  return {
    root,
    asyncDir: resolve(root, ".async"),
    runsDir: resolve(root, ".async", "runs"),
    cacheDir: resolve(root, ".async", "cache", "tasks"),
    sourcesDir: resolve(root, ".async", "sources")
  };
}

export function runCliMain(): Promise<void> {
  // When the downstream pipe closes (e.g. `async-pipeline run x | head`),
  // terminate running task process groups, let the run finalize its
  // execution record, and exit 141 (128 + SIGPIPE) instead of crashing
  // with an unhandled EPIPE or orphaning task processes.
  const shutdownOnEpipe = (error: NodeJS.ErrnoException): void => {
    if (error.code === "EPIPE") {
      beginShutdown("SIGTERM", 141);
      return;
    }
    throw error;
  };
  process.stdout.on("error", shutdownOnEpipe);
  process.stderr.on("error", shutdownOnEpipe);

  return runPipelineCli({ args: process.argv.slice(2) }).then((result) => {
    process.exitCode = shutdownExitCode() ?? result.code;
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = shutdownExitCode() ?? 1;
  });
}

// True only when this module is the executed entrypoint. The public package
// bin (`@async/pipeline` dist/cli.js) is a different wrapper module, so it
// cannot rely on this guard; it imports and calls runCliMain() explicitly.
// Realpath the argv path so bin shims and node_modules symlinks still count
// as direct execution of this file.
function isCliEntrypoint(argvPath: string | undefined): boolean {
  if (!argvPath) return false;
  try {
    return pathToFileURL(realpathSync(argvPath)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isCliEntrypoint(process.argv[1])) {
  void runCliMain();
}
