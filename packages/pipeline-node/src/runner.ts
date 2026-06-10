import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { CandidateContext, EnvValue, ExecutionRecord, NormalizedPipeline, NormalizedTask, ShellCommand, TaskContext, TaskResult, TaskRunFunction, TaskSourceContext, TaskStep } from "@async/pipeline-core";
import { sh, tasksForJob } from "@async/pipeline-core";
import { computeTaskCacheKey, createStore, readCacheEntry, writeCacheEntry, writeExecution, writeTaskLog, type PipelineStore } from "./store.js";
import { createRunPlan, sourceContext, type ResolvedSource } from "./sources.js";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export interface RunnerAdapter {
  name: string;
  runShell(command: string, options: { cwd: string; env: NodeJS.ProcessEnv; task: NormalizedTask; timeoutMs?: number }): Promise<CommandResult>;
  checkTool?(tool: string): Promise<boolean>;
}

export class HostRunnerAdapter implements RunnerAdapter {
  name = "host";

  runShell(command: string, options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<CommandResult> {
    return runProcess(command, { cwd: options.cwd, env: options.env, timeoutMs: options.timeoutMs });
  }

  async checkTool(tool: string): Promise<boolean> {
    const result = await runProcess(`command -v ${shellEscape(tool)}`, { cwd: process.cwd(), env: process.env, echo: false });
    return result.code === 0;
  }
}

const memoryCacheEntries = new Map<string, TaskResult>();

export interface RunOptions {
  cwd: string;
  jobId: string;
  mode?: "manual" | "ci";
  adapter?: RunnerAdapter;
}

export async function runJob(pipeline: NormalizedPipeline, options: RunOptions): Promise<ExecutionRecord> {
  const adapter = options.adapter ?? new HostRunnerAdapter();
  const store = await createStore(options.cwd);
  const plan = await createRunPlan(pipeline, options.cwd, store);
  const graph = tasksForJob(plan.pipeline, options.jobId);
  const record: ExecutionRecord = {
    id: `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`,
    pipelineName: plan.pipeline.name,
    jobId: options.jobId,
    cwd: options.cwd,
    startedAt: new Date().toISOString(),
    status: "running",
    mode: options.mode ?? "manual",
    tasks: [],
    sources: Object.fromEntries(Object.entries(plan.sources).map(([sourceId, resolved]) => [sourceId, resolved.record]))
  };

  await writeExecution(store, record);
  const preparedSources = new Set<string>();
  const jobDefinition = plan.pipeline.jobs[options.jobId];
  const envDefinitions = {
    ...plan.pipeline.env,
    ...(jobDefinition?.env ?? {})
  };

  for (const taskId of graph.executionOrder) {
    const taskDefinition = plan.pipeline.tasks[taskId];
    if (!taskDefinition) continue;

    const taskSource = taskDefinition.source?.name ? plan.sources[taskDefinition.source.name] : undefined;
    if (taskSource && !preparedSources.has(taskSource.id)) {
      const prepareResult = await runSourcePrepare(taskSource, {
        adapter,
        candidate: plan.candidate,
        rootCwd: options.cwd,
        runId: record.id,
        store
      });
      preparedSources.add(taskSource.id);
      if (prepareResult) {
        record.tasks.push(prepareResult);
        await writeExecution(store, record);
        if (prepareResult.status === "failed") {
          record.status = "failed";
          record.finishedAt = new Date().toISOString();
          await writeExecution(store, record);
          return record;
        }
      }
    }

    const result = await runTask(plan.pipeline, taskDefinition, {
      adapter,
      candidate: plan.candidate,
      cwd: taskDefinition.source?.dir || options.cwd,
      rootCwd: options.cwd,
      runId: record.id,
      source: taskDefinition.source,
      envDefinitions,
      sourcePrepareCommands: taskSource ? await resolvePrepareCommands(taskSource, {
        candidate: plan.candidate,
        rootCwd: options.cwd,
        runId: record.id
      }) : [],
      store
    });
    record.tasks.push(result);
    await writeExecution(store, record);
    if (result.status === "failed") {
      record.status = "failed";
      record.finishedAt = new Date().toISOString();
      await writeExecution(store, record);
      return record;
    }
  }

  record.status = "passed";
  record.finishedAt = new Date().toISOString();
  await writeExecution(store, record);
  return record;
}

export async function runSingleTask(pipeline: NormalizedPipeline, taskId: string, options: Omit<RunOptions, "jobId">): Promise<ExecutionRecord> {
  const syntheticJobId = `task:${taskId}`;
  const syntheticPipeline: NormalizedPipeline = {
    ...pipeline,
    jobs: {
      ...pipeline.jobs,
      [syntheticJobId]: { id: syntheticJobId, target: [taskId], trigger: [], mode: options.mode }
    }
  };
  return runJob(syntheticPipeline, { ...options, jobId: syntheticJobId });
}

async function runTask(
  pipeline: NormalizedPipeline,
  taskDefinition: NormalizedTask,
  options: {
    adapter: RunnerAdapter;
    candidate: CandidateContext;
    cwd: string;
    rootCwd: string;
    runId: string;
    source?: TaskSourceContext;
    envDefinitions: Record<string, EnvValue>;
    sourcePrepareCommands?: ShellCommand[];
    store: PipelineStore;
  }
): Promise<TaskResult> {
  const started = Date.now();
  const startedAt = new Date().toISOString();
  const metadata: Record<string, string | number | boolean | null> = {};
  let combinedLog = "";
  let taskEnv: NodeJS.ProcessEnv;
  try {
    taskEnv = buildTaskEnv(process.env, {
      candidate: options.candidate,
      envDefinitions: options.envDefinitions,
      rootCwd: options.rootCwd,
      source: options.source,
      taskId: taskDefinition.id
    });
  } catch (error) {
    const lastError = error instanceof Error ? error.message : String(error);
    await writeTaskLog(options.store, options.runId, taskDefinition.id, `[env] ${lastError}\n`);
    return {
      id: taskDefinition.id,
      status: "failed",
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      attempts: 0,
      cacheHit: false,
      error: lastError,
      metadata
    };
  }
  const context = createTaskContext(taskDefinition, {
    candidate: options.candidate,
    cwd: options.cwd,
    env: taskEnv,
    metadata,
    rootCwd: options.rootCwd,
    runId: options.runId,
    source: options.source,
    writeLog(message: string) {
      combinedLog += `${message}\n`;
    }
  });
  const resolvedSteps = await resolveTaskSteps(taskDefinition.steps, context);
  const cacheKey = await computeTaskCacheKey(pipeline, taskDefinition, options.cwd, {
    candidate: options.candidate,
    prepareCommands: (options.sourcePrepareCommands ?? []).map((command) => command.command),
    source: options.source,
    steps: resolvedSteps
  });

  if (taskDefinition.cache.enabled) {
    const cached = await readTaskCacheEntry(taskDefinition, options.store, cacheKey);
    if (cached?.status === "passed") {
      const result: TaskResult = {
        ...cached,
        id: taskDefinition.id,
        status: "cached",
        startedAt,
        finishedAt: new Date().toISOString(),
        attempts: 0,
        cacheKey,
        cacheHit: true,
        durationMs: Date.now() - started
      };
      await writeTaskLog(options.store, options.runId, taskDefinition.id, `[cache hit] ${cacheKey}\n`);
      return result;
    }
  }

  let attempts = 0;
  let lastError = "";

  const maxAttempts = Math.max(1, taskDefinition.retry.attempts);
  while (attempts < maxAttempts) {
    attempts += 1;
    try {
      for (const requirement of taskDefinition.requires?.tools ?? []) {
        const ok = await options.adapter.checkTool?.(requirement);
        if (ok === false) {
          throw new Error(`Required tool "${requirement}" is not available for task "${taskDefinition.id}".`);
        }
      }

      for (const secret of taskDefinition.requires?.secrets ?? []) {
        if (!process.env[secret]) {
          throw new Error(`Required secret "${secret}" is not available for task "${taskDefinition.id}".`);
        }
      }

      for (const step of resolvedSteps) {
        if (typeof step === "function") {
          await runFunctionStep(step, context, taskDefinition.timeoutMs);
          continue;
        }
        if (!isShellCommand(step)) {
          throw new Error(`Deferred shell step for task "${taskDefinition.id}" was not resolved.`);
        }
        const result = await runShellStep(step, taskDefinition, { ...options, env: taskEnv });
        combinedLog += result.stdout;
        combinedLog += result.stderr;
        if (result.timedOut) {
          throw new Error(`Task "${taskDefinition.id}" timed out after ${taskDefinition.timeoutMs}ms.`);
        }
        if (result.code !== 0) {
          throw new Error(`Command failed with exit code ${result.code}: ${step.command}`);
        }
      }

      const finishedAt = new Date().toISOString();
      const result: TaskResult = {
        id: taskDefinition.id,
        status: "passed",
        startedAt,
        finishedAt,
        durationMs: Date.now() - started,
        attempts,
        cacheKey,
        cacheHit: false,
        metadata
      };
      await writeTaskLog(options.store, options.runId, taskDefinition.id, combinedLog);
      if (taskDefinition.cache.enabled) {
        await writeTaskCacheEntry(taskDefinition, options.store, cacheKey, result);
      }
      return result;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      combinedLog += `[attempt ${attempts}] ${lastError}\n`;
      if (attempts < maxAttempts && taskDefinition.retry.delayMs) {
        await delay(taskDefinition.retry.delayMs);
      }
    }
  }

  const result: TaskResult = {
    id: taskDefinition.id,
    status: "failed",
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    attempts,
    cacheKey,
    cacheHit: false,
    error: lastError,
    metadata
  };
  await writeTaskLog(options.store, options.runId, taskDefinition.id, combinedLog);
  return result;
}

async function runShellStep(
  step: ShellCommand,
  taskDefinition: NormalizedTask,
  options: { adapter: RunnerAdapter; cwd: string; env: NodeJS.ProcessEnv }
): Promise<CommandResult> {
  return options.adapter.runShell(step.command, {
    cwd: options.cwd,
    env: options.env,
    task: taskDefinition,
    timeoutMs: taskDefinition.timeoutMs
  });
}

async function runSourcePrepare(
  source: ResolvedSource,
  options: { adapter: RunnerAdapter; candidate: CandidateContext; rootCwd: string; runId: string; store: PipelineStore }
): Promise<TaskResult | null> {
  if (source.definition.prepare.length === 0) return null;

  const started = Date.now();
  const startedAt = new Date().toISOString();
  const taskId = `${source.id}:prepare`;
  const sourceTaskContext = sourceContext(source);
  let log = "";
  const context = createTaskContext({ id: taskId } as NormalizedTask, {
    candidate: options.candidate,
    cwd: source.dir,
    env: buildTaskEnv(process.env, {
      candidate: options.candidate,
      rootCwd: options.rootCwd,
      source: sourceTaskContext
    }),
    metadata: {},
    rootCwd: options.rootCwd,
    runId: options.runId,
    source: sourceTaskContext,
    writeLog(message: string) {
      log += `${message}\n`;
    }
  });
  const steps = await resolveTaskSteps(source.definition.prepare, context);

  try {
    for (const step of steps) {
      if (typeof step === "function") {
        await runFunctionStep(step, context);
        continue;
      }
      if (!isShellCommand(step)) {
        throw new Error(`Deferred shell step for source "${source.id}" was not resolved.`);
      }
      const result = await options.adapter.runShell(step.command, {
        cwd: source.dir,
        env: buildTaskEnv(process.env, {
          candidate: options.candidate,
          rootCwd: options.rootCwd,
          source: sourceTaskContext
        }),
        task: { id: taskId } as NormalizedTask
      });
      log += result.stdout;
      log += result.stderr;
      if (result.code !== 0) {
        throw new Error(`Command failed with exit code ${result.code}: ${step.command}`);
      }
    }
    const result: TaskResult = {
      id: taskId,
      status: "passed",
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      attempts: 1,
      cacheHit: false
    };
    await writeTaskLog(options.store, options.runId, taskId, log);
    return result;
  } catch (error) {
    const result: TaskResult = {
      id: taskId,
      status: "failed",
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      attempts: 1,
      cacheHit: false,
      error: error instanceof Error ? error.message : String(error)
    };
    log += `[prepare] ${result.error}\n`;
    await writeTaskLog(options.store, options.runId, taskId, log);
    return result;
  }
}

async function resolvePrepareCommands(
  source: ResolvedSource,
  options: { candidate: CandidateContext; rootCwd: string; runId: string }
): Promise<ShellCommand[]> {
  const context = createTaskContext({ id: `${source.id}:prepare` } as NormalizedTask, {
    candidate: options.candidate,
    cwd: source.dir,
    env: buildTaskEnv(process.env, {
      candidate: options.candidate,
      rootCwd: options.rootCwd,
      source: sourceContext(source)
    }),
    metadata: {},
    rootCwd: options.rootCwd,
    runId: options.runId,
    source: sourceContext(source),
    writeLog() {}
  });
  const steps = await resolveTaskSteps(source.definition.prepare, context);
  return steps.filter(isShellCommand);
}

async function resolveTaskSteps(steps: readonly TaskStep[], context: TaskContext): Promise<TaskStep[]> {
  const resolved: TaskStep[] = [];
  for (const step of steps) {
    if (typeof step === "function" || step.kind === "shell") {
      resolved.push(step);
      continue;
    }
    const command = await step.command(context);
    if (command.kind !== "shell") {
      throw new Error(`Deferred shell step for task "${context.taskId}" must return sh\`...\`.`);
    }
    resolved.push(command);
  }
  return resolved;
}

function createTaskContext(
  taskDefinition: Pick<NormalizedTask, "id">,
  options: {
    candidate: CandidateContext;
    cwd: string;
    env: NodeJS.ProcessEnv;
    metadata: Record<string, string | number | boolean | null>;
    rootCwd: string;
    runId: string;
    source?: TaskSourceContext;
    writeLog(message: string): void;
  }
): TaskContext {
  return {
    taskId: taskDefinition.id,
    runId: options.runId,
    cwd: options.cwd,
    env: options.env,
    root: {
      dir: options.rootCwd
    },
    candidate: options.candidate,
    source: options.source,
    meta(values: Record<string, string | number | boolean | null>) {
      Object.assign(options.metadata, values);
    },
    log(message: string) {
      options.writeLog(message);
    },
    sh
  };
}

function buildTaskEnv(
  baseEnv: NodeJS.ProcessEnv,
  options: { candidate: CandidateContext; envDefinitions?: Record<string, EnvValue>; rootCwd: string; source?: TaskSourceContext; taskId?: string }
): NodeJS.ProcessEnv {
  const resolvedEnv = resolveEnvDefinitions(options.envDefinitions ?? {}, baseEnv, options.taskId);
  return {
    ...baseEnv,
    ...resolvedEnv,
    ASYNC_PIPELINE_ROOT_DIR: options.rootCwd,
    ASYNC_PIPELINE_CANDIDATE_DIR: options.candidate.dir,
    ASYNC_PIPELINE_CANDIDATE_FINGERPRINT: options.candidate.fingerprint,
    ASYNC_PIPELINE_SOURCE_NAME: options.source?.name,
    ASYNC_PIPELINE_SOURCE_DIR: options.source?.dir,
    ASYNC_PIPELINE_SOURCE_REF: options.source?.ref,
    ASYNC_PIPELINE_SOURCE_COMMIT: options.source?.commit
  };
}

function resolveEnvDefinitions(definitions: Record<string, EnvValue>, baseEnv: NodeJS.ProcessEnv, taskId = "unknown"): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(definitions)) {
    if (typeof value === "string") {
      resolved[key] = value;
      continue;
    }
    if (value.kind === "async-pipeline.env.secret") {
      const secretValue = baseEnv[value.name] ?? baseEnv[key];
      if (secretValue === undefined || secretValue === "") {
        throw new Error(`Required secret "${value.name}" for env "${key}" is not available for task "${taskId}".`);
      }
      resolved[key] = secretValue;
      continue;
    }
    if (value.kind === "async-pipeline.env.var") {
      const selector = baseEnv[value.name] ?? baseEnv[key] ?? value.default;
      if (selector === undefined || selector === "") {
        throw new Error(`Required variable "${value.name}" for env "${key}" is not available for task "${taskId}".`);
      }
      if (value.values) {
        const mapped = value.values[selector];
        if (mapped === undefined) {
          throw new Error(`Variable "${value.name}" value "${selector}" is not mapped for env "${key}" in task "${taskId}".`);
        }
        resolved[key] = mapped;
      } else {
        resolved[key] = selector;
      }
      continue;
    }
  }
  return resolved;
}

function isShellCommand(step: TaskStep): step is ShellCommand {
  return typeof step !== "function" && step.kind === "shell";
}

async function readTaskCacheEntry(taskDefinition: NormalizedTask, store: PipelineStore, cacheKey: string): Promise<TaskResult | null> {
  const storeName = taskDefinition.cache.store ?? "file";
  if (storeName === "file") return readCacheEntry(store, cacheKey);
  if (storeName === "memory") return memoryCacheEntries.get(cacheKey) ?? null;
  throw new Error(`Cache store "${storeName}" is registered but this runner cannot execute it. Use "file" or "memory", or provide a runtime-specific adapter.`);
}

async function writeTaskCacheEntry(taskDefinition: NormalizedTask, store: PipelineStore, cacheKey: string, result: TaskResult): Promise<void> {
  const storeName = taskDefinition.cache.store ?? "file";
  if (storeName === "file") {
    await writeCacheEntry(store, cacheKey, result);
    return;
  }
  if (storeName === "memory") {
    memoryCacheEntries.set(cacheKey, result);
    return;
  }
  throw new Error(`Cache store "${storeName}" is registered but this runner cannot execute it. Use "file" or "memory", or provide a runtime-specific adapter.`);
}

async function runFunctionStep(step: TaskRunFunction, context: TaskContext, timeoutMs?: number): Promise<void> {
  if (!timeoutMs) {
    await step(context);
    return;
  }

  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.resolve(step(context)),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Task "${context.taskId}" timed out after ${timeoutMs}ms.`)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function runProcess(command: string, options: { cwd: string; env: NodeJS.ProcessEnv; echo?: boolean; timeoutMs?: number }): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: options.cwd,
      env: options.env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timeout: NodeJS.Timeout | undefined;
    let forceKillTimeout: NodeJS.Timeout | undefined;

    if (options.timeoutMs) {
      timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        forceKillTimeout = setTimeout(() => child.kill("SIGKILL"), 500);
      }, options.timeoutMs);
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (options.echo !== false) process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (options.echo !== false) process.stderr.write(chunk);
    });
    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      if (forceKillTimeout) clearTimeout(forceKillTimeout);
      if (timedOut) {
        const timeoutMessage = `[timeout] Command timed out after ${options.timeoutMs}ms.\n`;
        resolve({ code: 124, stdout, stderr: `${stderr}${timeoutMessage}`, timedOut: true });
        return;
      }
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function shellEscape(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
