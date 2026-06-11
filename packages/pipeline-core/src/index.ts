import {
  assertCacheStore,
  defaultPipelineCache,
  defineCache,
  isCacheDirective,
  mergeWithDefaultCacheStores,
  parseCacheRef,
  type CacheDirective,
  type CachePolicy,
  type CacheRef,
  type CacheRegistryDefinition,
  type CacheRegistryInput,
  type CacheUseOptions
} from "./cache.js";
import { pipelineError } from "./errors.js";

export * from "./cache.js";
export * from "./errors.js";

export type TaskId = string;
export type JobId = string;
export type TriggerId = string;
export type SourceId = string;
export type SandboxId = string;
export type SourceType = "git" | "path";
export type ExecutionMode = "manual" | "ci";
export type CacheSharing = "shared" | "private" | "locked";
export type TaskStatus = "pending" | "running" | "passed" | "failed" | "skipped" | "cached";
export type EnvVarMap = Record<string, string>;
export type EnvValue = string | EnvSecretRef | EnvVarRef;
export type SandboxKind = "host" | "lima" | "docker";

export interface ShellCommand {
  kind: "shell";
  command: string;
}

export type DeferredShellCommandFactory = (context: TaskContext) => ShellCommand | Promise<ShellCommand>;

export interface DeferredShellCommand {
  kind: "deferred-shell";
  command: DeferredShellCommandFactory;
}

export type TaskRunFunction = (context: TaskContext) => void | Promise<void>;
export type TaskStep = ShellCommand | DeferredShellCommand | TaskRunFunction;

export interface CandidateContext {
  dir: string;
  fingerprint: string;
  commit?: string;
  ref?: string;
  dirty?: boolean;
}

export interface TaskSourceContext {
  name: SourceId;
  dir: string;
  type: SourceType;
  ref?: string;
  commit?: string;
}

export interface TaskContext {
  taskId: TaskId;
  runId: string;
  cwd: string;
  env: Record<string, string | undefined>;
  root: {
    dir: string;
  };
  candidate: CandidateContext;
  source?: TaskSourceContext;
  meta(metadata: Record<string, string | number | boolean | null>): void;
  log(message: string): void;
  sh: typeof sh;
}

export interface RetryPolicy {
  attempts: number;
  delayMs?: number;
}

export interface CacheDirectory {
  path: string;
  sharing?: CacheSharing;
}

export interface TaskCacheOptions {
  enabled?: boolean;
  directories?: CacheDirectory[];
  ref?: CacheRef;
  store?: string;
  policy?: CachePolicy;
  ttlMs?: number;
  key?: unknown;
}

export interface TaskRequirements {
  tools?: string[];
  secrets?: string[];
  runtime?: "node" | "deno" | "shell";
}

export type JobEnvironment = string | {
  name: string;
  url?: string;
};

export interface JobRequirements {
  provenance?: boolean;
}

export interface SandboxVolume {
  source: string;
  target: string;
  readonly?: boolean;
}

export interface HostSandboxDefinition {
  kind: "host";
}

export interface LimaSandboxDefinition {
  kind: "lima";
  vm?: string;
}

export interface DockerSandboxDefinition {
  kind: "docker";
  image: string;
  workdir?: string;
  volumes?: SandboxVolume[];
}

export type SandboxDefinition =
  | HostSandboxDefinition
  | LimaSandboxDefinition
  | DockerSandboxDefinition;

export interface CommandOutputPolicy {
  maxBytes?: number;
  redactSecrets?: boolean;
}

export type CommandAction =
  | { kind: "async-pipeline.command.allow"; output?: CommandOutputPolicy }
  | { kind: "async-pipeline.command.deny"; message?: string; output?: CommandOutputPolicy }
  | { kind: "async-pipeline.command.mock"; code?: number; stdout?: string; stderr?: string; output?: CommandOutputPolicy }
  | { kind: "async-pipeline.command.requireApproval"; message?: string; output?: CommandOutputPolicy }
  | { kind: "async-pipeline.command.requireEnvironment"; name: string; output?: CommandOutputPolicy };

export interface CommandRule {
  exact?: string[];
  prefix?: string[];
  action: CommandAction;
}

export interface CommandPolicy {
  rules: CommandRule[];
  fallback?: CommandAction;
  record?: boolean;
  output?: CommandOutputPolicy;
  shims?: string[];
}

export interface EnvSecretRef {
  kind: "async-pipeline.env.secret";
  name: string;
}

export interface EnvVarRef {
  kind: "async-pipeline.env.var";
  name: string;
  values?: EnvVarMap;
  default?: string;
}

export interface TriggerDefinition {
  type: "manual" | "github" | "schedule";
  events?: string[];
  cron?: string;
  branches?: string[];
  paths?: string[];
  tags?: string[];
  timezone?: string;
}

export type SyncRunner = "package" | "deno";
export type SyncSelection = "all" | string[];
export type SyncTargetSelector = { package: string; allowMultiple?: boolean } | { path: string; allowMultiple?: boolean };
export type SyncTargets = "root" | SyncTargetSelector[];

export interface GitHubSyncConfig {
  workflow?: string;
  lock?: string;
  nodeVersion?: number | string;
  cache?: boolean;
}

export type GitHubSyncInput = boolean | GitHubSyncConfig;

export interface TaskSyncConfig {
  prefix?: string;
  runners?: "all" | SyncRunner[];
  targets?: SyncTargets;
  jobs?: SyncSelection;
  tasks?: SyncSelection;
  scripts?: Record<string, string>;
}

export type TaskSyncInput = boolean | TaskSyncConfig;

export interface PipelineSyncConfig {
  github?: GitHubSyncInput;
  tasks?: TaskSyncInput;
}

export interface NormalizedGitHubSyncConfig {
  enabled: boolean;
  workflow: string;
  lock: string;
  nodeVersion: string;
  cache: boolean;
}

export interface NormalizedTaskSyncConfig {
  enabled: boolean;
  prefix: string;
  runners: "all" | SyncRunner[];
  targets: SyncTargets;
  jobs: SyncSelection;
  tasks?: SyncSelection;
  scripts: Record<string, string>;
}

export interface NormalizedPipelineSync {
  github: NormalizedGitHubSyncConfig;
  tasks: NormalizedTaskSyncConfig;
}

export interface DependsOnDirective {
  kind: "async-pipeline.directive.dependsOn";
  taskIds: TaskId[];
}

export type TaskDirective = CacheDirective | DependsOnDirective;

export interface TaskDefinition {
  description?: string;
  dependsOn?: TaskId[];
  inputs?: string[];
  outputs?: string[];
  cache?: boolean | CacheRef | TaskCacheOptions;
  retry?: number | RetryPolicy;
  timeout?: string | number;
  requires?: TaskRequirements;
  run?: TaskRunDefinition;
  steps?: TaskRunItem[];
}

export type TaskRunItem = TaskStep | TaskDirective;
export type TaskRunDefinition = TaskRunItem | readonly TaskRunItem[];

export interface NormalizedTask extends Omit<TaskDefinition, "dependsOn" | "steps" | "run"> {
  id: TaskId;
  dependsOn: TaskId[];
  steps: TaskStep[];
  cache: TaskCacheOptions;
  retry: RetryPolicy;
  timeoutMs?: number;
  inputs: string[];
  outputs: string[];
  source?: TaskSourceContext;
}

export interface SourceBaseDefinition {
  pipeline?: string;
  prepare?: TaskStep[];
}

export interface GitSourceDefinition extends SourceBaseDefinition {
  type: "git";
  url: string;
  ref: string;
}

export interface PathSourceDefinition extends SourceBaseDefinition {
  type: "path";
  path: string;
  writable?: boolean;
}

export type SourceDefinition = GitSourceDefinition | PathSourceDefinition;

export type NormalizedSource =
  | (Omit<GitSourceDefinition, "prepare" | "pipeline"> & {
    id: SourceId;
    pipeline: string;
    prepare: TaskStep[];
  })
  | (Omit<PathSourceDefinition, "prepare" | "pipeline"> & {
    id: SourceId;
    pipeline: string;
    prepare: TaskStep[];
  });

export interface JobDefinition {
  description?: string;
  target: TaskId | TaskId[];
  trigger?: TriggerId[];
  environment?: JobEnvironment;
  env?: Record<string, EnvValue>;
  requires?: JobRequirements;
  github?: GitHubJobConfig;
}

export interface NormalizedJob extends Omit<JobDefinition, "target" | "trigger"> {
  id: JobId;
  target: TaskId[];
  trigger: TriggerId[];
}

export type GitHubPermission = "read" | "write" | "none";

export interface GitHubJobConfig {
  environment?: string;
  permissions?: {
    contents?: GitHubPermission;
    idToken?: "write" | "none";
  };
  /**
   * Runner for the generated GitHub Actions job. A string targets a hosted
   * runner ("ubuntu-latest"); a string array is a self-hosted label set that
   * a single runner must match entirely (["self-hosted", "macos", "tart"]).
   */
  runsOn?: string | string[];
  /**
   * Run the generated job once per entry through a GitHub Actions matrix.
   * Each entry follows the `runsOn` shape. Mutually exclusive with `runsOn`.
   */
  runsOnMatrix?: Array<string | string[]>;
}

export interface PipelineDefinition {
  name: string;
  env?: Record<string, EnvValue>;
  commands?: CommandPolicy;
  sandboxes?: Record<SandboxId, SandboxDefinition>;
  cache?: CacheRef | CacheRegistryDefinition | CacheRegistryInput | false;
  namedInputs?: Record<string, string[]>;
  taskDefaults?: Record<string, Partial<TaskDefinition>>;
  triggers?: Record<TriggerId, TriggerDefinition>;
  sync?: PipelineSyncConfig;
  sources?: Record<SourceId, SourceDefinition>;
  tasks: Record<TaskId, TaskDefinition>;
  jobs: Record<JobId, JobDefinition>;
}

export interface NormalizedPipeline {
  name: string;
  env: Record<string, EnvValue>;
  commands?: CommandPolicy;
  sandboxes: Record<SandboxId, SandboxDefinition>;
  cache: CacheRegistryDefinition;
  namedInputs: Record<string, string[]>;
  triggers: Record<TriggerId, TriggerDefinition>;
  sync: NormalizedPipelineSync;
  sources: Record<SourceId, NormalizedSource>;
  tasks: Record<TaskId, NormalizedTask>;
  jobs: Record<JobId, NormalizedJob>;
}

export interface TaskResult {
  /** Present on stored cache entries; absent inside in-memory results. */
  schemaVersion?: number;
  id: TaskId;
  status: TaskStatus;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  attempts: number;
  cacheKey?: string;
  cacheHit?: boolean;
  error?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface ExecutionRecord {
  /** Record format version. Consumers should ignore fields they do not know. */
  schemaVersion: number;
  id: string;
  pipelineName: string;
  jobId: JobId;
  cwd: string;
  /** Pid of the process that owns this run; used to detect crashed runs. */
  pid?: number;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "passed" | "failed";
  mode: ExecutionMode;
  tasks: TaskResult[];
  sources?: Record<SourceId, ExecutionSourceRecord>;
}

export interface ExecutionSourceRecord {
  id: SourceId;
  type: SourceType;
  dir: string;
  pipeline: string;
  url?: string;
  path?: string;
  ref?: string;
  commit?: string;
  dirty?: boolean;
  prepare?: string[];
}

export interface TaskGraphNode {
  id: TaskId;
  dependsOn: TaskId[];
  dependents: TaskId[];
}

export interface PipelineGraph {
  tasks: TaskGraphNode[];
  executionOrder: TaskId[];
}

export interface ParsedTaskRef {
  source?: SourceId;
  taskId: TaskId;
}

export interface ComposeSourcePipeline {
  pipeline: NormalizedPipeline;
  context?: TaskSourceContext;
}

export function sh(factory: DeferredShellCommandFactory): DeferredShellCommand;
export function sh(strings: TemplateStringsArray, ...values: unknown[]): ShellCommand;
export function sh(first: TemplateStringsArray | DeferredShellCommandFactory, ...values: unknown[]): ShellCommand | DeferredShellCommand {
  if (typeof first === "function") {
    return { kind: "deferred-shell", command: first };
  }

  let command = "";
  for (let index = 0; index < first.length; index += 1) {
    command += first[index] ?? "";
    if (index < values.length) {
      command += String(values[index]);
    }
  }
  return { kind: "shell", command };
}

export function task(definition: TaskDefinition): TaskDefinition;
export function task(definition: TaskDefinition, run: TaskRunDefinition): TaskDefinition;
export function task(definition: TaskDefinition, run?: TaskRunDefinition): TaskDefinition {
  if (definition.run !== undefined && run !== undefined) {
    throw pipelineError("ASYNC_PIPELINE_TASK_ARGUMENT_CONFLICT", "Do not pass a second task argument when config.run is defined.");
  }
  return run === undefined ? definition : { ...definition, run };
}

export function job(definition: JobDefinition): JobDefinition {
  return definition;
}

function envVar(name: string): EnvVarRef;
function envVar(name: string, options: { default: string }): EnvVarRef;
function envVar(name: string, values: EnvVarMap, options?: { default?: string }): EnvVarRef;
function envVar(name: string, valuesOrOptions?: EnvVarMap | { default: string }, options: { default?: string } = {}): EnvVarRef {
  if (!valuesOrOptions) return { kind: "async-pipeline.env.var", name };
  if (isDefaultOnlyEnvOptions(valuesOrOptions) && Object.keys(valuesOrOptions).length === 1) {
    return { kind: "async-pipeline.env.var", name, default: valuesOrOptions.default };
  }
  return {
    kind: "async-pipeline.env.var",
    name,
    values: { ...valuesOrOptions },
    default: options.default
  };
}

export const env = {
  secret(name: string): EnvSecretRef {
    return { kind: "async-pipeline.env.secret", name };
  },
  var: envVar
};

export const sandbox = {
  host(): HostSandboxDefinition {
    return { kind: "host" };
  },
  lima(options: Omit<LimaSandboxDefinition, "kind"> = {}): LimaSandboxDefinition {
    return { kind: "lima", vm: options.vm };
  },
  docker(options: Omit<DockerSandboxDefinition, "kind">): DockerSandboxDefinition {
    return {
      kind: "docker",
      image: options.image,
      workdir: options.workdir,
      volumes: options.volumes ? options.volumes.map((volume) => ({ ...volume })) : undefined
    };
  }
};

export const command = {
  policy(options: Omit<CommandPolicy, "rules"> & { rules?: CommandRule[] } = {}): CommandPolicy {
    return {
      rules: options.rules ? options.rules.map(cloneCommandRule) : [],
      fallback: options.fallback ? cloneCommandAction(options.fallback) : undefined,
      record: options.record,
      output: options.output ? { ...options.output } : undefined,
      shims: options.shims ? [...options.shims] : undefined
    };
  },
  rule(options: CommandRule): CommandRule {
    return cloneCommandRule(options);
  },
  allow(options: { output?: CommandOutputPolicy } = {}): CommandAction {
    return { kind: "async-pipeline.command.allow", output: options.output ? { ...options.output } : undefined };
  },
  deny(options: { message?: string; output?: CommandOutputPolicy } = {}): CommandAction {
    return { kind: "async-pipeline.command.deny", message: options.message, output: options.output ? { ...options.output } : undefined };
  },
  mock(options: { code?: number; stdout?: string; stderr?: string; output?: CommandOutputPolicy } = {}): CommandAction {
    return {
      kind: "async-pipeline.command.mock",
      code: options.code,
      stdout: options.stdout,
      stderr: options.stderr,
      output: options.output ? { ...options.output } : undefined
    };
  },
  requireApproval(options: { message?: string; output?: CommandOutputPolicy } = {}): CommandAction {
    return { kind: "async-pipeline.command.requireApproval", message: options.message, output: options.output ? { ...options.output } : undefined };
  },
  requireEnvironment(options: { name: string; output?: CommandOutputPolicy }): CommandAction {
    return { kind: "async-pipeline.command.requireEnvironment", name: options.name, output: options.output ? { ...options.output } : undefined };
  }
};

export const trigger = {
  manual(): TriggerDefinition {
    return { type: "manual" };
  },
  github(options: { events: string[]; branches?: string[]; paths?: string[]; tags?: string[] }): TriggerDefinition {
    return {
      type: "github",
      events: [...options.events],
      branches: options.branches ? [...options.branches] : undefined,
      paths: options.paths ? [...options.paths] : undefined,
      tags: options.tags ? [...options.tags] : undefined
    };
  },
  cron(cron: string, options: { timezone?: string } = {}): TriggerDefinition {
    return { type: "schedule", cron, timezone: options.timezone };
  },
  schedule(cron: string): TriggerDefinition {
    return { type: "schedule", cron };
  }
};

export function dependsOn(...taskIds: TaskId[]): DependsOnDirective {
  return { kind: "async-pipeline.directive.dependsOn", taskIds };
}

export const source = {
  git(definition: Omit<GitSourceDefinition, "type">): GitSourceDefinition {
    return { ...definition, type: "git" };
  },
  path(definition: Omit<PathSourceDefinition, "type">): PathSourceDefinition {
    return { ...definition, type: "path" };
  }
};

const PIPELINE_FIELDS = new Set(["name", "env", "commands", "sandboxes", "cache", "namedInputs", "taskDefaults", "triggers", "sync", "sources", "tasks", "jobs"]);
const TASK_FIELDS = new Set(["description", "dependsOn", "inputs", "outputs", "cache", "retry", "timeout", "requires", "run", "steps"]);
const JOB_FIELDS = new Set(["description", "target", "trigger", "environment", "env", "requires", "github"]);
const GITHUB_JOB_FIELDS = new Set(["environment", "permissions", "runsOn", "runsOnMatrix"]);

function rejectUnknownFields(known: Set<string>, value: object, where: string): void {
  for (const key of Object.keys(value)) {
    if (!known.has(key)) {
      throw pipelineError(
        "ASYNC_PIPELINE_UNKNOWN_FIELD",
        `${where} has unknown field "${key}". Known fields: ${[...known].sort().join(", ")}. Unknown fields are rejected because a typo that is silently ignored changes behavior without warning.`
      );
    }
  }
}

/**
 * AGENTS.md rule 3, made executable: every config field is enforced or
 * rejected. Unknown keys (typos, stale API) fail loudly at definePipeline
 * time instead of silently changing behavior.
 */
function validateDefinitionShape(definition: PipelineDefinition): void {
  rejectUnknownFields(PIPELINE_FIELDS, definition, "Pipeline");
  for (const [id, taskDefinition] of Object.entries(definition.tasks ?? {})) {
    rejectUnknownFields(TASK_FIELDS, taskDefinition, `Task "${id}"`);
  }
  for (const [id, defaults] of Object.entries(definition.taskDefaults ?? {})) {
    rejectUnknownFields(TASK_FIELDS, defaults, `taskDefaults["${id}"]`);
  }
  for (const [id, jobDefinition] of Object.entries(definition.jobs ?? {})) {
    rejectUnknownFields(JOB_FIELDS, jobDefinition, `Job "${id}"`);
    if (jobDefinition.github) {
      rejectUnknownFields(GITHUB_JOB_FIELDS, jobDefinition.github, `Job "${id}" github config`);
    }
  }
}

export function definePipeline(definition: PipelineDefinition): NormalizedPipeline {
  return normalizePipeline(definition);
}

export function normalizePipeline(definition: PipelineDefinition): NormalizedPipeline {
  validateDefinitionShape(definition);
  const namedInputs = definition.namedInputs ?? {};
  const cacheRegistry = normalizeCacheRegistry(definition.cache);
  const sources: Record<SourceId, NormalizedSource> = {};

  for (const [id, sourceDefinition] of Object.entries(definition.sources ?? {})) {
    validateSourceId(id);
    sources[id] = normalizeSource(id, sourceDefinition);
  }

  const tasks: Record<TaskId, NormalizedTask> = {};

  for (const [id, taskDefinition] of Object.entries(definition.tasks)) {
    validateLocalTaskId(id);
    const defaults = definition.taskDefaults?.[id] ?? definition.taskDefaults?.[taskName(id)] ?? {};
    const merged = { ...defaults, ...taskDefinition };
    const runItems = merged.steps ? [...merged.steps] : runItemsFromDefinition(merged.run);
    const { steps, cacheDirectives, dependsOnDirectives } = partitionRunItems(runItems);
    const liftedDependsOn = uniqueTaskIds([
      ...(merged.dependsOn ?? []),
      ...dependsOnDirectives.flatMap((directive) => directive.taskIds)
    ]);
    const cache = normalizeCache(merged.cache ?? cacheDirectives[0], cacheRegistry);
    const retry = normalizeRetry(merged.retry);
    const timeoutMs = normalizeTimeout(merged.timeout);

    tasks[id] = {
      ...merged,
      id,
      dependsOn: liftedDependsOn,
      inputs: [...(merged.inputs ?? [])],
      outputs: [...(merged.outputs ?? [])],
      steps,
      cache,
      retry,
      timeoutMs
    };
  }

  const jobs: Record<JobId, NormalizedJob> = {};
  for (const [id, jobDefinition] of Object.entries(definition.jobs)) {
    jobs[id] = {
      ...jobDefinition,
      id,
      target: Array.isArray(jobDefinition.target) ? [...jobDefinition.target] : [jobDefinition.target],
      trigger: [...(jobDefinition.trigger ?? [])]
    };
  }

  const pipeline: NormalizedPipeline = {
    name: definition.name,
    env: { ...(definition.env ?? {}) },
    commands: definition.commands ? normalizeCommandPolicy(definition.commands) : undefined,
    sandboxes: normalizeSandboxes(definition.sandboxes),
    cache: cacheRegistry,
    namedInputs,
    triggers: definition.triggers ?? {},
    sync: normalizeSync(definition.sync),
    sources,
    tasks,
    jobs
  };

  validatePipeline(pipeline);
  return pipeline;
}

function isDefaultOnlyEnvOptions(value: EnvVarMap | { default: string }): value is { default: string } {
  return typeof value.default === "string";
}

function normalizeSandboxes(definitions: Record<SandboxId, SandboxDefinition> = {}): Record<SandboxId, SandboxDefinition> {
  const normalized: Record<SandboxId, SandboxDefinition> = {};
  for (const [id, definition] of Object.entries(definitions)) {
    normalized[id] = cloneSandboxDefinition(definition);
  }
  return normalized;
}

function normalizeCommandPolicy(policy: CommandPolicy): CommandPolicy {
  return command.policy(policy);
}

function cloneSandboxDefinition(definition: SandboxDefinition): SandboxDefinition {
  if (definition.kind === "docker") {
    return {
      ...definition,
      volumes: definition.volumes ? definition.volumes.map((volume) => ({ ...volume })) : undefined
    };
  }
  return { ...definition };
}

function cloneCommandRule(rule: CommandRule): CommandRule {
  return {
    exact: rule.exact ? [...rule.exact] : undefined,
    prefix: rule.prefix ? [...rule.prefix] : undefined,
    action: cloneCommandAction(rule.action)
  };
}

function cloneCommandAction(action: CommandAction): CommandAction {
  return { ...action, output: action.output ? { ...action.output } : undefined };
}

function validateRunsOnEntry(jobId: JobId, entry: string | string[], field: string): void {
  const labels = Array.isArray(entry) ? entry : [entry];
  if (labels.length === 0 || labels.some((label) => typeof label !== "string" || label.trim() === "")) {
    throw pipelineError(
      "ASYNC_PIPELINE_RUNS_ON_INVALID",
      `Job "${jobId}" has an invalid github.${field} entry; use a non-empty runner label or label array.`
    );
  }
}

function validateJobRunsOn(jobId: JobId, github: GitHubJobConfig | undefined): void {
  if (!github) return;
  if (github.runsOn !== undefined && github.runsOnMatrix !== undefined) {
    throw pipelineError(
      "ASYNC_PIPELINE_RUNS_ON_CONFLICT",
      `Job "${jobId}" sets both github.runsOn and github.runsOnMatrix; choose one.`
    );
  }
  if (github.runsOn !== undefined) {
    validateRunsOnEntry(jobId, github.runsOn, "runsOn");
  }
  if (github.runsOnMatrix !== undefined) {
    if (!Array.isArray(github.runsOnMatrix) || github.runsOnMatrix.length === 0) {
      throw pipelineError(
        "ASYNC_PIPELINE_RUNS_ON_INVALID",
        `Job "${jobId}" github.runsOnMatrix must be a non-empty array of runner labels or label arrays.`
      );
    }
    for (const entry of github.runsOnMatrix) {
      validateRunsOnEntry(jobId, entry, "runsOnMatrix");
    }
  }
}

export function validatePipeline(pipeline: NormalizedPipeline): void {
  for (const taskDefinition of Object.values(pipeline.tasks)) {
    for (const dependency of taskDefinition.dependsOn) {
      if (!pipeline.tasks[dependency] && !isKnownExternalTaskRef(pipeline, dependency)) {
        throw new Error(`Task "${taskDefinition.id}" depends on missing task "${dependency}".`);
      }
    }
    if (taskDefinition.cache.enabled && taskDefinition.cache.store) {
      assertCacheStore(pipeline.cache, parseCacheRef(cacheRefFromStoreOptions(taskDefinition.cache, pipeline.cache.default)));
    }
  }

  for (const jobDefinition of Object.values(pipeline.jobs)) {
    for (const target of jobDefinition.target) {
      if (!pipeline.tasks[target] && !isKnownExternalTaskRef(pipeline, target)) {
        throw new Error(`Job "${jobDefinition.id}" targets missing task "${target}".`);
      }
    }
    for (const triggerId of jobDefinition.trigger) {
      if (!pipeline.triggers[triggerId]) {
        throw new Error(`Job "${jobDefinition.id}" references missing trigger "${triggerId}".`);
      }
    }
    validateJobRunsOn(jobDefinition.id, jobDefinition.github);
  }

  validateSyncConfig(pipeline);

  // Fail fast on named-input cycles at definePipeline time instead of
  // overflowing the stack when inputs are first resolved.
  for (const taskDefinition of Object.values(pipeline.tasks)) {
    expandInputs(pipeline, taskDefinition.inputs);
  }

  buildGraph(pipeline);
}

export function composePipelines(
  root: NormalizedPipeline,
  sourcePipelines: Record<SourceId, ComposeSourcePipeline>
): NormalizedPipeline {
  const tasks: Record<TaskId, NormalizedTask> = { ...root.tasks };

  for (const [sourceId, input] of Object.entries(sourcePipelines)) {
    const sourceDefinition = root.sources[sourceId];
    if (!sourceDefinition) {
      throw new Error(`Cannot compose undeclared source "${sourceId}".`);
    }

    for (const taskDefinition of Object.values(input.pipeline.tasks)) {
      validateLocalTaskId(taskDefinition.id);
      const namespacedId = namespaceTaskRef(sourceId, taskDefinition.id);
      if (tasks[namespacedId]) {
        throw new Error(`Composed task "${namespacedId}" already exists.`);
      }

      tasks[namespacedId] = {
        ...taskDefinition,
        id: namespacedId,
        dependsOn: taskDefinition.dependsOn.map((dependency) => namespaceTaskRef(sourceId, dependency)),
        steps: [...taskDefinition.steps],
        inputs: [...taskDefinition.inputs],
        outputs: [...taskDefinition.outputs],
        source: input.context ?? {
          name: sourceId,
          dir: "",
          type: sourceDefinition.type,
          ref: sourceDefinition.type === "git" ? sourceDefinition.ref : undefined
        }
      };
    }
  }

  const composed: NormalizedPipeline = {
    ...root,
    tasks,
    jobs: { ...root.jobs },
    sources: { ...root.sources }
  };

  validateComposedPipeline(composed, new Set(Object.keys(sourcePipelines)));
  return composed;
}

export function parseTaskRef(taskRef: TaskId): ParsedTaskRef {
  const delimiterIndex = taskRef.indexOf(":");
  if (delimiterIndex < 0) return { taskId: taskRef };
  return {
    source: taskRef.slice(0, delimiterIndex),
    taskId: taskRef.slice(delimiterIndex + 1)
  };
}

export function isNamespacedTaskRef(taskRef: TaskId): boolean {
  return parseTaskRef(taskRef).source !== undefined;
}

export function namespaceTaskRef(sourceId: SourceId, taskId: TaskId): TaskId {
  validateSourceId(sourceId);
  validateLocalTaskId(taskId);
  return `${sourceId}:${taskId}`;
}

export function buildGraph(pipeline: NormalizedPipeline, targets?: TaskId[]): PipelineGraph {
  const selected = collectRequiredTasks(pipeline, targets ?? Object.keys(pipeline.tasks));
  const nodes = new Map<TaskId, TaskGraphNode>();

  for (const id of selected) {
    const definition = pipeline.tasks[id];
    if (!definition && !isKnownExternalTaskRef(pipeline, id)) {
      throw new Error(`Cannot build graph for missing task "${id}".`);
    }
    nodes.set(id, { id, dependsOn: (definition?.dependsOn ?? []).filter((dependency) => selected.has(dependency)), dependents: [] });
  }

  for (const node of nodes.values()) {
    for (const dependency of node.dependsOn) {
      nodes.get(dependency)?.dependents.push(node.id);
    }
  }

  const visiting = new Set<TaskId>();
  const visited = new Set<TaskId>();
  const order: TaskId[] = [];

  const visit = (id: TaskId, path: TaskId[]): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      const start = path.indexOf(id);
      const cycle = [...path.slice(start), id].join(" -> ");
      throw new Error(`Task dependency cycle detected: ${cycle}.`);
    }
    visiting.add(id);
    const node = nodes.get(id);
    if (!node) return;
    for (const dependency of [...node.dependsOn].sort()) {
      visit(dependency, [...path, id]);
    }
    visiting.delete(id);
    visited.add(id);
    order.push(id);
  };

  for (const id of [...nodes.keys()].sort()) {
    visit(id, []);
  }

  return {
    tasks: [...nodes.values()].map((node) => ({
      id: node.id,
      dependsOn: [...node.dependsOn].sort(),
      dependents: [...node.dependents].sort()
    })).sort((left: TaskGraphNode, right: TaskGraphNode) => left.id.localeCompare(right.id)),
    executionOrder: order
  };
}

export function tasksForJob(pipeline: NormalizedPipeline, jobId: JobId): PipelineGraph {
  const selectedJob = pipeline.jobs[jobId];
  if (!selectedJob) {
    throw new Error(`Unknown job "${jobId}".`);
  }
  return buildGraph(pipeline, selectedJob.target);
}

export function expandInputs(pipeline: NormalizedPipeline, inputs: string[]): string[] {
  return expandInputsInternal(pipeline, inputs, new Set());
}

function expandInputsInternal(pipeline: NormalizedPipeline, inputs: string[], expanding: Set<string>): string[] {
  const expanded: string[] = [];
  for (const input of inputs) {
    if (pipeline.namedInputs[input]) {
      if (expanding.has(input)) {
        throw pipelineError(
          "ASYNC_PIPELINE_INPUT_CYCLE",
          `Named input cycle detected: "${[...expanding, input].join('" -> "')}".`
        );
      }
      expanding.add(input);
      expanded.push(...expandInputsInternal(pipeline, pipeline.namedInputs[input], expanding));
      expanding.delete(input);
    } else {
      expanded.push(input);
    }
  }
  return expanded;
}

function collectRequiredTasks(pipeline: NormalizedPipeline, targets: TaskId[]): Set<TaskId> {
  const selected = new Set<TaskId>();
  const visit = (id: TaskId): void => {
    if (selected.has(id)) return;
    const definition = pipeline.tasks[id];
    if (!definition) {
      if (isKnownExternalTaskRef(pipeline, id)) {
        selected.add(id);
        return;
      }
      throw new Error(`Missing task "${id}".`);
    }
    selected.add(id);
    for (const dependency of definition.dependsOn) {
      visit(dependency);
    }
  };

  for (const target of targets) {
    visit(target);
  }
  return selected;
}

function normalizeSource(id: SourceId, sourceDefinition: SourceDefinition): NormalizedSource {
  const prepare = [...(sourceDefinition.prepare ?? [])];
  const pipeline = sourceDefinition.pipeline ?? "pipeline.ts";
  if (sourceDefinition.type === "git") {
    return {
      ...sourceDefinition,
      id,
      pipeline,
      prepare
    };
  }
  return {
    ...sourceDefinition,
    id,
    pipeline,
    prepare
  };
}

function validateComposedPipeline(pipeline: NormalizedPipeline, loadedSources: Set<SourceId>): void {
  for (const taskDefinition of Object.values(pipeline.tasks)) {
    for (const dependency of taskDefinition.dependsOn) {
      if (!pipeline.tasks[dependency] && !isAllowedUnloadedTaskRef(pipeline, dependency, loadedSources)) {
        throw new Error(`Task "${taskDefinition.id}" depends on missing task "${dependency}".`);
      }
    }
  }
  for (const jobDefinition of Object.values(pipeline.jobs)) {
    for (const target of jobDefinition.target) {
      if (!pipeline.tasks[target] && !isAllowedUnloadedTaskRef(pipeline, target, loadedSources)) {
        throw new Error(`Job "${jobDefinition.id}" targets missing task "${target}".`);
      }
    }
  }
  buildGraph(pipeline);
}

function isAllowedUnloadedTaskRef(pipeline: NormalizedPipeline, taskRef: TaskId, loadedSources: Set<SourceId>): boolean {
  const parsed = parseTaskRef(taskRef);
  return parsed.source !== undefined && Boolean(pipeline.sources[parsed.source]) && !loadedSources.has(parsed.source);
}

function isKnownExternalTaskRef(pipeline: NormalizedPipeline, taskRef: TaskId): boolean {
  const parsed = parseTaskRef(taskRef);
  return parsed.source !== undefined && Boolean(pipeline.sources[parsed.source]);
}

function validateLocalTaskId(id: TaskId): void {
  if (id.includes(":")) {
    throw new Error(`Local task id "${id}" cannot contain ":". Use source namespaces through dependsOn instead.`);
  }
  if (!id.trim()) {
    throw new Error("Task id cannot be empty.");
  }
}

function validateSourceId(id: SourceId): void {
  if (id.includes(":")) {
    throw new Error(`Source id "${id}" cannot contain ":".`);
  }
  if (!id.trim()) {
    throw new Error("Source id cannot be empty.");
  }
}

function normalizeCacheRegistry(cache: PipelineDefinition["cache"]): CacheRegistryDefinition {
  if (cache === undefined || cache === false) return defaultPipelineCache();
  if (typeof cache === "string") {
    return mergeWithDefaultCacheStores(defineCache({ default: cache }));
  }
  if ("kind" in cache && cache.kind === "cache-registry") {
    return mergeWithDefaultCacheStores(cache);
  }
  return mergeWithDefaultCacheStores(defineCache(cache));
}

function normalizeSync(sync: PipelineDefinition["sync"]): NormalizedPipelineSync {
  return {
    github: normalizeGitHubSync(sync?.github),
    tasks: normalizeTaskSync(sync?.tasks)
  };
}

const DEFAULT_GITHUB_NODE_VERSION = "24";

function normalizeGitHubSync(github: GitHubSyncInput | undefined): NormalizedGitHubSyncConfig {
  if (github === undefined || github === false) {
    return {
      enabled: false,
      workflow: ".github/workflows/async-pipeline.yml",
      lock: ".github/async-pipeline.lock.json",
      nodeVersion: DEFAULT_GITHUB_NODE_VERSION,
      cache: true
    };
  }
  if (github === true) {
    return {
      enabled: true,
      workflow: ".github/workflows/async-pipeline.yml",
      lock: ".github/async-pipeline.lock.json",
      nodeVersion: DEFAULT_GITHUB_NODE_VERSION,
      cache: true
    };
  }
  return {
    enabled: true,
    workflow: github.workflow ?? ".github/workflows/async-pipeline.yml",
    lock: github.lock ?? ".github/async-pipeline.lock.json",
    nodeVersion: normalizeGitHubNodeVersion(github.nodeVersion),
    cache: github.cache ?? true
  };
}

function normalizeGitHubNodeVersion(nodeVersion: number | string | undefined): string {
  if (nodeVersion === undefined) return DEFAULT_GITHUB_NODE_VERSION;
  const normalized = String(nodeVersion).trim();
  if (!/^\d+(?:\.\d+){0,2}$/.test(normalized)) {
    throw pipelineError("ASYNC_PIPELINE_SYNC_INVALID_NODE_VERSION", `Invalid GitHub sync nodeVersion "${nodeVersion}". Use a version like 24 or 24.1.0.`);
  }
  return normalized;
}

function normalizeTaskSync(tasks: TaskSyncInput | undefined): NormalizedTaskSyncConfig {
  if (tasks === undefined || tasks === false) {
    return {
      enabled: false,
      prefix: "pipeline",
      runners: "all",
      targets: "root",
      jobs: "all",
      scripts: {}
    };
  }
  if (tasks === true) {
    return {
      enabled: true,
      prefix: "pipeline",
      runners: "all",
      targets: "root",
      jobs: "all",
      scripts: {}
    };
  }
  return {
    enabled: true,
    prefix: tasks.prefix ?? "pipeline",
    runners: tasks.runners ? normalizeRunners(tasks.runners) : "all",
    targets: tasks.targets ?? "root",
    jobs: tasks.jobs ?? "all",
    tasks: tasks.tasks,
    scripts: { ...(tasks.scripts ?? {}) }
  };
}

function normalizeRunners(runners: "all" | SyncRunner[]): "all" | SyncRunner[] {
  if (runners === "all") return runners;
  return [...new Set(runners)];
}

function validateSyncConfig(pipeline: NormalizedPipeline): void {
  const taskSync = pipeline.sync.tasks;
  if (!taskSync.enabled) return;
  if (!taskSync.prefix.trim()) {
    throw pipelineError("ASYNC_PIPELINE_SYNC_INVALID_PREFIX", "Task sync prefix cannot be empty.");
  }
  if (Array.isArray(taskSync.runners) && taskSync.runners.length === 0) {
    throw pipelineError("ASYNC_PIPELINE_SYNC_INVALID_RUNNERS", "Task sync runners cannot be empty.");
  }
  if (Array.isArray(taskSync.jobs)) {
    for (const jobId of taskSync.jobs) {
      if (!pipeline.jobs[jobId]) throw pipelineError("ASYNC_PIPELINE_SYNC_UNKNOWN_JOB", `Task sync references missing job "${jobId}".`);
    }
  }
  if (Array.isArray(taskSync.tasks)) {
    for (const taskId of taskSync.tasks) {
      if (!pipeline.tasks[taskId]) throw pipelineError("ASYNC_PIPELINE_SYNC_UNKNOWN_TASK", `Task sync references missing task "${taskId}".`);
    }
  }
}

function normalizeCache(cache: TaskDefinition["cache"] | CacheDirective, registry: CacheRegistryDefinition): TaskCacheOptions {
  if (isCacheDirective(cache)) {
    const parsed = parseCacheRef(cache.ref);
    assertCacheStore(registry, parsed);
    return {
      enabled: true,
      directories: [],
      ref: parsed.ref,
      store: parsed.store,
      policy: parsed.policy,
      ttlMs: cache.options?.ttlMs,
      key: cache.options?.key
    };
  }
  if (cache === true) {
    const parsed = parseCacheRef(registry.default);
    assertCacheStore(registry, parsed);
    return { enabled: true, directories: [], ref: parsed.ref, store: parsed.store, policy: parsed.policy };
  }
  if (cache === false || cache === undefined) return { enabled: false, directories: [] };
  if (typeof cache === "string") {
    const parsed = parseCacheRef(cache);
    assertCacheStore(registry, parsed);
    return { enabled: true, directories: [], ref: parsed.ref, store: parsed.store, policy: parsed.policy };
  }
  const ref = cacheRefFromStoreOptions(cache, registry.default);
  const parsed = parseCacheRef(ref);
  assertCacheStore(registry, parsed);
  return {
    ...cache,
    enabled: cache.enabled ?? true,
    directories: [...(cache.directories ?? [])],
    ref: parsed.ref,
    store: parsed.store,
    policy: parsed.policy
  };
}

function cacheRefFromStoreOptions(cache: { ref?: CacheRef; store?: string; policy?: CachePolicy }, defaultRef: CacheRef): CacheRef {
  if (cache.ref) return cache.ref;
  if (!cache.store) return defaultRef;
  return cache.policy ? `${cache.store}:${cache.policy}` : cache.store;
}

function normalizeRetry(retry: TaskDefinition["retry"]): RetryPolicy {
  if (retry === undefined) return { attempts: 1 };
  if (typeof retry === "number") return { attempts: retry };
  return { attempts: retry.attempts, delayMs: retry.delayMs };
}

function normalizeTimeout(timeout: TaskDefinition["timeout"]): number | undefined {
  if (timeout === undefined) return undefined;
  if (typeof timeout === "number") return timeout;

  const trimmed = timeout.trim();
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(trimmed);
  if (!match) {
    throw new Error(`Invalid timeout "${timeout}". Use milliseconds or a duration like 500ms, 30s, 5m, or 1h.`);
  }

  const value = Number(match[1]);
  const unit = match[2] ?? "ms";
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid timeout "${timeout}". Timeout must be a positive duration.`);
  }

  const multiplier = unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000;
  return Math.round(value * multiplier);
}

function taskName(id: string): string {
  const delimiterIndex = id.lastIndexOf(":");
  return delimiterIndex >= 0 ? id.slice(delimiterIndex + 1) : id;
}

function runItemsFromDefinition(run: TaskDefinition["run"]): TaskRunItem[] {
  if (run === undefined) return [];
  return isTaskRunArray(run) ? [...run] : [run];
}

function partitionRunItems(items: readonly TaskRunItem[]): {
  steps: TaskStep[];
  cacheDirectives: CacheDirective[];
  dependsOnDirectives: DependsOnDirective[];
} {
  const steps: TaskStep[] = [];
  const cacheDirectives: CacheDirective[] = [];
  const dependsOnDirectives: DependsOnDirective[] = [];

  for (const item of items) {
    if (isCacheDirective(item)) {
      cacheDirectives.push(item);
      continue;
    }
    if (isDependsOnDirective(item)) {
      dependsOnDirectives.push(item);
      continue;
    }
    steps.push(item);
  }

  if (cacheDirectives.length > 1) {
    throw pipelineError("ASYNC_PIPELINE_TASK_CACHE_CONFLICT", "A task can only use one cache directive.");
  }

  return { steps, cacheDirectives, dependsOnDirectives };
}

function isDependsOnDirective(value: unknown): value is DependsOnDirective {
  return Boolean(value)
    && typeof value === "object"
    && (value as { kind?: unknown }).kind === "async-pipeline.directive.dependsOn";
}

function uniqueTaskIds(taskIds: readonly TaskId[]): TaskId[] {
  return [...new Set(taskIds)];
}

function isTaskRunArray(value: TaskRunDefinition): value is readonly TaskRunItem[] {
  return Array.isArray(value);
}
