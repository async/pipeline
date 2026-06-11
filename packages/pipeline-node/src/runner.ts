import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { availableParallelism } from "node:os";
import { posix, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { CandidateContext, CommandAction, CommandOutputPolicy, CommandPolicy, EnvValue, ExecutionRecord, NormalizedPipeline, NormalizedTask, SandboxDefinition, SandboxId, ShellCommand, TaskContext, TaskResult, TaskRunFunction, TaskSourceContext, TaskStep } from "@async/pipeline-core";
import { sh, tasksForJob } from "@async/pipeline-core";
import { acquireRunLock, computeTaskCacheKey, createStore, outputFilesExist, readCacheEntry, resolveOutputFiles, restoreCacheOutputs, writeCacheEntry, writeExecution, writeTaskLog, type PipelineStore } from "./store.js";
import { createRunPlan, sourceContext, type ResolvedSource } from "./sources.js";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export interface RunShellOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  task: NormalizedTask;
  timeoutMs?: number;
  echo?: boolean;
  redactValues?: readonly string[];
  /**
   * Env keys safe to forward into isolated executors (docker). When omitted,
   * isolating executors forward nothing beyond their own defaults.
   */
  forwardEnvKeys?: readonly string[];
}

export interface CommandExecutor {
  name: string;
  runShell(command: string, options: RunShellOptions): Promise<CommandResult>;
  checkTool?(tool: string): Promise<boolean>;
}

export type CommandPolicyStatus = "allowed" | "mocked" | "denied" | "approval-required";

export interface CommandInvocation {
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface CommandRecord {
  argv: string[];
  cwd: string;
  status: CommandPolicyStatus;
  code: number;
  stdout: string;
  stderr: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

export interface PipelineCommands {
  run(invocation: CommandInvocation, next: () => Promise<CommandResult>): Promise<CommandResult>;
  records(): CommandRecord[];
}

export interface PipelineFileSystem {
  kind: "host";
}

export interface ExecutionContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  fs: PipelineFileSystem;
  executor: CommandExecutor;
  commands?: PipelineCommands;
}

export class HostCommandExecutor implements CommandExecutor {
  name = "host";

  runShell(command: string, options: RunShellOptions): Promise<CommandResult> {
    return runProcess(command, { cwd: options.cwd, env: options.env, echo: options.echo, timeoutMs: options.timeoutMs, label: options.task?.id, redactValues: options.redactValues });
  }

  async checkTool(tool: string): Promise<boolean> {
    const result = await runProcess(`command -v ${shellEscape(tool)}`, { cwd: process.cwd(), env: process.env, echo: false });
    return result.code === 0;
  }
}

export interface DockerVolume {
  source: string;
  target: string;
  readonly?: boolean;
}

export class DockerCommandExecutor implements CommandExecutor {
  name = "docker";

  constructor(private readonly options: { image: string; hostCwd: string; workdir: string; volumes: DockerVolume[] }) {}

  runShell(command: string, options: RunShellOptions): Promise<CommandResult> {
    return runProcess(this.dockerCommand(command, options.cwd, options.env, options.forwardEnvKeys ?? []), { cwd: this.options.hostCwd, env: options.env, echo: options.echo, timeoutMs: options.timeoutMs, label: options.task?.id, redactValues: options.redactValues });
  }

  async checkTool(tool: string): Promise<boolean> {
    const result = await runProcess(this.dockerCommand(`command -v ${shellEscape(tool)}`, this.options.hostCwd, process.env, []), {
      cwd: this.options.hostCwd,
      env: process.env,
      echo: false
    });
    return result.code === 0;
  }

  private dockerCommand(command: string, cwd: string, env: NodeJS.ProcessEnv, forwardEnvKeys: readonly string[]): string {
    // Only explicitly forwarded keys cross the container boundary. Forwarding
    // the whole host env would leak unrelated secrets into every container.
    const forwarded = [...new Set(forwardEnvKeys)].filter((key) => env[key] !== undefined).sort();
    return [
      "docker",
      "run",
      "--rm",
      "-w",
      shellEscape(this.containerCwd(cwd)),
      ...this.options.volumes.flatMap((volume) => ["-v", shellEscape(`${volume.source}:${volume.target}${volume.readonly ? ":ro" : ""}`)]),
      ...forwarded.flatMap((key) => ["-e", shellEscape(key)]),
      shellEscape(this.options.image),
      "bash",
      "-lc",
      shellEscape(command)
    ].join(" ");
  }

  private containerCwd(cwd: string): string {
    const rel = relative(this.options.hostCwd, cwd);
    if (!rel || rel === ".") return this.options.workdir;
    if (rel.startsWith("..")) return this.options.workdir;
    return posix.join(this.options.workdir, rel.split(/[\\/]+/).join("/"));
  }
}

export class LimaCommandExecutor implements CommandExecutor {
  name = "lima";

  constructor(private readonly vm = "async-pipeline") {}

  runShell(command: string, options: RunShellOptions): Promise<CommandResult> {
    const escaped = shellEscape(`cd ${shellEscape(options.cwd)} && ${command}`);
    return runProcess(`limactl shell ${shellEscape(this.vm)} -- bash -lc ${escaped}`, { cwd: options.cwd, env: options.env, echo: options.echo, timeoutMs: options.timeoutMs, label: options.task?.id, redactValues: options.redactValues });
  }

  async checkTool(tool: string): Promise<boolean> {
    const result = await runProcess(`limactl shell ${shellEscape(this.vm)} -- bash -lc ${shellEscape(`command -v ${shellEscape(tool)}`)}`, {
      cwd: process.cwd(),
      env: process.env
    });
    return result.code === 0;
  }
}

/**
 * Resolve flat run options into the execution context a run uses: host by
 * default, or the selected sandbox (by id from `pipeline.sandboxes`, or an
 * inline definition).
 */
export function resolveExecutionContext(pipeline: NormalizedPipeline, target: RunTarget = {}): ExecutionContext {
  const cwd = target.cwd ?? process.cwd();
  const env = target.env ?? process.env;
  const base: ExecutionContext = {
    cwd,
    env,
    fs: { kind: "host" },
    executor: target.executor ?? new HostCommandExecutor(),
    commands: target.commands
  };
  const ref = target.sandbox;
  if (!ref || ref === "host") return base;
  const definition = typeof ref === "string" ? pipeline.sandboxes[ref] : ref;
  if (!definition) {
    throw new Error(`Unknown sandbox "${String(ref)}". Declare it under \`sandboxes\` in the pipeline config.`);
  }
  if (definition.kind === "host") return base;
  if (definition.kind === "lima") {
    return { ...base, executor: new LimaCommandExecutor(definition.vm) };
  }
  const workdir = definition.workdir ?? "/workspace";
  return {
    ...base,
    executor: new DockerCommandExecutor({
      image: definition.image,
      hostCwd: cwd,
      workdir,
      volumes: definition.volumes ?? [{ source: cwd, target: workdir }]
    })
  };
}

export function commandProxy(policy: CommandPolicy = { rules: [] }): PipelineCommands {
  const records: CommandRecord[] = [];
  return {
    async run(invocation, next) {
      const startedAt = new Date().toISOString();
      const started = Date.now();
      const action = matchingAction(policy, invocation.argv);
      const status = commandStatus(action);
      const result = await runCommandAction(action, invocation, next);
      const outputPolicy = action.output ?? policy.output ?? {};
      if (policy.record) {
        records.push({
          argv: [...invocation.argv],
          cwd: invocation.cwd,
          status,
          code: result.code,
          stdout: applyOutputPolicy(result.stdout, outputPolicy, invocation.env),
          stderr: applyOutputPolicy(result.stderr, outputPolicy, invocation.env),
          startedAt,
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - started
        });
      }
      return result;
    },
    records() {
      return records.map((record) => ({
        ...record,
        argv: [...record.argv]
      }));
    }
  };
}

interface MemoryTaskCacheEntry {
  result: TaskResult;
  outputFiles: string[];
}

const memoryCacheEntries = new Map<string, MemoryTaskCacheEntry>();

const DEFAULT_MAX_CONCURRENCY = 4;

interface ScheduledTaskResult {
  order: number;
  result: TaskResult;
}

interface ScheduledTaskExecution {
  taskId: string;
  failed: boolean;
  results: ScheduledTaskResult[];
  taskResult?: TaskResult;
}

export interface RunTarget {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  executor?: CommandExecutor;
  commands?: PipelineCommands;
  sandbox?: SandboxId | SandboxDefinition;
}

export interface RunOptions extends RunTarget {
  id: string;
  mode?: "manual" | "ci";
  concurrency?: number;
  force?: boolean;
  echo?: boolean;
}

export type RunSingleTaskOptions = Omit<RunOptions, "id">;

export async function runJob(pipeline: NormalizedPipeline, options: RunOptions): Promise<ExecutionRecord> {
  // Install before any task spawns so an early Ctrl-C still finalizes the record.
  ensureSignalForwarding();
  const context = resolveExecutionContext(pipeline, options);
  const store = await createStore(context.cwd);
  // One run at a time per project: concurrent runs would race on the task
  // cache, run records, and synced outputs. A lock whose holder process is
  // dead is reclaimed automatically.
  const lock = await acquireRunLock(store);
  try {
    return await runJobLocked(pipeline, options, context, store);
  } finally {
    await lock.release();
  }
}

async function runJobLocked(
  pipeline: NormalizedPipeline,
  options: RunOptions,
  context: ExecutionContext,
  store: PipelineStore
): Promise<ExecutionRecord> {
  const plan = await createRunPlan(pipeline, context.cwd, store);
  const graph = tasksForJob(plan.pipeline, options.id);
  const record: ExecutionRecord = {
    schemaVersion: 1,
    id: `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`,
    pipelineName: plan.pipeline.name,
    jobId: options.id,
    cwd: context.cwd,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    status: "running",
    mode: options.mode ?? (context.env.CI ? "ci" : "manual"),
    tasks: [],
    sources: Object.fromEntries(Object.entries(plan.sources).map(([sourceId, resolved]) => [sourceId, resolved.record]))
  };

  await writeExecution(store, record);
  const jobDefinition = plan.pipeline.jobs[options.id];
  const envDefinitions = {
    ...plan.pipeline.env,
    ...(jobDefinition?.env ?? {})
  };
  const taskFingerprints = new Map<string, string>();
  const concurrency = normalizeTaskConcurrency(options.concurrency);
  const graphIndex = new Map(graph.executionOrder.map((taskId, index) => [taskId, index]));
  const graphNodes = new Map(graph.tasks.map((node) => [node.id, node]));
  const runnableTaskIds = graph.executionOrder.filter((taskId) => Boolean(plan.pipeline.tasks[taskId]));
  const dependencyCounts = new Map<string, number>();
  const sourcePrepareOrder = new Map<string, number>();
  const recordedResults = new Map<string, { order: number; result: TaskResult }>();
  const sourcePreparePromises = new Map<string, Promise<TaskResult | null>>();
  const recordedPrepareSources = new Set<string>();

  for (const taskId of runnableTaskIds) {
    const taskDefinition = plan.pipeline.tasks[taskId];
    if (taskDefinition?.source?.name && !sourcePrepareOrder.has(taskDefinition.source.name)) {
      sourcePrepareOrder.set(taskDefinition.source.name, (graphIndex.get(taskId) ?? 0) - 0.25);
    }
    const node = graphNodes.get(taskId);
    dependencyCounts.set(taskId, (node?.dependsOn ?? []).filter((dependency) => Boolean(plan.pipeline.tasks[dependency])).length);
  }

  const ready = runnableTaskIds
    .filter((taskId) => dependencyCounts.get(taskId) === 0)
    .sort((left, right) => (graphIndex.get(left) ?? 0) - (graphIndex.get(right) ?? 0));
  const running = new Map<string, Promise<ScheduledTaskExecution>>();
  let failed = false;

  const updateRecord = async (): Promise<void> => {
    record.tasks = [...recordedResults.values()]
      .sort((left, right) => left.order - right.order || left.result.id.localeCompare(right.result.id))
      .map((entry) => entry.result);
    await writeExecution(store, record);
  };

  const ensureSourcePrepared = async (source: ResolvedSource): Promise<{ result: TaskResult | null; recordResult: boolean }> => {
    let promise = sourcePreparePromises.get(source.id);
    if (!promise) {
      promise = runSourcePrepare(source, {
        candidate: plan.candidate,
        executor: context.executor,
        rootCwd: context.cwd,
        runId: record.id,
        contextEnv: context.env,
        echo: options.echo,
        store
      });
      sourcePreparePromises.set(source.id, promise);
    }
    const result = await promise;
    const recordResult = Boolean(result && !recordedPrepareSources.has(source.id));
    if (recordResult) recordedPrepareSources.add(source.id);
    return { result, recordResult };
  };

  const runScheduledTask = async (taskId: string): Promise<ScheduledTaskExecution> => {
    const taskDefinition = plan.pipeline.tasks[taskId];
    if (!taskDefinition) return { taskId, failed: false, results: [] };

    const results: ScheduledTaskResult[] = [];
    const taskSource = taskDefinition.source?.name ? plan.sources[taskDefinition.source.name] : undefined;
    if (taskSource) {
      const prepare = await ensureSourcePrepared(taskSource);
      if (prepare.result && prepare.recordResult) {
        results.push({
          order: sourcePrepareOrder.get(taskSource.id) ?? ((graphIndex.get(taskId) ?? 0) - 0.25),
          result: prepare.result
        });
      }
      if (prepare.result?.status === "failed") {
        return { taskId, failed: true, results };
      }
    }

    const result = await runTask(plan.pipeline, taskDefinition, {
      candidate: plan.candidate,
      cwd: taskDefinition.source?.dir || context.cwd,
      executor: context.executor,
      rootCwd: context.cwd,
      runId: record.id,
      source: taskDefinition.source,
      envDefinitions,
      contextEnv: context.env,
      sourcePrepareCommands: taskSource ? await resolvePrepareCommands(taskSource, {
        candidate: plan.candidate,
        rootCwd: context.cwd,
        runId: record.id,
        contextEnv: context.env
      }) : [],
      dependencyFingerprints: Object.fromEntries(taskDefinition.dependsOn.map((dependency) => [
        dependency,
        taskFingerprints.get(dependency) ?? null
      ])),
      force: options.force,
      echo: options.echo,
      store
    });
    results.push({ order: graphIndex.get(taskId) ?? results.length, result });
    return { taskId, failed: result.status === "failed", results, taskResult: result };
  };

  const scheduleTask = (taskId: string): Promise<ScheduledTaskExecution> =>
    // The scheduler races these promises, so they must never reject: an
    // unexpected throw becomes a failed task result and the record finalizes.
    runScheduledTask(taskId).catch((error: unknown) => {
      const result: TaskResult = {
        id: taskId,
        status: "failed",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 0,
        attempts: 0,
        cacheHit: false,
        error: error instanceof Error ? error.message : String(error)
      };
      return {
        taskId,
        failed: true,
        results: [{ order: graphIndex.get(taskId) ?? 0, result }],
        taskResult: result
      };
    });

  try {
    while (ready.length > 0 || running.size > 0) {
      while (!failed && ready.length > 0 && running.size < concurrency) {
        const taskId = ready.shift();
        if (!taskId) break;
        running.set(taskId, scheduleTask(taskId));
      }

      if (running.size === 0) break;

      const completed = await Promise.race(running.values());
      running.delete(completed.taskId);

      for (const entry of completed.results) {
        recordedResults.set(entry.result.id, entry);
      }
      if (completed.taskResult) {
        taskFingerprints.set(completed.taskId, completed.taskResult.cacheKey ?? `${completed.taskId}:${completed.taskResult.status}`);
      }
      await updateRecord();

      if (completed.failed) {
        failed = true;
        ready.length = 0;
        continue;
      }

      if (failed || !completed.taskResult) continue;
      const node = graphNodes.get(completed.taskId);
      for (const dependent of node?.dependents ?? []) {
        if (!plan.pipeline.tasks[dependent]) continue;
        const remaining = Math.max(0, (dependencyCounts.get(dependent) ?? 0) - 1);
        dependencyCounts.set(dependent, remaining);
        if (remaining === 0) {
          ready.push(dependent);
        }
      }
      ready.sort((left, right) => (graphIndex.get(left) ?? 0) - (graphIndex.get(right) ?? 0));
    }
  } catch (error) {
    // Never leave an execution record stuck in "running" on disk.
    record.status = "failed";
    record.finishedAt = new Date().toISOString();
    await writeExecution(store, record).catch(() => {});
    throw error;
  }

  record.status = failed ? "failed" : "passed";
  record.finishedAt = new Date().toISOString();
  await writeExecution(store, record);
  return record;
}

export interface TaskPlanEntry {
  id: string;
  cacheEnabled: boolean;
  predicted: "run" | "cached" | "unknown";
  cacheKey?: string;
  reason?: string;
}

export interface JobPlan {
  jobId: string;
  executionOrder: string[];
  entries: TaskPlanEntry[];
}

/**
 * Computes the execution order and predicted cache behavior for a job without running it.
 * Predictions reuse the real cache-key chain but do not validate cached output files.
 */
export async function planJob(pipeline: NormalizedPipeline, options: { id: string } & RunTarget): Promise<JobPlan> {
  const context = resolveExecutionContext(pipeline, options);
  const store = await createStore(context.cwd);
  const plan = await createRunPlan(pipeline, context.cwd, store);
  const graph = tasksForJob(plan.pipeline, options.id);
  const jobDefinition = plan.pipeline.jobs[options.id];
  const envDefinitions = {
    ...plan.pipeline.env,
    ...(jobDefinition?.env ?? {})
  };
  const fingerprints = new Map<string, string | null>();
  const entries: TaskPlanEntry[] = [];

  for (const taskId of graph.executionOrder) {
    const taskDefinition = plan.pipeline.tasks[taskId];
    if (!taskDefinition) continue;
    try {
      const taskCwd = taskDefinition.source?.dir || context.cwd;
      const resolvedEnv = buildTaskEnv(context.env, {
        candidate: plan.candidate,
        envDefinitions,
        rootCwd: context.cwd,
        source: taskDefinition.source,
        taskId
      });
      const taskContext = createTaskContext(taskDefinition, {
        candidate: plan.candidate,
        cwd: taskCwd,
        env: resolvedEnv.env,
        metadata: {},
        rootCwd: context.cwd,
        runId: "dry-run",
        source: taskDefinition.source,
        writeLog() {}
      });
      const steps = await resolveTaskSteps(taskDefinition.steps, taskContext);
      const taskSource = taskDefinition.source?.name ? plan.sources[taskDefinition.source.name] : undefined;
      const prepareCommands = taskSource
        ? (await resolvePrepareCommands(taskSource, {
            candidate: plan.candidate,
            rootCwd: context.cwd,
            runId: "dry-run",
            contextEnv: context.env
          })).map((command) => command.command)
        : [];
      const cacheKey = await computeTaskCacheKey(plan.pipeline, taskDefinition, taskCwd, {
        candidate: plan.candidate,
        dependencyFingerprints: Object.fromEntries(taskDefinition.dependsOn.map((dependency) => [
          dependency,
          fingerprints.get(dependency) ?? null
        ])),
        prepareCommands,
        source: taskDefinition.source,
        steps
      });
      fingerprints.set(taskId, cacheKey);
      if (!taskDefinition.cache.enabled) {
        entries.push({ id: taskId, cacheEnabled: false, predicted: "run", cacheKey });
        continue;
      }
      const cached = await readTaskCacheEntry(taskDefinition, store, cacheKey);
      const fresh = cached?.status === "passed" && isCacheEntryFresh(cached, taskDefinition.cache.ttlMs);
      entries.push({
        id: taskId,
        cacheEnabled: true,
        predicted: fresh ? "cached" : "run",
        cacheKey,
        reason: fresh ? undefined : cached ? "stale or unusable cache entry" : "no cache entry"
      });
    } catch (error) {
      fingerprints.set(taskId, null);
      entries.push({
        id: taskId,
        cacheEnabled: taskDefinition.cache.enabled ?? false,
        predicted: "unknown",
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return { jobId: options.id, executionOrder: graph.executionOrder, entries };
}

export async function runSingleTask(pipeline: NormalizedPipeline, taskId: string, options: RunSingleTaskOptions = {}): Promise<ExecutionRecord> {
  const syntheticJobId = `task:${taskId}`;
  const syntheticPipeline: NormalizedPipeline = {
    ...pipeline,
    jobs: {
      ...pipeline.jobs,
      [syntheticJobId]: { id: syntheticJobId, target: [taskId], trigger: [] }
    }
  };
  return runJob(syntheticPipeline, { ...options, id: syntheticJobId });
}

async function runTask(
  pipeline: NormalizedPipeline,
  taskDefinition: NormalizedTask,
  options: {
    candidate: CandidateContext;
    cwd: string;
    executor: CommandExecutor;
    rootCwd: string;
    runId: string;
    source?: TaskSourceContext;
    envDefinitions: Record<string, EnvValue>;
    sourcePrepareCommands?: ShellCommand[];
    dependencyFingerprints?: Record<string, string | null>;
    force?: boolean;
    echo?: boolean;
    contextEnv: NodeJS.ProcessEnv;
    store: PipelineStore;
  }
): Promise<TaskResult> {
  const started = Date.now();
  const startedAt = new Date().toISOString();
  const metadata: Record<string, string | number | boolean | null> = {};
  const taskLog = cappedBuffer(resolveMaxLogBytes(options.contextEnv));
  let taskEnv: NodeJS.ProcessEnv;
  let envSecretValues: string[] = [];
  let forwardEnvKeys: string[] = [];
  try {
    const resolvedTaskEnv = buildTaskEnv(options.contextEnv, {
      candidate: options.candidate,
      envDefinitions: options.envDefinitions,
      rootCwd: options.rootCwd,
      source: options.source,
      taskId: taskDefinition.id
    });
    taskEnv = resolvedTaskEnv.env;
    envSecretValues = resolvedTaskEnv.secretValues;
    forwardEnvKeys = [...resolvedTaskEnv.definedKeys, ...(taskDefinition.requires?.secrets ?? [])];
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
      taskLog.append(`${message}\n`);
    }
  });
  const redactValues = [
    ...envSecretValues,
    ...(taskDefinition.requires?.secrets ?? [])
      .map((secret) => taskEnv[secret])
      .filter((value): value is string => typeof value === "string" && value.length > 0)
  ];
  const redactLog = (log: string): string => redactKnownValues(log, redactValues);
  const resolvedSteps = await resolveTaskSteps(taskDefinition.steps, context);
  const cacheKey = await computeTaskCacheKey(pipeline, taskDefinition, options.cwd, {
    candidate: options.candidate,
    dependencyFingerprints: options.dependencyFingerprints,
    prepareCommands: (options.sourcePrepareCommands ?? []).map((command) => command.command),
    source: options.source,
    steps: resolvedSteps
  });

  if (taskDefinition.cache.enabled && !options.force) {
    const cached = await readTaskCacheEntry(taskDefinition, options.store, cacheKey);
    if (cached?.status === "passed") {
      const cacheHit = await validateTaskCacheHit(taskDefinition, options.store, cacheKey, options.cwd, cached);
      if (cacheHit.ok) {
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
      taskLog.append(`[cache miss] ${cacheHit.reason}\n`);
    }
  }

  let attempts = 0;
  let lastError = "";

  const maxAttempts = Math.max(1, taskDefinition.retry.attempts);
  while (attempts < maxAttempts) {
    attempts += 1;
    try {
      for (const requirement of taskDefinition.requires?.tools ?? []) {
        const ok = await options.executor.checkTool?.(requirement);
        if (ok === false) {
          throw new Error(`Required tool "${requirement}" is not available for task "${taskDefinition.id}".`);
        }
      }

      for (const secret of taskDefinition.requires?.secrets ?? []) {
        if (!taskEnv[secret]) {
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
        const result = await runShellStep(step, taskDefinition, { executor: options.executor, cwd: options.cwd, env: taskEnv, echo: options.echo, redactValues, forwardEnvKeys });
        taskLog.append(result.stdout);
        taskLog.append(result.stderr);
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
      await writeTaskLog(options.store, options.runId, taskDefinition.id, redactLog(taskLog.read()));
      if (taskDefinition.cache.enabled) {
        await writeTaskCacheEntry(taskDefinition, options.store, cacheKey, result, options.cwd);
      }
      return result;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      taskLog.append(`[attempt ${attempts}] ${lastError}\n`);
      // Don't retry (or sleep through a retry delay) while shutting down;
      // the failure is the shutdown itself, not a flaky task.
      if (shutdownState) break;
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
  await writeTaskLog(options.store, options.runId, taskDefinition.id, redactLog(taskLog.read()));
  return result;
}

async function runShellStep(
  step: ShellCommand,
  taskDefinition: NormalizedTask,
  options: { executor: CommandExecutor; cwd: string; env: NodeJS.ProcessEnv; echo?: boolean; redactValues?: readonly string[]; forwardEnvKeys?: readonly string[] }
): Promise<CommandResult> {
  return options.executor.runShell(step.command, {
    cwd: options.cwd,
    env: options.env,
    task: taskDefinition,
    timeoutMs: taskDefinition.timeoutMs,
    echo: options.echo,
    redactValues: options.redactValues,
    forwardEnvKeys: options.forwardEnvKeys
  });
}

async function runSourcePrepare(
  source: ResolvedSource,
  options: { candidate: CandidateContext; executor: CommandExecutor; rootCwd: string; runId: string; contextEnv: NodeJS.ProcessEnv; echo?: boolean; store: PipelineStore }
): Promise<TaskResult | null> {
  if (source.definition.prepare.length === 0) return null;

  const started = Date.now();
  const startedAt = new Date().toISOString();
  const taskId = `${source.id}:prepare`;
  const sourceTaskContext = sourceContext(source);
  const log = cappedBuffer(resolveMaxLogBytes(options.contextEnv));
  const prepareEnv = buildTaskEnv(options.contextEnv, {
    candidate: options.candidate,
    rootCwd: options.rootCwd,
    source: sourceTaskContext
  });
  const context = createTaskContext({ id: taskId } as NormalizedTask, {
    candidate: options.candidate,
    cwd: source.dir,
    env: prepareEnv.env,
    metadata: {},
    rootCwd: options.rootCwd,
    runId: options.runId,
    source: sourceTaskContext,
    writeLog(message: string) {
      log.append(`${message}\n`);
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
      const result = await options.executor.runShell(step.command, {
        cwd: source.dir,
        env: prepareEnv.env,
        task: { id: taskId } as NormalizedTask,
        echo: options.echo,
        redactValues: prepareEnv.secretValues,
        forwardEnvKeys: prepareEnv.definedKeys
      });
      log.append(result.stdout);
      log.append(result.stderr);
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
    await writeTaskLog(options.store, options.runId, taskId, log.read());
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
    log.append(`[prepare] ${result.error}\n`);
    await writeTaskLog(options.store, options.runId, taskId, log.read());
    return result;
  }
}

async function resolvePrepareCommands(
  source: ResolvedSource,
  options: { candidate: CandidateContext; rootCwd: string; runId: string; contextEnv: NodeJS.ProcessEnv }
): Promise<ShellCommand[]> {
  const context = createTaskContext({ id: `${source.id}:prepare` } as NormalizedTask, {
    candidate: options.candidate,
    cwd: source.dir,
    env: buildTaskEnv(options.contextEnv, {
      candidate: options.candidate,
      rootCwd: options.rootCwd,
      source: sourceContext(source)
    }).env,
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

interface ResolvedTaskEnv {
  env: NodeJS.ProcessEnv;
  secretValues: string[];
  /** Pipeline-defined env keys plus ASYNC_PIPELINE_* context: the set isolating executors may forward. */
  definedKeys: string[];
}

function buildTaskEnv(
  baseEnv: NodeJS.ProcessEnv,
  options: { candidate: CandidateContext; envDefinitions?: Record<string, EnvValue>; rootCwd: string; source?: TaskSourceContext; taskId?: string }
): ResolvedTaskEnv {
  const { resolved: resolvedEnv, secretValues } = resolveEnvDefinitions(options.envDefinitions ?? {}, baseEnv, options.taskId);
  const contextEnv = {
    ASYNC_PIPELINE_ROOT_DIR: options.rootCwd,
    ASYNC_PIPELINE_CANDIDATE_DIR: options.candidate.dir,
    ASYNC_PIPELINE_CANDIDATE_FINGERPRINT: options.candidate.fingerprint,
    ASYNC_PIPELINE_SOURCE_NAME: options.source?.name,
    ASYNC_PIPELINE_SOURCE_DIR: options.source?.dir,
    ASYNC_PIPELINE_SOURCE_REF: options.source?.ref,
    ASYNC_PIPELINE_SOURCE_COMMIT: options.source?.commit
  };
  return {
    env: {
      ...baseEnv,
      ...resolvedEnv,
      ...contextEnv
    },
    secretValues,
    definedKeys: [...Object.keys(resolvedEnv), ...Object.keys(contextEnv), "CI"]
  };
}

function resolveEnvDefinitions(
  definitions: Record<string, EnvValue>,
  baseEnv: NodeJS.ProcessEnv,
  taskId = "unknown"
): { resolved: Record<string, string>; secretValues: string[] } {
  const resolved: Record<string, string> = {};
  const secretValues: string[] = [];
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
      secretValues.push(secretValue);
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
  return { resolved, secretValues };
}

function isShellCommand(step: TaskStep): step is ShellCommand {
  return typeof step !== "function" && step.kind === "shell";
}

async function readTaskCacheEntry(taskDefinition: NormalizedTask, store: PipelineStore, cacheKey: string): Promise<TaskResult | null> {
  const storeName = taskDefinition.cache.store ?? "file";
  if (storeName === "file") return readCacheEntry(store, cacheKey);
  if (storeName === "memory") return memoryCacheEntries.get(cacheKey)?.result ?? null;
  throw new Error(`Cache store "${storeName}" is registered but this runner cannot execute it. Use "file" or "memory", or provide a runtime-specific executor.`);
}

async function writeTaskCacheEntry(taskDefinition: NormalizedTask, store: PipelineStore, cacheKey: string, result: TaskResult, cwd: string): Promise<void> {
  const storeName = taskDefinition.cache.store ?? "file";
  if (storeName === "file") {
    await writeCacheEntry(store, cacheKey, result, {
      cwd,
      outputs: taskDefinition.outputs
    });
    return;
  }
  if (storeName === "memory") {
    memoryCacheEntries.set(cacheKey, {
      result,
      outputFiles: taskDefinition.outputs.length > 0 ? await resolveOutputFiles(cwd, taskDefinition.outputs) : []
    });
    return;
  }
  throw new Error(`Cache store "${storeName}" is registered but this runner cannot execute it. Use "file" or "memory", or provide a runtime-specific executor.`);
}

async function validateTaskCacheHit(
  taskDefinition: NormalizedTask,
  store: PipelineStore,
  cacheKey: string,
  cwd: string,
  cached: TaskResult
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!isCacheEntryFresh(cached, taskDefinition.cache.ttlMs)) {
    return { ok: false, reason: "cache entry expired or has an invalid timestamp" };
  }

  if (taskDefinition.outputs.length === 0) return { ok: true };

  const storeName = taskDefinition.cache.store ?? "file";
  if (storeName === "file") {
    const restored = await restoreCacheOutputs(store, cacheKey, cwd, taskDefinition.outputs);
    return restored
      ? { ok: true }
      : { ok: false, reason: "declared outputs were not available in the file cache" };
  }

  if (storeName === "memory") {
    const entry = memoryCacheEntries.get(cacheKey);
    if (!entry) return { ok: false, reason: "memory cache entry was not available" };
    const outputsExist = await outputFilesExist(cwd, entry.outputFiles);
    return outputsExist
      ? { ok: true }
      : { ok: false, reason: "declared outputs were missing from the working tree" };
  }

  return { ok: false, reason: `cache store "${storeName}" is not executable by this runner` };
}

function isCacheEntryFresh(cached: TaskResult, ttlMs: number | undefined): boolean {
  if (ttlMs === undefined) return true;
  if (!Number.isFinite(ttlMs) || ttlMs < 0) return false;
  const finishedAtMs = cached.finishedAt ? Date.parse(cached.finishedAt) : Number.NaN;
  return Number.isFinite(finishedAtMs) && Date.now() - finishedAtMs <= ttlMs;
}

function normalizeTaskConcurrency(concurrency: number | undefined): number {
  if (concurrency === undefined) return Math.max(1, Math.min(DEFAULT_MAX_CONCURRENCY, availableParallelism()));
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("Task concurrency must be a positive integer.");
  }
  return concurrency;
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

// Track live task processes so terminal signals terminate the whole run.
// detached children live in their own process groups and would otherwise
// survive Ctrl-C on the CLI.
const activeKillers = new Set<(signal: NodeJS.Signals) => void>();
const installedSignalForwarders = new Set<NodeJS.Signals>();
let shutdownState: { signal: NodeJS.Signals; exitCode: number } | null = null;

const SHUTDOWN_ESCALATE_DELAY_MS = 500;
const SHUTDOWN_EXIT_DEADLINE_MS = 10_000;

/**
 * Abort the run: terminate every live task process group (SIGTERM-style
 * signal first, SIGKILL after a grace period), refuse to start new task
 * processes, and hard-exit if the run has not finalized its execution
 * record by the deadline. Idempotent; the first caller wins.
 */
export function beginShutdown(signal: NodeJS.Signals, exitCode: number): void {
  if (shutdownState) return;
  shutdownState = { signal, exitCode };
  for (const kill of activeKillers) kill(signal);
  const escalate = setTimeout(() => {
    for (const kill of activeKillers) kill("SIGKILL");
  }, SHUTDOWN_ESCALATE_DELAY_MS);
  escalate.unref();
  const deadline = setTimeout(() => process.exit(exitCode), SHUTDOWN_EXIT_DEADLINE_MS);
  deadline.unref();
}

/** Exit code requested by an in-progress shutdown, if any. */
export function shutdownExitCode(): number | null {
  return shutdownState ? shutdownState.exitCode : null;
}

function ensureSignalForwarding(): void {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    if (installedSignalForwarders.has(signal)) continue;
    installedSignalForwarders.add(signal);
    process.once(signal, () => {
      // 128 + signal number, the conventional interrupted-exit status.
      const exitCode = signal === "SIGINT" ? 130 : 143;
      beginShutdown(signal, exitCode);
      process.exitCode = exitCode;
      // Stay alive so the dead tasks surface as failures and the execution
      // record is finalized instead of being left "running". A second
      // signal or the shutdown deadline exits immediately.
      process.once(signal, () => process.exit(exitCode));
    });
  }
}

const DEFAULT_MAX_LOG_BYTES = 8 * 1024 * 1024;

function resolveMaxLogBytes(env: NodeJS.ProcessEnv): number {
  const raw = env.ASYNC_PIPELINE_MAX_LOG_BYTES ?? process.env.ASYNC_PIPELINE_MAX_LOG_BYTES;
  if (raw === undefined || raw === "") return DEFAULT_MAX_LOG_BYTES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_MAX_LOG_BYTES;
  return parsed === 0 ? Number.POSITIVE_INFINITY : Math.max(parsed, 4096);
}

interface CappedBuffer {
  append(chunk: string): void;
  read(): string;
}

/** Keeps the byte-accurate tail of a stream bounded so huge task output cannot exhaust memory. */
function cappedBuffer(maxBytes: number): CappedBuffer {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  let dropped = 0;
  return {
    append(chunk: string): void {
      const buffer = Buffer.from(chunk, "utf8");
      chunks.push(buffer);
      byteLength += buffer.byteLength;
      while (byteLength > maxBytes) {
        const head = chunks[0];
        if (!head) break;
        const excess = byteLength - maxBytes;
        if (head.byteLength <= excess) {
          chunks.shift();
          byteLength -= head.byteLength;
          dropped += head.byteLength;
        } else {
          chunks[0] = head.subarray(excess);
          byteLength -= excess;
          dropped += excess;
        }
      }
    },
    read(): string {
      const text = Buffer.concat(chunks).toString("utf8");
      if (dropped === 0) return text;
      return `[async-pipeline] output truncated: dropped ${dropped} leading bytes (ASYNC_PIPELINE_MAX_LOG_BYTES).\n${text}`;
    }
  };
}

function runProcess(
  command: string,
  options: { cwd: string; env: NodeJS.ProcessEnv; echo?: boolean; timeoutMs?: number; label?: string; redactValues?: readonly string[] }
): Promise<CommandResult> {
  return new Promise((resolve) => {
    if (shutdownState) {
      // The run is shutting down (signal or closed output pipe): fail fast
      // instead of spawning processes that would immediately be killed.
      resolve({ code: 1, stdout: "", stderr: `[interrupted] Run is shutting down (${shutdownState.signal}); not starting: ${options.label ?? command}\n` });
      return;
    }
    // detached puts the shell in its own process group on POSIX so a timeout
    // can terminate the whole tree, not only the wrapping shell.
    const detached = process.platform !== "win32";
    const child = spawn(command, {
      cwd: options.cwd,
      env: options.env,
      shell: true,
      detached,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const maxLogBytes = resolveMaxLogBytes(options.env);
    const stdout = cappedBuffer(maxLogBytes);
    const stderr = cappedBuffer(maxLogBytes);
    let timedOut = false;
    let timeout: NodeJS.Timeout | undefined;
    let forceKillTimeout: NodeJS.Timeout | undefined;
    const redactValues = options.redactValues ?? [];
    const echoStdout = createEchoWriter(process.stdout, options.label, redactValues);
    const echoStderr = createEchoWriter(process.stderr, options.label, redactValues);
    const killTree = (signal: NodeJS.Signals): void => {
      if (detached && child.pid) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // Fall through to killing the direct child.
        }
      }
      child.kill(signal);
    };
    activeKillers.add(killTree);
    ensureSignalForwarding();

    if (options.timeoutMs) {
      timeout = setTimeout(() => {
        timedOut = true;
        killTree("SIGTERM");
        forceKillTimeout = setTimeout(() => killTree("SIGKILL"), 500);
      }, options.timeoutMs);
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout.append(chunk);
      if (options.echo !== false) echoStdout.write(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr.append(chunk);
      if (options.echo !== false) echoStderr.write(chunk);
    });
    child.on("close", (code) => {
      activeKillers.delete(killTree);
      if (timeout) clearTimeout(timeout);
      if (forceKillTimeout) clearTimeout(forceKillTimeout);
      if (options.echo !== false) {
        echoStdout.flush();
        echoStderr.flush();
      }
      const finalStdout = redactKnownValues(stdout.read(), redactValues);
      const finalStderr = redactKnownValues(stderr.read(), redactValues);
      if (timedOut) {
        const timeoutMessage = `[timeout] Command timed out after ${options.timeoutMs}ms.\n`;
        resolve({ code: 124, stdout: finalStdout, stderr: `${finalStderr}${timeoutMessage}`, timedOut: true });
        return;
      }
      resolve({ code: code ?? 1, stdout: finalStdout, stderr: finalStderr });
    });
  });
}

interface EchoWriter {
  write(chunk: string): void;
  flush(): void;
}

function createEchoWriter(stream: NodeJS.WriteStream, label: string | undefined, redactValues: readonly string[]): EchoWriter {
  let buffered = "";
  const prefix = label ? `[${label}] ` : "";
  const writeLine = (line: string): void => {
    stream.write(`${prefix}${redactKnownValues(line, redactValues)}\n`);
  };
  return {
    write(chunk: string): void {
      buffered += chunk;
      const lastNewline = buffered.lastIndexOf("\n");
      if (lastNewline < 0) return;
      for (const line of buffered.slice(0, lastNewline).split("\n")) writeLine(line);
      buffered = buffered.slice(lastNewline + 1);
    },
    flush(): void {
      if (!buffered) return;
      writeLine(buffered);
      buffered = "";
    }
  };
}

const MIN_REDACTED_VALUE_LENGTH = 4;

function redactKnownValues(output: string, values: readonly string[]): string {
  let redacted = output;
  for (const value of [...new Set(values)].sort((left, right) => right.length - left.length)) {
    if (!value || value.length < MIN_REDACTED_VALUE_LENGTH) continue;
    redacted = redacted.split(value).join("[redacted]");
  }
  return redacted;
}

function matchingAction(policy: CommandPolicy, argv: string[]): CommandAction {
  for (const rule of policy.rules) {
    if (matchesCommandRule(rule, argv)) return rule.action;
  }
  return policy.fallback ?? { kind: "async-pipeline.command.allow" };
}

function matchesCommandRule(rule: { exact?: string[]; prefix?: string[] }, argv: string[]): boolean {
  if (rule.exact && sameArgs(rule.exact, argv)) return true;
  if (rule.prefix && hasPrefix(argv, rule.prefix)) return true;
  return false;
}

function sameArgs(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => right[index] === value);
}

function hasPrefix(argv: string[], prefix: string[]): boolean {
  return prefix.length <= argv.length && prefix.every((value, index) => argv[index] === value);
}

function commandStatus(action: CommandAction): CommandPolicyStatus {
  if (action.kind === "async-pipeline.command.mock") return "mocked";
  if (action.kind === "async-pipeline.command.deny") return "denied";
  if (action.kind === "async-pipeline.command.requireApproval") return "approval-required";
  return "allowed";
}

async function runCommandAction(action: CommandAction, invocation: CommandInvocation, next: () => Promise<CommandResult>): Promise<CommandResult> {
  if (action.kind === "async-pipeline.command.allow") return next();
  if (action.kind === "async-pipeline.command.requireEnvironment") {
    const current = invocation.env.ASYNC_PIPELINE_ENVIRONMENT;
    if (current === action.name) return next();
    return {
      code: 1,
      stdout: "",
      stderr: `Command requires environment "${action.name}" (current: ${current ? `"${current}"` : "unset"}). Set ASYNC_PIPELINE_ENVIRONMENT to allow it.\n`
    };
  }
  if (action.kind === "async-pipeline.command.mock") {
    return {
      code: action.code ?? 0,
      stdout: action.stdout ?? "",
      stderr: action.stderr ?? ""
    };
  }
  if (action.kind === "async-pipeline.command.deny") {
    return {
      code: 1,
      stdout: "",
      stderr: `${action.message ?? "Command denied by async-pipeline command policy."}\n`
    };
  }
  return {
    code: 1,
    stdout: "",
    stderr: `${action.message ?? "Command requires approval by async-pipeline command policy."}\n`
  };
}

function applyOutputPolicy(output: string, policy: CommandOutputPolicy, env: NodeJS.ProcessEnv): string {
  let next = policy.redactSecrets ? redactSecretValues(output, env) : output;
  const maxBytes = policy.maxBytes;
  if (maxBytes === undefined || Buffer.byteLength(next, "utf8") <= maxBytes) return next;
  const truncated = Buffer.from(next).subarray(0, maxBytes).toString("utf8");
  return `${truncated}\n[async-pipeline] output truncated to ${maxBytes} bytes\n`;
}

function redactSecretValues(output: string, env: NodeJS.ProcessEnv): string {
  let redacted = output;
  for (const [key, value] of Object.entries(env)) {
    if (!value || value.length < 4 || !/(SECRET|TOKEN|PASSWORD|AUTH|KEY)/i.test(key)) continue;
    redacted = redacted.split(value).join("[redacted]");
  }
  return redacted;
}

function shellEscape(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
