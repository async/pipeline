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
import {
  assertSupportedDeclaration,
  brandDeclaration,
  hasDeclarationKind,
  readDeclaration
} from "./declaration.js";
import { pipelineError } from "./errors.js";
import {
  projectPipelineGraph,
  selectExecutionGraph
} from "./graph.js";

export * from "./cache.js";
export * from "./declaration.js";
export * from "./errors.js";

export type TaskId = string;
export type JobId = string;
export type TriggerId = string;
export type SourceId = string;
export type SandboxId = string;
export type ExecutionProfileId = string;
export type SourceType = "git" | "path";
export type ExecutionMode = "manual" | "ci";
export type CacheSharing = "shared" | "private" | "locked";
export type TaskStatus = "pending" | "running" | "passed" | "failed" | "skipped" | "cached";
export type EnvVarMap = Record<string, string>;
export type EnvValue = string | EnvSecretRef | EnvVarRef;
export type SandboxKind = "host" | "lima" | "docker" | "container";
export type ContainerProvider = "auto" | "docker" | "apple-container" | "lima";

export const DEFAULT_PIPELINE_CONFIG_FILES = ["pipeline.ts", "pipeline.js", "pipeline.mjs", "pipeline.mts"] as const;

const SOURCE_PIPELINE_DEFAULTED = Symbol.for("@async/pipeline.source.pipeline.defaulted");

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
export type TaskStep = ShellCommand | DeferredShellCommand | AgentStep | TaskRunFunction;

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

export interface ContainerSandboxDefinition {
  kind: "container";
  image: string;
  workdir?: string;
  volumes?: SandboxVolume[];
}

export type SandboxDefinition =
  | HostSandboxDefinition
  | LimaSandboxDefinition
  | DockerSandboxDefinition
  | ContainerSandboxDefinition;

export interface LocalExecutionProfileDefinition {
  kind: "local";
  sandbox?: SandboxId;
  provider?: ContainerProvider;
}

export interface GitHubExecutionProfileDefinition {
  kind: "github";
  sandbox?: SandboxId;
  provider?: ContainerProvider;
  runsOn?: string | string[];
  runsOnMatrix?: Array<string | string[]>;
}

export type ExecutionProfileDefinition =
  | LocalExecutionProfileDefinition
  | GitHubExecutionProfileDefinition;

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

export type AgentProfileId = string;

export interface AgentProfileDefinition {
  /**
   * Argv prefix for the adapter CLI (e.g. ["claude", "-p"]). The resolved
   * prompt is delivered on stdin. The command never enters any cache key:
   * cache identity comes from the profile id and model, not from where a
   * binary happens to live.
   */
  command: readonly string[];
  /** Model identity. Enters agent cache keys; supports env.var(...) selection. */
  model: string | EnvVarRef;
}

export interface AgentStep {
  kind: "agent";
  /** Profile id declared in pipeline `agents`, or env.var(...) selecting one at run time. */
  use: AgentProfileId | EnvVarRef;
  prompt: string;
  /** Optional model override of the profile's model. */
  model?: string | EnvVarRef;
  /**
   * Write the adapter's stdout to this file (relative to the task's cwd)
   * after the step succeeds. The propose-only mechanism: an agent emits a
   * patch or report on stdout, the runner lands it as a reviewable artifact.
   * Declare the path in the task's `outputs` to cache and restore it.
   */
  stdoutTo?: string;
}

/** An agent step after run-time resolution: profile and model are concrete and the adapter argv is attached for execution. */
export interface ResolvedAgentStep extends AgentStep {
  use: AgentProfileId;
  model: string;
  command: readonly string[];
}

export interface TriggerDefinition {
  type: "manual" | "github" | "schedule";
  events?: string[];
  types?: string[];
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
export type GitHubSetupProvider = "auto" | "async" | "pnpm" | "node";
export type GitHubRuntimeName = "node" | "deno" | "bun";
export type DependabotAutoMergeEcosystem = "github-actions" | "npm" | "deno";

export interface DependabotAutoMergeConfig {
  ecosystems?: DependabotAutoMergeEcosystem[];
}

export type DependabotAutoMergeInput = boolean | DependabotAutoMergeConfig;

export interface PackagePreviewsConfig {
  package?: string;
  target?: string;
  registry?: string;
  namespace?: string;
  tokenEnv?: string;
  comment?: boolean;
}

export type PackagePreviewsInput = boolean | PackagePreviewsConfig;

export type EvidenceIfNoFilesFound = "ignore" | "warn" | "error";

export interface GitHubEvidenceConfig {
  job?: string;
  paths?: string[];
  receiptPaths?: string[];
  artifactNamePrefix?: string;
  retentionDays?: number;
  ifNoFilesFound?: EvidenceIfNoFilesFound;
  includeSummary?: boolean;
}

export type GitHubEvidenceInput = boolean | GitHubEvidenceConfig;

export type GitHubBridgeMode = "actions" | "off";

export interface GitHubBridgeSyncConfig {
  mode?: GitHubBridgeMode;
  schedule?: string | false;
  pullRequest?: boolean;
  branchPrefix?: string;
  allowedPaths?: string[];
  endpointVar?: string;
  tokenEnv?: string;
  packageVersion?: string;
}

export type GitHubBridgeSyncInput = false | GitHubBridgeSyncConfig;

export interface GitHubPagesSyncTriggersConfig {
  pullRequest?: boolean;
  main?: boolean | {
    branch?: string;
  };
  manual?: boolean;
}

export interface GitHubPagesSyncConfig extends Partial<GitHubPagesConfig> {
  target?: string;
  job?: string;
  triggers?: GitHubPagesSyncTriggersConfig;
}

export type GitHubPagesSyncInput = boolean | GitHubPagesSyncConfig;

export interface GitHubSourceImpactConfig {
  jobs?: JobId[];
}

export type GitHubSourceImpactInput = boolean | GitHubSourceImpactConfig;

export interface GitHubAttestConfig {
  packagePath?: string;
  artifacts?: string[];
  subjectManifest?: string;
  sbomPath?: string;
  evidencePath?: string;
  requireNpmProvenance?: boolean;
  tarballScan?: boolean;
  githubAttestation?: boolean;
}

export type GitHubAttestInput = boolean | GitHubAttestConfig;

export type GitHubContractMode = "off" | "report" | "check" | "strict" | "release";

export interface GitHubContractSchemaConfig {
  enabled?: boolean;
  sources?: string[];
  output?: string;
}

export interface GitHubContractConfig {
  mode?: GitHubContractMode;
  job?: string;
  api?: boolean;
  claims?: boolean;
  schema?: boolean | GitHubContractSchemaConfig;
  packagePath?: string;
  evidenceDir?: string;
  annotations?: boolean;
}

export type GitHubContractInput = boolean | GitHubContractConfig;

export type GitHubHygieneMode = "off" | "report" | "check" | "strict" | "release";
export type GitHubHygieneProfile = "package" | "github" | "docs" | "repo" | "release" | "mixed";

export interface GitHubHygieneConfig {
  mode?: GitHubHygieneMode;
  job?: string;
  profiles?: GitHubHygieneProfile[];
  releaseGate?: boolean;
  packagePath?: string;
  evidenceDir?: string;
  annotations?: boolean;
}

export type GitHubHygieneInput = boolean | GitHubHygieneConfig;

export interface GitHubSyncConfig {
  workflow?: string;
  lock?: string;
  setup?: GitHubSetupProvider;
  nodeVersion?: number | string;
  runtime?: string | string[];
  cache?: boolean;
  dependencyCache?: boolean;
  dependabotAutoMerge?: DependabotAutoMergeInput;
  packagePreviews?: PackagePreviewsInput;
  evidence?: GitHubEvidenceInput;
  bridge?: GitHubBridgeSyncInput;
  pages?: GitHubPagesSyncInput;
  sourceImpact?: GitHubSourceImpactInput;
  attest?: GitHubAttestInput;
  contract?: GitHubContractInput;
  hygiene?: GitHubHygieneInput;
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
  command?: string;
  github?: GitHubSyncInput;
  tasks?: TaskSyncInput;
}

export interface NormalizedGitHubSyncConfig {
  enabled: boolean;
  workflow: string;
  lock: string;
  setup: Exclude<GitHubSetupProvider, "auto">;
  nodeVersion: string;
  runtime: string[];
  cache: boolean;
  dependencyCache: boolean;
  dependabotAutoMerge: NormalizedDependabotAutoMergeConfig;
  packagePreviews: NormalizedPackagePreviewsConfig;
  evidence: NormalizedGitHubEvidenceConfig;
  bridge: NormalizedGitHubBridgeSyncConfig;
  pages: NormalizedGitHubPagesSyncConfig;
  sourceImpact: NormalizedGitHubSourceImpactConfig;
  attest: NormalizedGitHubAttestConfig;
  contract: NormalizedGitHubContractConfig;
  hygiene: NormalizedGitHubHygieneConfig;
}

export interface NormalizedDependabotAutoMergeConfig {
  enabled: boolean;
  ecosystems: DependabotAutoMergeEcosystem[];
}

export interface NormalizedPackagePreviewsConfig {
  enabled: boolean;
  package?: string;
  target?: string;
  registry: string;
  namespace?: string;
  tokenEnv: string;
  comment: boolean;
}

export interface NormalizedGitHubEvidenceConfig {
  enabled: boolean;
  job: string;
  paths: string[];
  receiptPaths: string[];
  artifactNamePrefix: string;
  retentionDays: number;
  ifNoFilesFound: EvidenceIfNoFilesFound;
  includeSummary: boolean;
}

export interface NormalizedGitHubBridgeSyncConfig {
  enabled: boolean;
  mode: GitHubBridgeMode;
  schedule: string | false;
  pullRequest: boolean;
  branchPrefix: string;
  allowedPaths: string[];
  endpointVar: string;
  tokenEnv: string;
  packageVersion: string;
}

export interface NormalizedGitHubPagesSyncTriggersConfig {
  pullRequest: boolean;
  main: false | {
    branch: string;
  };
  manual: boolean;
}

export interface NormalizedGitHubPagesSyncConfig extends GitHubPagesConfig {
  enabled: boolean;
  target?: string;
  job: string;
  triggers: NormalizedGitHubPagesSyncTriggersConfig;
}

export interface NormalizedGitHubSourceImpactConfig {
  enabled: boolean;
  jobs: JobId[];
}

export interface NormalizedGitHubAttestConfig {
  enabled: boolean;
  packagePath?: string;
  artifacts: string[];
  subjectManifest: string;
  sbomPath: string;
  evidencePath: string;
  requireNpmProvenance: boolean;
  tarballScan: boolean;
  githubAttestation: boolean;
}

export interface NormalizedGitHubContractSchemaConfig {
  enabled: boolean;
  sources: string[];
  output: string;
}

export interface NormalizedGitHubContractConfig {
  enabled: boolean;
  mode: GitHubContractMode;
  job: string;
  api: boolean;
  claims: boolean;
  schema: NormalizedGitHubContractSchemaConfig;
  packagePath: string;
  evidenceDir: string;
  annotations: boolean;
}

export interface NormalizedGitHubHygieneConfig {
  enabled: boolean;
  mode: GitHubHygieneMode;
  job: string;
  profiles: GitHubHygieneProfile[];
  releaseGate: boolean;
  packagePath: string;
  evidenceDir: string;
  annotations: boolean;
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
  command: string;
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

export interface TaskGroupDefinition {
  [taskId: string]: TaskTreeDefinition;
}

export type TaskTreeDefinition = TaskDefinition | TaskGroupDefinition;
export type TaskSectionDefinition = Record<TaskId, TaskTreeDefinition>;

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
  execution?: ExecutionProfileId;
  github?: GitHubJobConfig;
}

export interface NormalizedJob extends Omit<JobDefinition, "target" | "trigger"> {
  id: JobId;
  target: TaskId[];
  trigger: TriggerId[];
}

export type GitHubPermission = "read" | "write" | "none";

export type GitHubPagesBuild =
  | {
    kind: "jekyll";
    source: string;
    destination?: string;
  }
  | {
    kind: "static";
    path: string;
  }
  | {
    kind: "prerender";
    path: string;
    validateIndex?: boolean;
    spaFallback?: boolean;
  };

export interface GitHubPagesConfig {
  build: GitHubPagesBuild;
  artifactName?: string;
  environment?: JobEnvironment;
}

export interface GitHubJobConfig {
  environment?: string;
  pages?: GitHubPagesConfig;
  permissions?: {
    contents?: GitHubPermission;
    idToken?: "write" | "none";
    /** Renders `issues: <value>` (issue comments need `write`). */
    issues?: GitHubPermission;
    /** Renders `packages: <value>` (GitHub Packages publishing needs `write`). */
    packages?: GitHubPermission;
    /** Renders `pull-requests: <value>` (commenting on a PR needs `write`). */
    pullRequests?: GitHubPermission;
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
  agents?: Record<AgentProfileId, AgentProfileDefinition>;
  sandboxes?: Record<SandboxId, SandboxDefinition>;
  execution?: Record<ExecutionProfileId, ExecutionProfileDefinition>;
  cache?: CacheRef | CacheRegistryDefinition | CacheRegistryInput | false;
  namedInputs?: Record<string, string[]>;
  taskDefaults?: Record<string, Partial<TaskDefinition>>;
  triggers?: Record<TriggerId, TriggerDefinition>;
  sync?: PipelineSyncConfig;
  sources?: Record<SourceId, SourceDefinition>;
  tasks: TaskSectionDefinition;
  jobs: Record<JobId, JobDefinition>;
}

export interface NormalizedPipeline {
  name: string;
  env: Record<string, EnvValue>;
  commands?: CommandPolicy;
  agents: Record<AgentProfileId, AgentProfileDefinition>;
  sandboxes: Record<SandboxId, SandboxDefinition>;
  execution: Record<ExecutionProfileId, ExecutionProfileDefinition>;
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
    return brandDeclaration({ kind: "deferred-shell", command: first }, "deferred-shell");
  }

  let command = "";
  for (let index = 0; index < first.length; index += 1) {
    command += first[index] ?? "";
    if (index < values.length) {
      command += String(values[index]);
    }
  }
  return brandDeclaration({ kind: "shell", command }, "shell");
}

const AGENT_STEP_FIELDS = new Set(["use", "prompt", "model", "stdoutTo"]);
const DECLARED_AGENT_STEP_FIELDS = new Set(["kind", ...AGENT_STEP_FIELDS]);
const SHELL_STEP_FIELDS = new Set(["kind", "command"]);

export function agent(options: { use: AgentProfileId | EnvVarRef; prompt: string; model?: string | EnvVarRef; stdoutTo?: string }): AgentStep {
  rejectUnknownFields(AGENT_STEP_FIELDS, options, "agent() step");
  const use = options.use;
  if (use === undefined || use === null || (typeof use === "string" && use.length === 0)) {
    throw pipelineError(
      "ASYNC_PIPELINE_AGENT_INVALID",
      'agent() requires "use": the id of a profile declared in the pipeline\'s agents block, or env.var(...) selecting one at run time.'
    );
  }
  if (typeof options.prompt !== "string" || options.prompt.length === 0) {
    throw pipelineError("ASYNC_PIPELINE_AGENT_INVALID", 'agent() requires a non-empty "prompt" string.');
  }
  if (options.stdoutTo !== undefined) {
    if (typeof options.stdoutTo !== "string" || options.stdoutTo.length === 0) {
      throw pipelineError("ASYNC_PIPELINE_AGENT_INVALID", 'agent() "stdoutTo" must be a non-empty path string.');
    }
    if (options.stdoutTo.startsWith("/") || /^[A-Za-z]:[\\/]/.test(options.stdoutTo) || options.stdoutTo.split(/[\\/]+/).includes("..")) {
      throw pipelineError(
        "ASYNC_PIPELINE_AGENT_INVALID",
        'agent() "stdoutTo" must be a relative path inside the task\'s working directory; absolute paths and ".." segments are rejected.'
      );
    }
  }
  const step: AgentStep = brandDeclaration({ kind: "agent", use, prompt: options.prompt }, "agent");
  if (options.model !== undefined) step.model = options.model;
  if (options.stdoutTo !== undefined) step.stdoutTo = options.stdoutTo;
  return step;
}

export function isAgentStep(step: TaskStep): step is AgentStep {
  return typeof step !== "function" && step.kind === "agent";
}

export function isResolvedAgentStep(step: TaskStep): step is ResolvedAgentStep {
  return isAgentStep(step) && typeof step.use === "string" && typeof step.model === "string" && Array.isArray((step as ResolvedAgentStep).command);
}

export function task(definition: TaskDefinition): TaskDefinition;
export function task(definition: TaskDefinition, run: TaskRunDefinition): TaskDefinition;
export function task(definition: TaskDefinition, run?: TaskRunDefinition): TaskDefinition {
  if (definition.run !== undefined && run !== undefined) {
    throw pipelineError("ASYNC_PIPELINE_TASK_ARGUMENT_CONFLICT", "Do not pass a second task argument when config.run is defined.");
  }
  return brandDeclaration(run === undefined ? definition : { ...definition, run }, "task");
}

export function job(definition: JobDefinition): JobDefinition {
  return brandDeclaration(definition, "job");
}

function envVar(name: string): EnvVarRef;
function envVar(name: string, options: { default: string }): EnvVarRef;
function envVar(name: string, values: EnvVarMap, options?: { default?: string }): EnvVarRef;
function envVar(name: string, valuesOrOptions?: EnvVarMap | { default: string }, options: { default?: string } = {}): EnvVarRef {
  if (!valuesOrOptions) return brandDeclaration({ kind: "async-pipeline.env.var", name }, "env.var");
  if (isDefaultOnlyEnvOptions(valuesOrOptions) && Object.keys(valuesOrOptions).length === 1) {
    return brandDeclaration({ kind: "async-pipeline.env.var", name, default: valuesOrOptions.default }, "env.var");
  }
  return brandDeclaration({
    kind: "async-pipeline.env.var",
    name,
    values: { ...valuesOrOptions },
    default: options.default
  }, "env.var");
}

export const env = {
  secret(name: string): EnvSecretRef {
    return brandDeclaration({ kind: "async-pipeline.env.secret", name }, "env.secret");
  },
  var: envVar
};

export const sandbox = {
  host(): HostSandboxDefinition {
    return brandDeclaration({ kind: "host" }, "sandbox.host");
  },
  lima(options: Omit<LimaSandboxDefinition, "kind"> = {}): LimaSandboxDefinition {
    return brandDeclaration({ kind: "lima", vm: options.vm }, "sandbox.lima");
  },
  docker(options: Omit<DockerSandboxDefinition, "kind">): DockerSandboxDefinition {
    return brandDeclaration({
      kind: "docker",
      image: options.image,
      workdir: options.workdir,
      volumes: options.volumes ? options.volumes.map((volume) => ({ ...volume })) : undefined
    }, "sandbox.docker");
  },
  container(options: Omit<ContainerSandboxDefinition, "kind">): ContainerSandboxDefinition {
    return brandDeclaration({
      kind: "container",
      image: options.image,
      workdir: options.workdir,
      volumes: options.volumes ? options.volumes.map((volume) => ({ ...volume })) : undefined
    }, "sandbox.container");
  }
};

export const execution = {
  local(options: Omit<LocalExecutionProfileDefinition, "kind"> = {}): LocalExecutionProfileDefinition {
    return brandDeclaration({
      kind: "local",
      sandbox: options.sandbox,
      provider: options.provider
    }, "execution.local");
  },
  github(options: Omit<GitHubExecutionProfileDefinition, "kind">): GitHubExecutionProfileDefinition {
    return brandDeclaration({
      kind: "github",
      sandbox: options.sandbox,
      provider: options.provider,
      runsOn: options.runsOn ? cloneRunsOnEntry(options.runsOn) : undefined,
      runsOnMatrix: options.runsOnMatrix ? options.runsOnMatrix.map(cloneRunsOnEntry) : undefined
    }, "execution.github");
  }
};

export const command = {
  policy(options: Omit<CommandPolicy, "rules"> & { rules?: CommandRule[] } = {}): CommandPolicy {
    return brandDeclaration({
      rules: options.rules ? options.rules.map(cloneCommandRule) : [],
      fallback: options.fallback ? cloneCommandAction(options.fallback) : undefined,
      record: options.record,
      output: options.output ? { ...options.output } : undefined,
      shims: options.shims ? [...options.shims] : undefined
    }, "command.policy");
  },
  rule(options: CommandRule): CommandRule {
    return brandDeclaration(cloneCommandRule(options), "command.rule");
  },
  allow(options: { output?: CommandOutputPolicy } = {}): CommandAction {
    return brandDeclaration({ kind: "async-pipeline.command.allow", output: options.output ? { ...options.output } : undefined }, "command.allow");
  },
  deny(options: { message?: string; output?: CommandOutputPolicy } = {}): CommandAction {
    return brandDeclaration({ kind: "async-pipeline.command.deny", message: options.message, output: options.output ? { ...options.output } : undefined }, "command.deny");
  },
  mock(options: { code?: number; stdout?: string; stderr?: string; output?: CommandOutputPolicy } = {}): CommandAction {
    return brandDeclaration({
      kind: "async-pipeline.command.mock",
      code: options.code,
      stdout: options.stdout,
      stderr: options.stderr,
      output: options.output ? { ...options.output } : undefined
    }, "command.mock");
  },
  requireApproval(options: { message?: string; output?: CommandOutputPolicy } = {}): CommandAction {
    return brandDeclaration({ kind: "async-pipeline.command.requireApproval", message: options.message, output: options.output ? { ...options.output } : undefined }, "command.requireApproval");
  },
  requireEnvironment(options: { name: string; output?: CommandOutputPolicy }): CommandAction {
    return brandDeclaration({ kind: "async-pipeline.command.requireEnvironment", name: options.name, output: options.output ? { ...options.output } : undefined }, "command.requireEnvironment");
  }
};

export const trigger = {
  manual(): TriggerDefinition {
    return brandDeclaration({ type: "manual" }, "trigger.manual");
  },
  github(options: { events: string[]; types?: string[]; branches?: string[]; paths?: string[]; tags?: string[] }): TriggerDefinition {
    return brandDeclaration({
      type: "github",
      events: [...options.events],
      types: options.types ? [...options.types] : undefined,
      branches: options.branches ? [...options.branches] : undefined,
      paths: options.paths ? [...options.paths] : undefined,
      tags: options.tags ? [...options.tags] : undefined
    }, "trigger.github");
  },
  cron(cron: string, options: { timezone?: string } = {}): TriggerDefinition {
    return brandDeclaration({ type: "schedule", cron, timezone: options.timezone }, "trigger.cron");
  },
  schedule(cron: string): TriggerDefinition {
    return brandDeclaration({ type: "schedule", cron }, "trigger.schedule");
  }
};

export function dependsOn(...taskIds: TaskId[]): DependsOnDirective {
  return brandDeclaration({ kind: "async-pipeline.directive.dependsOn", taskIds }, "directive.dependsOn");
}

export const source = {
  git(definition: Omit<GitSourceDefinition, "type">): GitSourceDefinition {
    return brandDeclaration({ ...definition, type: "git" }, "source.git");
  },
  path(definition: Omit<PathSourceDefinition, "type">): PathSourceDefinition {
    return brandDeclaration({ ...definition, type: "path" }, "source.path");
  }
};

export function tasks(definitions: TaskSectionDefinition): TaskSectionDefinition {
  return brandDeclaration(definitions, "section.tasks");
}

export function jobs(definitions: Record<JobId, JobDefinition>): Record<JobId, JobDefinition> {
  return brandDeclaration(definitions, "section.jobs");
}

export function triggers(definitions: Record<TriggerId, TriggerDefinition>): Record<TriggerId, TriggerDefinition> {
  return brandDeclaration(definitions, "section.triggers");
}

export function sources(definitions: Record<SourceId, SourceDefinition>): Record<SourceId, SourceDefinition> {
  return brandDeclaration(definitions, "section.sources");
}

export function taskDefaults(definitions: Record<string, Partial<TaskDefinition>>): Record<string, Partial<TaskDefinition>> {
  return brandDeclaration(definitions, "section.taskDefaults");
}

export function agents(definitions: Record<AgentProfileId, AgentProfileDefinition>): Record<AgentProfileId, AgentProfileDefinition> {
  return brandDeclaration(definitions, "section.agents");
}

export function sandboxes(definitions: Record<SandboxId, SandboxDefinition>): Record<SandboxId, SandboxDefinition> {
  return brandDeclaration(definitions, "section.sandboxes");
}

const PIPELINE_FIELDS = new Set(["name", "env", "commands", "agents", "sandboxes", "execution", "cache", "namedInputs", "taskDefaults", "triggers", "sync", "sources", "tasks", "jobs"]);
const AGENT_PROFILE_FIELDS = new Set(["command", "model"]);
const TASK_FIELDS = new Set(["description", "dependsOn", "inputs", "outputs", "cache", "retry", "timeout", "requires", "run", "steps"]);
const JOB_FIELDS = new Set(["description", "target", "trigger", "environment", "env", "requires", "execution", "github"]);
const EXECUTION_PROFILE_FIELDS = new Set(["kind", "sandbox", "provider", "runsOn", "runsOnMatrix"]);
const GITHUB_JOB_FIELDS = new Set(["environment", "pages", "permissions", "runsOn", "runsOnMatrix"]);
const GITHUB_PAGES_FIELDS = new Set(["artifactName", "build", "environment"]);
const GITHUB_PAGES_JEKYLL_BUILD_FIELDS = new Set(["destination", "kind", "source"]);
const GITHUB_PAGES_STATIC_BUILD_FIELDS = new Set(["kind", "path"]);
const GITHUB_PAGES_PRERENDER_BUILD_FIELDS = new Set(["kind", "path", "spaFallback", "validateIndex"]);
const GITHUB_PERMISSION_FIELDS = new Set(["contents", "idToken", "issues", "packages", "pullRequests"]);
const SYNC_FIELDS = new Set(["command", "github", "tasks"]);
const GITHUB_SYNC_FIELDS = new Set(["workflow", "lock", "setup", "nodeVersion", "runtime", "cache", "dependencyCache", "packagePreviews", "dependabotAutoMerge", "evidence", "bridge", "pages", "sourceImpact", "attest", "contract", "hygiene"]);
const GITHUB_SETUP_PROVIDERS = new Set<GitHubSetupProvider>(["auto", "async", "pnpm", "node"]);
const DEPENDABOT_AUTO_MERGE_FIELDS = new Set(["ecosystems"]);
const DEPENDABOT_AUTO_MERGE_ECOSYSTEMS = new Set<DependabotAutoMergeEcosystem>(["github-actions", "npm", "deno"]);
const PACKAGE_PREVIEWS_FIELDS = new Set(["package", "target", "registry", "namespace", "tokenEnv", "comment"]);
const GITHUB_EVIDENCE_FIELDS = new Set(["job", "paths", "receiptPaths", "artifactNamePrefix", "retentionDays", "ifNoFilesFound", "includeSummary"]);
const GITHUB_BRIDGE_FIELDS = new Set(["mode", "schedule", "pullRequest", "branchPrefix", "allowedPaths", "endpointVar", "tokenEnv", "packageVersion"]);
const GITHUB_SYNC_PAGES_FIELDS = new Set(["artifactName", "build", "environment", "job", "target", "triggers"]);
const GITHUB_SOURCE_IMPACT_FIELDS = new Set(["jobs"]);
const GITHUB_ATTEST_FIELDS = new Set(["packagePath", "artifacts", "subjectManifest", "sbomPath", "evidencePath", "requireNpmProvenance", "tarballScan", "githubAttestation"]);
const GITHUB_CONTRACT_FIELDS = new Set(["mode", "job", "api", "claims", "schema", "packagePath", "evidenceDir", "annotations"]);
const GITHUB_CONTRACT_SCHEMA_FIELDS = new Set(["enabled", "sources", "output"]);
const GITHUB_HYGIENE_FIELDS = new Set(["mode", "job", "profiles", "releaseGate", "packagePath", "evidenceDir", "annotations"]);
const GITHUB_SYNC_PAGES_TRIGGERS_FIELDS = new Set(["manual", "main", "pullRequest"]);
const GITHUB_SYNC_PAGES_MAIN_TRIGGER_FIELDS = new Set(["branch"]);
const CONTAINER_PROVIDERS = new Set(["auto", "docker", "apple-container", "lima"]);
const SECTION_KINDS = {
  agents: "section.agents",
  sandboxes: "section.sandboxes",
  taskDefaults: "section.taskDefaults",
  triggers: "section.triggers",
  sources: "section.sources",
  tasks: "section.tasks",
  jobs: "section.jobs"
} as const;

interface FlattenedTaskDefinition {
  id: TaskId;
  definition: TaskDefinition;
  groupPath: string[];
}

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
  if (definition.sync && typeof definition.sync === "object") {
    rejectUnknownFields(SYNC_FIELDS, definition.sync, "sync");
  }
  if (definition.sync?.github && typeof definition.sync.github === "object") {
    rejectUnknownFields(GITHUB_SYNC_FIELDS, definition.sync.github, "sync.github");
    if (definition.sync.github.dependabotAutoMerge && typeof definition.sync.github.dependabotAutoMerge === "object") {
      rejectUnknownFields(DEPENDABOT_AUTO_MERGE_FIELDS, definition.sync.github.dependabotAutoMerge, "sync.github.dependabotAutoMerge");
    }
    if (definition.sync.github.packagePreviews && typeof definition.sync.github.packagePreviews === "object") {
      rejectUnknownFields(PACKAGE_PREVIEWS_FIELDS, definition.sync.github.packagePreviews, "sync.github.packagePreviews");
    }
    if (definition.sync.github.evidence && typeof definition.sync.github.evidence === "object") {
      rejectUnknownFields(GITHUB_EVIDENCE_FIELDS, definition.sync.github.evidence, "sync.github.evidence");
    }
    if (definition.sync.github.bridge && typeof definition.sync.github.bridge === "object") {
      rejectUnknownFields(GITHUB_BRIDGE_FIELDS, definition.sync.github.bridge, "sync.github.bridge");
    }
    if (definition.sync.github.sourceImpact && typeof definition.sync.github.sourceImpact === "object") {
      rejectUnknownFields(GITHUB_SOURCE_IMPACT_FIELDS, definition.sync.github.sourceImpact, "sync.github.sourceImpact");
    }
    if (definition.sync.github.attest && typeof definition.sync.github.attest === "object") {
      rejectUnknownFields(GITHUB_ATTEST_FIELDS, definition.sync.github.attest, "sync.github.attest");
    }
    if (definition.sync.github.contract && typeof definition.sync.github.contract === "object") {
      rejectUnknownFields(GITHUB_CONTRACT_FIELDS, definition.sync.github.contract, "sync.github.contract");
      if (definition.sync.github.contract.schema && typeof definition.sync.github.contract.schema === "object") {
        rejectUnknownFields(GITHUB_CONTRACT_SCHEMA_FIELDS, definition.sync.github.contract.schema, "sync.github.contract.schema");
      }
    }
    if (definition.sync.github.hygiene && typeof definition.sync.github.hygiene === "object") {
      rejectUnknownFields(GITHUB_HYGIENE_FIELDS, definition.sync.github.hygiene, "sync.github.hygiene");
    }
    if (definition.sync.github.pages && typeof definition.sync.github.pages === "object") {
      rejectUnknownFields(GITHUB_SYNC_PAGES_FIELDS, definition.sync.github.pages, "sync.github.pages");
      if (definition.sync.github.pages.triggers && typeof definition.sync.github.pages.triggers === "object") {
        rejectUnknownFields(GITHUB_SYNC_PAGES_TRIGGERS_FIELDS, definition.sync.github.pages.triggers, "sync.github.pages.triggers");
        const main = definition.sync.github.pages.triggers.main;
        if (main && typeof main === "object") {
          rejectUnknownFields(GITHUB_SYNC_PAGES_MAIN_TRIGGER_FIELDS, main, "sync.github.pages.triggers.main");
        }
      }
    }
  }
  for (const [id, profile] of Object.entries(definition.agents ?? {})) {
    rejectUnknownFields(AGENT_PROFILE_FIELDS, profile, `Agent profile "${id}"`);
    if (!Array.isArray(profile.command) || profile.command.length === 0 || profile.command.some((part) => typeof part !== "string" || part.length === 0)) {
      throw pipelineError(
        "ASYNC_PIPELINE_AGENT_INVALID",
        `Agent profile "${id}" requires "command": a non-empty array of argv strings (e.g. ["claude", "-p"]).`
      );
    }
    const model = profile.model;
    const isEnvRef = typeof model === "object" && model !== null && model.kind === "async-pipeline.env.var";
    if (!isEnvRef && (typeof model !== "string" || model.length === 0)) {
      throw pipelineError(
        "ASYNC_PIPELINE_AGENT_INVALID",
        `Agent profile "${id}" requires "model": a non-empty string or env.var(...). The model is the profile's cache identity; the command is deliberately not.`
      );
    }
  }
  for (const [id, defaults] of Object.entries(definition.taskDefaults ?? {})) {
    rejectUnknownFields(TASK_FIELDS, defaults, `taskDefaults["${id}"]`);
  }
  for (const [id, profile] of Object.entries(definition.execution ?? {})) {
    rejectUnknownFields(EXECUTION_PROFILE_FIELDS, profile, `Execution profile "${id}"`);
    if (profile.kind !== "local" && profile.kind !== "github") {
      throw pipelineError(
        "ASYNC_PIPELINE_EXECUTION_INVALID",
        `Execution profile "${id}" requires kind "local" or "github".`
      );
    }
    if (profile.provider !== undefined && !CONTAINER_PROVIDERS.has(profile.provider)) {
      throw pipelineError(
        "ASYNC_PIPELINE_EXECUTION_INVALID",
        `Execution profile "${id}" has unsupported provider "${profile.provider}". Use auto, docker, apple-container, or lima.`
      );
    }
    if (profile.kind === "local" && ("runsOn" in profile || "runsOnMatrix" in profile)) {
      throw pipelineError(
        "ASYNC_PIPELINE_EXECUTION_INVALID",
        `Execution profile "${id}" is local and cannot set GitHub runner fields. Use execution.github(...) for runsOn or runsOnMatrix.`
      );
    }
  }
  for (const [id, jobDefinition] of Object.entries(definition.jobs ?? {})) {
    rejectUnknownFields(JOB_FIELDS, jobDefinition, `Job "${id}"`);
    if (jobDefinition.github) {
      rejectUnknownFields(GITHUB_JOB_FIELDS, jobDefinition.github, `Job "${id}" github config`);
      if (jobDefinition.github.pages) {
        validateGitHubPagesConfig(id, jobDefinition.github.pages);
      }
      if (jobDefinition.github.permissions) {
        rejectUnknownFields(GITHUB_PERMISSION_FIELDS, jobDefinition.github.permissions, `Job "${id}" github permissions`);
      }
    }
  }
}

function normalizePipelineSections(definition: PipelineDefinition): PipelineDefinition {
  return {
    ...definition,
    agents: normalizeSection("agents", definition.agents),
    sandboxes: normalizeSection("sandboxes", definition.sandboxes),
    taskDefaults: normalizeSection("taskDefaults", definition.taskDefaults),
    triggers: normalizeSection("triggers", definition.triggers),
    sources: normalizeSection("sources", definition.sources),
    tasks: normalizeSection("tasks", definition.tasks),
    jobs: normalizeSection("jobs", definition.jobs)
  };
}

function normalizeSection<Key extends keyof typeof SECTION_KINDS, Value extends object | undefined>(
  key: Key,
  value: Value
): Value {
  if (value === undefined) return value;
  if (!isObjectRecord(value)) {
    throw pipelineError("ASYNC_PIPELINE_SECTION_INVALID", `Pipeline section "${key}" must be an object.`);
  }

  const expectedKind = SECTION_KINDS[key];
  const metadata = assertSupportedDeclaration(value);
  if (metadata) {
    if (metadata.kind !== expectedKind) {
      throw pipelineError(
        "ASYNC_PIPELINE_SECTION_KIND_MISMATCH",
        `Pipeline section "${key}" expected declaration kind "${expectedKind}", received "${metadata.kind}".`
      );
    }
    return value;
  }

  return brandDeclaration(value, expectedKind) as Value;
}

function flattenTaskDefinitions(definitions: TaskSectionDefinition): FlattenedTaskDefinition[] {
  const tasks: FlattenedTaskDefinition[] = [];
  const seen = new Set<TaskId>();

  function visit(node: TaskGroupDefinition, path: string[]): void {
    for (const [key, value] of Object.entries(node)) {
      validateTaskTreeKey(key, path);
      if (!isObjectRecord(value)) {
        throw pipelineError("ASYNC_PIPELINE_TASK_TREE_INVALID", `Task tree entry "${[...path, key].join(".")}" must be an object.`);
      }
      const isTask = isTaskDefinitionNode(value, path);
      if (isTask) {
        const id = taskTreeId(path, key);
        validateLocalTaskId(id);
        if (seen.has(id)) {
          throw pipelineError("ASYNC_PIPELINE_TASK_ID_COLLISION", `Task group entry "${[...path, key].join(".")}" normalizes to duplicate task id "${id}".`);
        }
        seen.add(id);
        rejectUnknownFields(TASK_FIELDS, value, `Task "${id}"`);
        tasks.push({ id, definition: value as TaskDefinition, groupPath: path });
        continue;
      }
      if (key.includes(".")) {
        throw pipelineError("ASYNC_PIPELINE_TASK_GROUP_INVALID_KEY", `Task group key "${key}" cannot contain ".". Use nested objects instead.`);
      }
      visit(value as TaskGroupDefinition, [...path, key]);
    }
  }

  visit(definitions, []);
  return tasks;
}

function validateTaskTreeKey(key: string, path: string[]): void {
  if (!key.trim()) {
    throw pipelineError("ASYNC_PIPELINE_TASK_GROUP_INVALID_KEY", "Task group key cannot be empty.");
  }
  if (key.includes(":")) {
    throw pipelineError("ASYNC_PIPELINE_TASK_GROUP_INVALID_KEY", `Task group key "${key}" cannot contain ":". Use source namespaces through dependsOn instead.`);
  }
  if (path.length > 0 && key.includes(".")) {
    throw pipelineError("ASYNC_PIPELINE_TASK_GROUP_INVALID_KEY", `Nested task group key "${key}" cannot contain ".". Use nested objects instead.`);
  }
}

function taskTreeId(path: string[], key: string): TaskId {
  const segments = path.length > 0 && (key === "default" || key === "index") ? path : [...path, key];
  return segments.join(".");
}

function isTaskDefinitionNode(value: Record<string, unknown>, path: string[]): boolean {
  const metadata = assertSupportedDeclaration(value);
  if (metadata?.kind === "task") return true;
  if (metadata?.kind.startsWith("section.")) return false;
  if (metadata) return false;
  if (Object.keys(value).some((key) => TASK_FIELDS.has(key))) return true;
  return path.length === 0 && Object.keys(value).length === 0;
}

function resolveTaskDependencies(taskId: TaskId, groupPath: string[], dependencies: TaskId[], knownTaskIds: Set<TaskId>): TaskId[] {
  return dependencies.map((dependency) => resolveTaskDependency(taskId, groupPath, dependency, knownTaskIds));
}

function resolveTaskDependency(taskId: TaskId, groupPath: string[], dependency: TaskId, knownTaskIds: Set<TaskId>): TaskId {
  if (isNamespacedTaskRef(dependency) || groupPath.length === 0) return dependency;

  const groupCandidate = [...groupPath, dependency].join(".");
  const groupMatch = knownTaskIds.has(groupCandidate);
  const rootMatch = knownTaskIds.has(dependency);
  if (groupMatch && rootMatch && groupCandidate !== dependency) {
    throw pipelineError(
      "ASYNC_PIPELINE_TASK_DEPENDENCY_AMBIGUOUS",
      `Task "${taskId}" depends on ambiguous local task "${dependency}". Use "${groupCandidate}" or "${dependency}" explicitly.`
    );
  }
  if (groupMatch) return groupCandidate;
  return dependency;
}

export function definePipeline(definition: PipelineDefinition): NormalizedPipeline {
  return normalizePipeline(definition);
}

export function normalizePipeline(definition: PipelineDefinition): NormalizedPipeline {
  definition = normalizePipelineSections(definition);
  validateDefinitionShape(definition);
  const namedInputs = definition.namedInputs ?? {};
  const cacheRegistry = normalizeCacheRegistry(definition.cache);
  const sources: Record<SourceId, NormalizedSource> = {};

  for (const [id, sourceDefinition] of Object.entries(definition.sources ?? {})) {
    validateSourceId(id);
    sources[id] = normalizeSource(id, sourceDefinition);
  }

  const tasks: Record<TaskId, NormalizedTask> = {};
  const flattenedTaskDefinitions = flattenTaskDefinitions(definition.tasks);
  const knownTaskIds = new Set(flattenedTaskDefinitions.map((entry) => entry.id));

  for (const { id, definition: taskDefinition, groupPath } of flattenedTaskDefinitions) {
    validateLocalTaskId(id);
    const defaults = definition.taskDefaults?.[id] ?? definition.taskDefaults?.[taskName(id)] ?? {};
    const merged = { ...defaults, ...taskDefinition };
    const runItems = merged.steps ? [...merged.steps] : runItemsFromDefinition(merged.run);
    const runItemsOwnedByTask = merged.steps !== undefined ? taskDefinition.steps !== undefined : taskDefinition.run !== undefined;
    const { steps, cacheDirectives, dependsOnDirectives } = partitionRunItems(runItems);
    const liftedDependsOn = resolveTaskDependencies(id, groupPath, uniqueTaskIds([
      ...(merged.dependsOn ?? []),
      ...dependsOnDirectives.flatMap((directive) => directive.taskIds)
    ]), knownTaskIds);
    const taskOwnedCacheDirective = runItemsOwnedByTask ? cacheDirectives[0] : undefined;
    const taskContainsAgentStep = steps.some(isAgentStep);
    const cacheInput = taskDefinition.cache !== undefined
      ? taskDefinition.cache
      : taskOwnedCacheDirective ?? (taskContainsAgentStep ? false : merged.cache ?? cacheDirectives[0]);
    const cache = normalizeCache(cacheInput, cacheRegistry);
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
    agents: normalizeAgents(definition.agents),
    sandboxes: normalizeSandboxes(definition.sandboxes),
    execution: normalizeExecutionProfiles(definition.execution),
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

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEnvVarRef(value: unknown): value is EnvVarRef {
  return isObjectRecord(value) && value.kind === "async-pipeline.env.var";
}

function normalizeAgents(definitions: Record<AgentProfileId, AgentProfileDefinition> = {}): Record<AgentProfileId, AgentProfileDefinition> {
  const normalized: Record<AgentProfileId, AgentProfileDefinition> = {};
  for (const [id, profile] of Object.entries(definitions)) {
    normalized[id] = {
      command: [...profile.command],
      model: typeof profile.model === "string" ? profile.model : { ...profile.model }
    };
  }
  return normalized;
}

function normalizeSandboxes(definitions: Record<SandboxId, SandboxDefinition> = {}): Record<SandboxId, SandboxDefinition> {
  const normalized: Record<SandboxId, SandboxDefinition> = {};
  for (const [id, definition] of Object.entries(definitions)) {
    normalized[id] = cloneSandboxDefinition(definition);
  }
  return normalized;
}

function normalizeExecutionProfiles(definitions: Record<ExecutionProfileId, ExecutionProfileDefinition> = {}): Record<ExecutionProfileId, ExecutionProfileDefinition> {
  const normalized: Record<ExecutionProfileId, ExecutionProfileDefinition> = {};
  for (const [id, definition] of Object.entries(definitions)) {
    normalized[id] = cloneExecutionProfile(definition);
  }
  return normalized;
}

function normalizeCommandPolicy(policy: CommandPolicy): CommandPolicy {
  return command.policy(policy);
}

function cloneSandboxDefinition(definition: SandboxDefinition): SandboxDefinition {
  if (definition.kind === "docker" || definition.kind === "container") {
    return {
      ...definition,
      volumes: definition.volumes ? definition.volumes.map((volume) => ({ ...volume })) : undefined
    };
  }
  return { ...definition };
}

function cloneExecutionProfile(definition: ExecutionProfileDefinition): ExecutionProfileDefinition {
  if (definition.kind === "github") {
    return {
      ...definition,
      runsOn: definition.runsOn ? cloneRunsOnEntry(definition.runsOn) : undefined,
      runsOnMatrix: definition.runsOnMatrix ? definition.runsOnMatrix.map(cloneRunsOnEntry) : undefined
    };
  }
  return { ...definition };
}

function cloneRunsOnEntry(entry: string | string[]): string | string[] {
  return Array.isArray(entry) ? [...entry] : entry;
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
  if (github.pages && github.runsOnMatrix !== undefined) {
    throw pipelineError(
      "ASYNC_PIPELINE_GITHUB_PAGES_INVALID",
      `Job "${jobId}" cannot combine github.pages with github.runsOnMatrix; a Pages deploy expects one uploaded artifact.`
    );
  }
}

function validateGitHubPagesConfig(jobId: JobId, pages: GitHubPagesConfig): void {
  if (!isObjectRecord(pages)) {
    throw pipelineError(
      "ASYNC_PIPELINE_GITHUB_PAGES_INVALID",
      `Job "${jobId}" github.pages must be an object with a build config.`
    );
  }
  rejectUnknownFields(GITHUB_PAGES_FIELDS, pages, `Job "${jobId}" github.pages`);
  if (!isObjectRecord(pages.build)) {
    throw pipelineError(
      "ASYNC_PIPELINE_GITHUB_PAGES_INVALID",
      `Job "${jobId}" github.pages.build must be an object.`
    );
  }
  if (pages.build.kind === "jekyll") {
    rejectUnknownFields(GITHUB_PAGES_JEKYLL_BUILD_FIELDS, pages.build, `Job "${jobId}" github.pages.build`);
    validateNonEmptyString(jobId, "github.pages.build.source", pages.build.source);
    if (pages.build.destination !== undefined) {
      validateNonEmptyString(jobId, "github.pages.build.destination", pages.build.destination);
    }
  } else if (pages.build.kind === "static") {
    rejectUnknownFields(GITHUB_PAGES_STATIC_BUILD_FIELDS, pages.build, `Job "${jobId}" github.pages.build`);
    validateNonEmptyString(jobId, "github.pages.build.path", pages.build.path);
  } else if (pages.build.kind === "prerender") {
    rejectUnknownFields(GITHUB_PAGES_PRERENDER_BUILD_FIELDS, pages.build, `Job "${jobId}" github.pages.build`);
    validateNonEmptyString(jobId, "github.pages.build.path", pages.build.path);
    if (pages.build.validateIndex !== undefined && typeof pages.build.validateIndex !== "boolean") {
      throw pipelineError(
        "ASYNC_PIPELINE_GITHUB_PAGES_INVALID",
        `Job "${jobId}" github.pages.build.validateIndex must be a boolean.`
      );
    }
    if (pages.build.spaFallback !== undefined && typeof pages.build.spaFallback !== "boolean") {
      throw pipelineError(
        "ASYNC_PIPELINE_GITHUB_PAGES_INVALID",
        `Job "${jobId}" github.pages.build.spaFallback must be a boolean.`
      );
    }
  } else {
    throw pipelineError(
      "ASYNC_PIPELINE_GITHUB_PAGES_INVALID",
      `Job "${jobId}" github.pages.build.kind must be "jekyll", "static", or "prerender".`
    );
  }
  if (pages.artifactName !== undefined) {
    validateNonEmptyString(jobId, "github.pages.artifactName", pages.artifactName);
  }
  if (typeof pages.environment === "string") {
    validateNonEmptyString(jobId, "github.pages.environment", pages.environment);
  } else if (pages.environment !== undefined) {
    if (!isObjectRecord(pages.environment)) {
      throw pipelineError(
        "ASYNC_PIPELINE_GITHUB_PAGES_INVALID",
        `Job "${jobId}" github.pages.environment must be a string or an object with a name.`
      );
    }
    rejectUnknownFields(new Set(["name", "url"]), pages.environment, `Job "${jobId}" github.pages.environment`);
    validateNonEmptyString(jobId, "github.pages.environment.name", pages.environment.name);
    if (pages.environment.url !== undefined) {
      validateNonEmptyString(jobId, "github.pages.environment.url", pages.environment.url);
    }
  }
}

function validateNonEmptyString(jobId: JobId, field: string, value: unknown): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw pipelineError(
      "ASYNC_PIPELINE_GITHUB_PAGES_INVALID",
      `Job "${jobId}" ${field} must be a non-empty string.`
    );
  }
}

function githubConfigFromExecution(profile: ExecutionProfileDefinition | undefined): GitHubJobConfig | undefined {
  if (!profile || profile.kind !== "github") return undefined;
  return {
    runsOn: profile.runsOn ? cloneRunsOnEntry(profile.runsOn) : undefined,
    runsOnMatrix: profile.runsOnMatrix ? profile.runsOnMatrix.map(cloneRunsOnEntry) : undefined
  };
}

export function githubConfigForJob(pipeline: NormalizedPipeline, jobDefinition: NormalizedJob): GitHubJobConfig | undefined {
  const profileGithub = githubConfigFromExecution(jobDefinition.execution ? pipeline.execution[jobDefinition.execution] : undefined);
  if (!profileGithub && !jobDefinition.github) return undefined;
  return {
    ...profileGithub,
    ...jobDefinition.github
  };
}

function validateExecutionProfiles(pipeline: NormalizedPipeline): void {
  for (const [id, profile] of Object.entries(pipeline.execution)) {
    if (profile.sandbox !== undefined) {
      const sandboxDefinition = pipeline.sandboxes[profile.sandbox];
      if (!sandboxDefinition) {
        throw pipelineError(
          "ASYNC_PIPELINE_EXECUTION_UNKNOWN_SANDBOX",
          `Execution profile "${id}" references unknown sandbox "${profile.sandbox}". Declare it under sandboxes.`
        );
      }
      if (profile.provider !== undefined && sandboxDefinition.kind !== "container") {
        throw pipelineError(
          "ASYNC_PIPELINE_EXECUTION_PROVIDER_MISMATCH",
          `Execution profile "${id}" sets provider "${profile.provider}", but providers only apply to sandbox.container(...) definitions.`
        );
      }
    } else if (profile.provider !== undefined) {
      throw pipelineError(
        "ASYNC_PIPELINE_EXECUTION_PROVIDER_MISMATCH",
        `Execution profile "${id}" sets provider "${profile.provider}" without a sandbox.`
      );
    }
    if (profile.kind === "github") {
      validateJobRunsOn(`execution:${id}`, githubConfigFromExecution(profile));
    }
  }
}

function validateJobExecution(pipeline: NormalizedPipeline, jobDefinition: NormalizedJob): void {
  if (!jobDefinition.execution) return;
  const profile = pipeline.execution[jobDefinition.execution];
  if (!profile) {
    throw pipelineError(
      "ASYNC_PIPELINE_EXECUTION_UNKNOWN",
      `Job "${jobDefinition.id}" references unknown execution profile "${jobDefinition.execution}". Declare it under execution.`
    );
  }
  const effectiveGithub = githubConfigForJob(pipeline, jobDefinition);
  validateJobRunsOn(jobDefinition.id, effectiveGithub);
  if (profile.kind === "github" && profile.provider === "apple-container") {
    validateAppleContainerRunsOn(jobDefinition.id, effectiveGithub);
  }
}

function validateAppleContainerRunsOn(jobId: JobId, github: GitHubJobConfig | undefined): void {
  const entries = github?.runsOnMatrix ?? (github?.runsOn ? [github.runsOn] : []);
  if (entries.length === 0) {
    throw pipelineError(
      "ASYNC_PIPELINE_EXECUTION_RUNNER_UNSUPPORTED",
      `Job "${jobId}" uses provider "apple-container", which requires an explicit self-hosted macOS runner label set.`
    );
  }
  for (const entry of entries) {
    const labels = Array.isArray(entry) ? entry : [entry];
    const normalized = labels.map((label) => label.toLowerCase());
    if (!Array.isArray(entry) || !normalized.includes("self-hosted") || !normalized.includes("macos")) {
      throw pipelineError(
        "ASYNC_PIPELINE_EXECUTION_RUNNER_UNSUPPORTED",
        `Job "${jobId}" uses provider "apple-container", which requires a self-hosted macOS runner label set.`
      );
    }
  }
}

export function validatePipeline(pipeline: NormalizedPipeline): void {
  validateExecutionProfiles(pipeline);
  for (const taskDefinition of Object.values(pipeline.tasks)) {
    for (const dependency of taskDefinition.dependsOn) {
      if (!pipeline.tasks[dependency] && !isKnownExternalTaskRef(pipeline, dependency)) {
        throw new Error(`Task "${taskDefinition.id}" depends on missing task "${dependency}".`);
      }
    }
    if (taskDefinition.cache.enabled && taskDefinition.cache.store) {
      assertCacheStore(pipeline.cache, parseCacheRef(cacheRefFromStoreOptions(taskDefinition.cache, pipeline.cache.default)));
    }
    for (const step of taskDefinition.steps) {
      if (!isAgentStep(step) || typeof step.use !== "string") continue;
      if (!pipeline.agents[step.use]) {
        const known = Object.keys(pipeline.agents).sort();
        throw pipelineError(
          "ASYNC_PIPELINE_AGENT_UNKNOWN",
          `Task "${taskDefinition.id}" uses agent profile "${step.use}", which is not declared in the pipeline's agents block.${known.length > 0 ? ` Known profiles: ${known.join(", ")}.` : " No agent profiles are declared."}`
        );
      }
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
    validateJobExecution(pipeline, jobDefinition);
    if (!jobDefinition.execution) validateJobRunsOn(jobDefinition.id, jobDefinition.github);
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
  return projectPipelineGraph(selectExecutionGraph(pipeline, targets ?? Object.keys(pipeline.tasks)));
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
  const pipeline = sourceDefinition.pipeline ?? DEFAULT_PIPELINE_CONFIG_FILES[0];
  const defaulted = !sourceDefinition.pipeline;
  const normalized = sourceDefinition.type === "git"
    ? {
        ...sourceDefinition,
        id,
        pipeline,
        prepare
      }
    : {
        ...sourceDefinition,
        id,
        pipeline,
        prepare
      };
  if (defaulted) {
    Object.defineProperty(normalized, SOURCE_PIPELINE_DEFAULTED, {
      value: true,
      enumerable: false
    });
  }
  return normalized;
}

export function sourceUsesDefaultPipelineConfig(sourceDefinition: NormalizedSource): boolean {
  return (sourceDefinition as NormalizedSource & { [SOURCE_PIPELINE_DEFAULTED]?: true })[SOURCE_PIPELINE_DEFAULTED] === true;
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
    command: normalizeSyncCommand(sync?.command),
    github: normalizeGitHubSync(sync?.github),
    tasks: normalizeTaskSync(sync?.tasks)
  };
}

function normalizeSyncCommand(command: string | undefined): string {
  if (command === undefined) return "async-pipeline";
  if (typeof command !== "string") {
    throw pipelineError("ASYNC_PIPELINE_SYNC_INVALID_COMMAND", "sync.command must be a string.");
  }
  const normalized = command.trim();
  if (!normalized) {
    throw pipelineError("ASYNC_PIPELINE_SYNC_INVALID_COMMAND", "sync.command cannot be empty.");
  }
  return normalized;
}

const DEFAULT_GITHUB_NODE_VERSION = "24";
const DEFAULT_GITHUB_WORKFLOW_PATH = ".github/workflows/async-pipeline.yml";
const DEFAULT_GITHUB_LOCK_PATH = ".locks/pipeline/github-workflow.lock.json";

function normalizeGitHubSync(github: GitHubSyncInput | undefined): NormalizedGitHubSyncConfig {
  if (github === undefined || github === false) {
    return {
      enabled: false,
      workflow: DEFAULT_GITHUB_WORKFLOW_PATH,
      lock: DEFAULT_GITHUB_LOCK_PATH,
      setup: "pnpm",
      nodeVersion: DEFAULT_GITHUB_NODE_VERSION,
      runtime: [],
      cache: true,
      dependencyCache: true,
      dependabotAutoMerge: normalizeDependabotAutoMerge(undefined),
      packagePreviews: normalizePackagePreviews(undefined),
      evidence: normalizeGitHubEvidence(undefined),
      bridge: normalizeGitHubBridge(undefined),
      pages: normalizeGitHubPagesSync(undefined),
      sourceImpact: normalizeGitHubSourceImpact(undefined),
      attest: normalizeGitHubAttest(undefined),
      contract: normalizeGitHubContract(undefined),
      hygiene: normalizeGitHubHygiene(undefined)
    };
  }
  if (github === true) {
    return {
      enabled: true,
      workflow: DEFAULT_GITHUB_WORKFLOW_PATH,
      lock: DEFAULT_GITHUB_LOCK_PATH,
      setup: "pnpm",
      nodeVersion: DEFAULT_GITHUB_NODE_VERSION,
      runtime: [],
      cache: true,
      dependencyCache: true,
      dependabotAutoMerge: normalizeDependabotAutoMerge(undefined),
      packagePreviews: normalizePackagePreviews(undefined),
      evidence: normalizeGitHubEvidence(undefined),
      bridge: normalizeGitHubBridge(undefined),
      pages: normalizeGitHubPagesSync(undefined),
      sourceImpact: normalizeGitHubSourceImpact(undefined),
      attest: normalizeGitHubAttest(undefined),
      contract: normalizeGitHubContract(undefined),
      hygiene: normalizeGitHubHygiene(undefined)
    };
  }
  return {
    enabled: true,
    workflow: github.workflow ?? DEFAULT_GITHUB_WORKFLOW_PATH,
    lock: github.lock ?? DEFAULT_GITHUB_LOCK_PATH,
    setup: normalizeGitHubSetup(github.setup),
    nodeVersion: normalizeGitHubNodeVersion(github.nodeVersion),
    runtime: normalizeGitHubRuntime(github.runtime),
    cache: github.cache ?? true,
    dependencyCache: github.dependencyCache ?? true,
    dependabotAutoMerge: normalizeDependabotAutoMerge(github.dependabotAutoMerge),
    packagePreviews: normalizePackagePreviews(github.packagePreviews),
    evidence: normalizeGitHubEvidence(github.evidence),
    bridge: normalizeGitHubBridge(github.bridge),
    pages: normalizeGitHubPagesSync(github.pages),
    sourceImpact: normalizeGitHubSourceImpact(github.sourceImpact),
    attest: normalizeGitHubAttest(github.attest),
    contract: normalizeGitHubContract(github.contract),
    hygiene: normalizeGitHubHygiene(github.hygiene)
  };
}

function normalizeGitHubRuntime(runtime: string | string[] | undefined): string[] {
  if (runtime === undefined) return [];
  const entries = Array.isArray(runtime) ? runtime : [runtime];
  if (entries.length === 0) {
    throw pipelineError("ASYNC_PIPELINE_SYNC_INVALID_RUNTIME", "sync.github.runtime cannot be empty.");
  }
  const normalized = entries.map((entry) => {
    if (typeof entry !== "string") {
      throw pipelineError("ASYNC_PIPELINE_SYNC_INVALID_RUNTIME", "sync.github.runtime entries must be strings like node@24 or deno@2.");
    }
    const value = entry.trim();
    const match = /^(node|deno|bun)(?:@([A-Za-z0-9._+/-]+))?$/.exec(value);
    if (!match) {
      throw pipelineError("ASYNC_PIPELINE_SYNC_INVALID_RUNTIME", `Invalid GitHub runtime "${entry}". Use node, deno, or bun with an optional version, for example node@24 or deno@2.`);
    }
    return value;
  });
  return [...new Set(normalized)];
}

function normalizeGitHubSetup(setup: GitHubSetupProvider | undefined): Exclude<GitHubSetupProvider, "auto"> {
  if (setup === undefined || setup === "auto") return "pnpm";
  if (GITHUB_SETUP_PROVIDERS.has(setup)) return setup;
  throw pipelineError("ASYNC_PIPELINE_SYNC_INVALID_GITHUB_SETUP", `Invalid GitHub sync setup "${setup}". Use "auto", "async", "pnpm", or "node".`);
}

function normalizeGitHubNodeVersion(nodeVersion: number | string | undefined): string {
  if (nodeVersion === undefined) return DEFAULT_GITHUB_NODE_VERSION;
  const normalized = String(nodeVersion).trim();
  if (!/^\d+(?:\.\d+){0,2}$/.test(normalized)) {
    throw pipelineError("ASYNC_PIPELINE_SYNC_INVALID_NODE_VERSION", `Invalid GitHub sync nodeVersion "${nodeVersion}". Use a version like 24 or 24.1.0.`);
  }
  return normalized;
}

function normalizeDependabotAutoMerge(input: DependabotAutoMergeInput | undefined): NormalizedDependabotAutoMergeConfig {
  if (!input) {
    return { enabled: false, ecosystems: ["github-actions", "npm", "deno"] };
  }
  if (input === true) {
    return { enabled: true, ecosystems: ["github-actions", "npm", "deno"] };
  }
  const ecosystems = input.ecosystems ?? ["github-actions", "npm", "deno"];
  if (ecosystems.length === 0) {
    throw pipelineError("ASYNC_PIPELINE_DEPENDABOT_AUTO_MERGE_INVALID", "sync.github.dependabotAutoMerge.ecosystems cannot be empty.");
  }
  for (const ecosystem of ecosystems) {
    if (!DEPENDABOT_AUTO_MERGE_ECOSYSTEMS.has(ecosystem)) {
      throw pipelineError(
        "ASYNC_PIPELINE_DEPENDABOT_AUTO_MERGE_INVALID",
        `Unsupported Dependabot auto-merge ecosystem "${ecosystem}". Use one of: ${[...DEPENDABOT_AUTO_MERGE_ECOSYSTEMS].join(", ")}.`
      );
    }
  }
  return {
    enabled: true,
    ecosystems: [...new Set(ecosystems)]
  };
}

function normalizePackagePreviews(input: PackagePreviewsInput | undefined): NormalizedPackagePreviewsConfig {
  if (!input) {
    return {
      enabled: false,
      registry: "https://npm.pkg.github.com",
      tokenEnv: "GITHUB_TOKEN",
      comment: true
    };
  }
  if (input === true) {
    return {
      enabled: true,
      registry: "https://npm.pkg.github.com",
      tokenEnv: "GITHUB_TOKEN",
      comment: true
    };
  }
  const output: NormalizedPackagePreviewsConfig = {
    enabled: true,
    package: normalizeOptionalNonEmptyString(input.package, "sync.github.packagePreviews.package"),
    target: normalizeOptionalNonEmptyString(input.target, "sync.github.packagePreviews.target"),
    registry: normalizeOptionalNonEmptyString(input.registry, "sync.github.packagePreviews.registry") ?? "https://npm.pkg.github.com",
    namespace: normalizeOptionalNonEmptyString(input.namespace, "sync.github.packagePreviews.namespace"),
    tokenEnv: normalizeOptionalNonEmptyString(input.tokenEnv, "sync.github.packagePreviews.tokenEnv") ?? "GITHUB_TOKEN",
    comment: input.comment ?? true
  };
  if (typeof output.comment !== "boolean") {
    throw pipelineError("ASYNC_PIPELINE_PACKAGE_PREVIEWS_INVALID", "sync.github.packagePreviews.comment must be a boolean.");
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(output.tokenEnv)) {
    throw pipelineError("ASYNC_PIPELINE_PACKAGE_PREVIEWS_INVALID", `sync.github.packagePreviews.tokenEnv must be an environment variable name. Found: ${output.tokenEnv}.`);
  }
  return output;
}

function normalizeGitHubEvidence(input: GitHubEvidenceInput | undefined): NormalizedGitHubEvidenceConfig {
  const disabled: NormalizedGitHubEvidenceConfig = {
    enabled: false,
    job: "evidence",
    paths: [".async/runs"],
    receiptPaths: [".async/actions/receipts/**/*.json"],
    artifactNamePrefix: "async-evidence",
    retentionDays: 14,
    ifNoFilesFound: "warn",
    includeSummary: true
  };
  if (!input) return disabled;
  if (input === true) {
    return { ...disabled, enabled: true };
  }
  const output: NormalizedGitHubEvidenceConfig = {
    enabled: true,
    job: normalizeOptionalNonEmptyString(input.job, "sync.github.evidence.job", "ASYNC_PIPELINE_GITHUB_EVIDENCE_INVALID") ?? "evidence",
    paths: normalizeGitHubEvidencePaths(input.paths, "sync.github.evidence.paths", [".async/runs"]),
    receiptPaths: normalizeGitHubEvidencePaths(input.receiptPaths, "sync.github.evidence.receiptPaths", [".async/actions/receipts/**/*.json"]),
    artifactNamePrefix: normalizeOptionalNonEmptyString(input.artifactNamePrefix, "sync.github.evidence.artifactNamePrefix", "ASYNC_PIPELINE_GITHUB_EVIDENCE_INVALID") ?? "async-evidence",
    retentionDays: input.retentionDays ?? 14,
    ifNoFilesFound: input.ifNoFilesFound ?? "warn",
    includeSummary: input.includeSummary ?? true
  };
  validateGitHubEvidenceJob(output.job);
  if (!/^[A-Za-z0-9_.-]+$/.test(output.artifactNamePrefix)) {
    throw pipelineError("ASYNC_PIPELINE_GITHUB_EVIDENCE_INVALID", "sync.github.evidence.artifactNamePrefix may only contain letters, numbers, dash, underscore, and dot.");
  }
  if (!Number.isInteger(output.retentionDays) || output.retentionDays < 1 || output.retentionDays > 90) {
    throw pipelineError("ASYNC_PIPELINE_GITHUB_EVIDENCE_INVALID", "sync.github.evidence.retentionDays must be an integer from 1 to 90.");
  }
  if (!["ignore", "warn", "error"].includes(output.ifNoFilesFound)) {
    throw pipelineError("ASYNC_PIPELINE_GITHUB_EVIDENCE_INVALID", "sync.github.evidence.ifNoFilesFound must be ignore, warn, or error.");
  }
  if (typeof output.includeSummary !== "boolean") {
    throw pipelineError("ASYNC_PIPELINE_GITHUB_EVIDENCE_INVALID", "sync.github.evidence.includeSummary must be a boolean.");
  }
  return output;
}

function normalizeGitHubEvidencePaths(paths: string[] | undefined, field: string, fallback: string[]): string[] {
  if (paths === undefined) return fallback;
  if (!Array.isArray(paths)) {
    throw pipelineError("ASYNC_PIPELINE_GITHUB_EVIDENCE_INVALID", `${field} must be an array of repo-relative paths or globs.`);
  }
  if (paths.length === 0) {
    throw pipelineError("ASYNC_PIPELINE_GITHUB_EVIDENCE_INVALID", `${field} cannot be empty.`);
  }
  const normalized = paths.map((path, index) => {
    const value = normalizeOptionalNonEmptyString(path, `${field}[${index}]`, "ASYNC_PIPELINE_GITHUB_EVIDENCE_INVALID");
    if (!value) {
      throw pipelineError("ASYNC_PIPELINE_GITHUB_EVIDENCE_INVALID", `${field}[${index}] cannot be empty.`);
    }
    validateSafeEvidencePathLike(value, `${field}[${index}]`);
    return value;
  });
  return [...new Set(normalized)];
}

function validateSafeEvidencePathLike(value: string, field: string): void {
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value)) {
    throw pipelineError("ASYNC_PIPELINE_GITHUB_EVIDENCE_INVALID", `${field} must be repo-relative.`);
  }
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "..")) {
    throw pipelineError("ASYNC_PIPELINE_GITHUB_EVIDENCE_INVALID", `${field} cannot contain empty segments or parent-directory segments.`);
  }
  if (value.startsWith(".github/workflows/")) {
    throw pipelineError("ASYNC_PIPELINE_GITHUB_EVIDENCE_INVALID", `${field} cannot include .github/workflows/**.`);
  }
}

function validateGitHubEvidenceJob(jobId: string): void {
  if (!jobId.trim()) {
    throw pipelineError("ASYNC_PIPELINE_GITHUB_EVIDENCE_INVALID", "sync.github.evidence.job cannot be empty.");
  }
  if (jobId.includes(":")) {
    throw pipelineError("ASYNC_PIPELINE_GITHUB_EVIDENCE_INVALID", "sync.github.evidence.job cannot contain source namespace delimiter ':'.");
  }
}

function normalizeGitHubSourceImpact(input: GitHubSourceImpactInput | undefined): NormalizedGitHubSourceImpactConfig {
  if (!input) return { enabled: false, jobs: [] };
  if (input === true) return { enabled: true, jobs: [] };
  const jobs = input.jobs ?? [];
  if (!Array.isArray(jobs)) {
    throw pipelineError("ASYNC_PIPELINE_GITHUB_SOURCE_IMPACT_INVALID", "sync.github.sourceImpact.jobs must be an array of job ids.");
  }
  if (jobs.length === 0 && input.jobs !== undefined) {
    throw pipelineError("ASYNC_PIPELINE_GITHUB_SOURCE_IMPACT_INVALID", "sync.github.sourceImpact.jobs cannot be empty.");
  }
  const normalized = jobs.map((jobId, index) => {
    const value = normalizeOptionalNonEmptyString(jobId, `sync.github.sourceImpact.jobs[${index}]`, "ASYNC_PIPELINE_GITHUB_SOURCE_IMPACT_INVALID");
    if (!value) {
      throw pipelineError("ASYNC_PIPELINE_GITHUB_SOURCE_IMPACT_INVALID", `sync.github.sourceImpact.jobs[${index}] cannot be empty.`);
    }
    if (value.includes(":")) {
      throw pipelineError("ASYNC_PIPELINE_GITHUB_SOURCE_IMPACT_INVALID", "sync.github.sourceImpact.jobs cannot contain source namespace delimiter ':'.");
    }
    return value;
  });
  return { enabled: true, jobs: [...new Set(normalized)] };
}

function normalizeGitHubAttest(input: GitHubAttestInput | undefined): NormalizedGitHubAttestConfig {
  const disabled: NormalizedGitHubAttestConfig = {
    enabled: false,
    artifacts: [],
    subjectManifest: ".async/attest/subjects.json",
    sbomPath: ".async/attest/sbom.json",
    evidencePath: ".async/actions/receipts/attest.json",
    requireNpmProvenance: false,
    tarballScan: false,
    githubAttestation: false
  };
  if (!input) return disabled;
  if (input === true) {
    return {
      ...disabled,
      enabled: true,
      requireNpmProvenance: true,
      tarballScan: true
    };
  }
  const output: NormalizedGitHubAttestConfig = {
    enabled: true,
    packagePath: normalizeOptionalNonEmptyString(input.packagePath, "sync.github.attest.packagePath", "ASYNC_PIPELINE_GITHUB_ATTEST_INVALID"),
    artifacts: normalizeGitHubAttestPaths(input.artifacts, "sync.github.attest.artifacts", []),
    subjectManifest: normalizeGitHubAttestPath(input.subjectManifest, "sync.github.attest.subjectManifest", ".async/attest/subjects.json"),
    sbomPath: normalizeGitHubAttestPath(input.sbomPath, "sync.github.attest.sbomPath", ".async/attest/sbom.json"),
    evidencePath: normalizeGitHubAttestPath(input.evidencePath, "sync.github.attest.evidencePath", ".async/actions/receipts/attest.json"),
    requireNpmProvenance: input.requireNpmProvenance ?? false,
    tarballScan: input.tarballScan ?? false,
    githubAttestation: input.githubAttestation ?? false
  };
  if (output.packagePath) validateSafeAttestPathLike(output.packagePath, "sync.github.attest.packagePath");
  for (const [field, value] of [
    ["requireNpmProvenance", output.requireNpmProvenance],
    ["tarballScan", output.tarballScan],
    ["githubAttestation", output.githubAttestation]
  ] as const) {
    if (typeof value !== "boolean") {
      throw pipelineError("ASYNC_PIPELINE_GITHUB_ATTEST_INVALID", `sync.github.attest.${field} must be a boolean.`);
    }
  }
  return output;
}

function normalizeGitHubAttestPaths(paths: string[] | undefined, field: string, fallback: string[]): string[] {
  if (paths === undefined) return fallback;
  if (!Array.isArray(paths)) {
    throw pipelineError("ASYNC_PIPELINE_GITHUB_ATTEST_INVALID", `${field} must be an array of repo-relative paths or globs.`);
  }
  const normalized = paths.map((path, index) => normalizeGitHubAttestPath(path, `${field}[${index}]`));
  return [...new Set(normalized)];
}

function normalizeGitHubAttestPath(input: unknown, field: string, fallback?: string): string {
  const value = normalizeOptionalNonEmptyString(input, field, "ASYNC_PIPELINE_GITHUB_ATTEST_INVALID") ?? fallback;
  if (!value) {
    throw pipelineError("ASYNC_PIPELINE_GITHUB_ATTEST_INVALID", `${field} cannot be empty.`);
  }
  validateSafeAttestPathLike(value, field);
  return value;
}

function validateSafeAttestPathLike(value: string, field: string): void {
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value)) {
    throw pipelineError("ASYNC_PIPELINE_GITHUB_ATTEST_INVALID", `${field} must be repo-relative.`);
  }
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "..")) {
    throw pipelineError("ASYNC_PIPELINE_GITHUB_ATTEST_INVALID", `${field} cannot contain empty segments or parent-directory segments.`);
  }
  if (value.startsWith(".github/workflows/")) {
    throw pipelineError("ASYNC_PIPELINE_GITHUB_ATTEST_INVALID", `${field} cannot include .github/workflows/**.`);
  }
}

function normalizeGitHubContract(input: GitHubContractInput | undefined): NormalizedGitHubContractConfig {
  const disabled: NormalizedGitHubContractConfig = {
    enabled: false,
    mode: "off",
    job: "contract",
    api: true,
    claims: true,
    schema: {
      enabled: false,
      sources: [],
      output: ".async/contract/schema.json"
    },
    packagePath: ".",
    evidenceDir: ".async/contract",
    annotations: true
  };
  if (!input) return disabled;
  if (input === true) {
    return { ...disabled, enabled: true, mode: "report" };
  }
  const mode = input.mode ?? "report";
  if (!["off", "report", "check", "strict", "release"].includes(mode)) {
    throw pipelineError("ASYNC_PIPELINE_GITHUB_CONTRACT_INVALID", `sync.github.contract.mode must be off, report, check, strict, or release. Found: ${String(mode)}.`);
  }
  if (mode === "off") return disabled;
  const output: NormalizedGitHubContractConfig = {
    enabled: true,
    mode,
    job: normalizeOptionalNonEmptyString(input.job, "sync.github.contract.job", "ASYNC_PIPELINE_GITHUB_CONTRACT_INVALID") ?? "contract",
    api: input.api ?? true,
    claims: input.claims ?? true,
    schema: normalizeGitHubContractSchema(input.schema),
    packagePath: normalizeOptionalNonEmptyString(input.packagePath, "sync.github.contract.packagePath", "ASYNC_PIPELINE_GITHUB_CONTRACT_INVALID") ?? ".",
    evidenceDir: normalizeOptionalNonEmptyString(input.evidenceDir, "sync.github.contract.evidenceDir", "ASYNC_PIPELINE_GITHUB_CONTRACT_INVALID") ?? ".async/contract",
    annotations: input.annotations ?? true
  };
  if (typeof output.api !== "boolean") {
    throw pipelineError("ASYNC_PIPELINE_GITHUB_CONTRACT_INVALID", "sync.github.contract.api must be a boolean.");
  }
  if (typeof output.claims !== "boolean") {
    throw pipelineError("ASYNC_PIPELINE_GITHUB_CONTRACT_INVALID", "sync.github.contract.claims must be a boolean.");
  }
  if (typeof output.annotations !== "boolean") {
    throw pipelineError("ASYNC_PIPELINE_GITHUB_CONTRACT_INVALID", "sync.github.contract.annotations must be a boolean.");
  }
  validateSafeContractPathLike(output.packagePath, "sync.github.contract.packagePath", { allowDot: true, allowGlob: false });
  validateSafeContractPathLike(output.evidenceDir, "sync.github.contract.evidenceDir", { allowDot: false, allowGlob: false });
  validateGeneratedJobId(output.job, "sync.github.contract.job");
  if (!output.api && !output.claims && !output.schema.enabled) {
    throw pipelineError("ASYNC_PIPELINE_GITHUB_CONTRACT_INVALID", "sync.github.contract must enable at least one of api, claims, or schema.");
  }
  return output;
}

function normalizeGitHubContractSchema(input: boolean | GitHubContractSchemaConfig | undefined): NormalizedGitHubContractSchemaConfig {
  const disabled = {
    enabled: false,
    sources: [],
    output: ".async/contract/schema.json"
  };
  if (!input) return disabled;
  if (input === true) {
    return {
      enabled: true,
      sources: ["schemas/**/*.json", "data/**/*.json"],
      output: ".async/contract/schema.json"
    };
  }
  const enabled = input.enabled ?? true;
  if (typeof enabled !== "boolean") {
    throw pipelineError("ASYNC_PIPELINE_GITHUB_CONTRACT_INVALID", "sync.github.contract.schema.enabled must be a boolean.");
  }
  if (!enabled) return disabled;
  const sources = normalizeGitHubContractPaths(input.sources, "sync.github.contract.schema.sources", ["schemas/**/*.json", "data/**/*.json"]);
  const output = normalizeOptionalNonEmptyString(input.output, "sync.github.contract.schema.output", "ASYNC_PIPELINE_GITHUB_CONTRACT_INVALID") ?? ".async/contract/schema.json";
  validateSafeContractPathLike(output, "sync.github.contract.schema.output", { allowDot: false, allowGlob: false });
  return { enabled: true, sources, output };
}

function normalizeGitHubContractPaths(paths: string[] | undefined, field: string, fallback: string[]): string[] {
  if (paths === undefined) return fallback;
  if (!Array.isArray(paths)) {
    throw pipelineError("ASYNC_PIPELINE_GITHUB_CONTRACT_INVALID", `${field} must be an array of repo-relative paths or globs.`);
  }
  if (paths.length === 0) {
    throw pipelineError("ASYNC_PIPELINE_GITHUB_CONTRACT_INVALID", `${field} cannot be empty.`);
  }
  const normalized = paths.map((path, index) => {
    const value = normalizeOptionalNonEmptyString(path, `${field}[${index}]`, "ASYNC_PIPELINE_GITHUB_CONTRACT_INVALID");
    if (!value) {
      throw pipelineError("ASYNC_PIPELINE_GITHUB_CONTRACT_INVALID", `${field}[${index}] cannot be empty.`);
    }
    validateSafeContractPathLike(value, `${field}[${index}]`, { allowDot: false, allowGlob: true });
    return value;
  });
  return [...new Set(normalized)];
}

function validateGeneratedJobId(value: string, field: string): void {
  if (!value.trim()) {
    throw pipelineError("ASYNC_PIPELINE_GITHUB_CONTRACT_INVALID", `${field} cannot be empty.`);
  }
  if (value.includes(":")) {
    throw pipelineError("ASYNC_PIPELINE_GITHUB_CONTRACT_INVALID", `${field} cannot contain source namespace delimiter ':'.`);
  }
}

function validateSafeContractPathLike(value: string, field: string, options: { allowDot: boolean; allowGlob: boolean }): void {
  if (value === "." && options.allowDot) return;
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value)) {
    throw pipelineError("ASYNC_PIPELINE_GITHUB_CONTRACT_INVALID", `${field} must be repo-relative.`);
  }
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "..")) {
    throw pipelineError("ASYNC_PIPELINE_GITHUB_CONTRACT_INVALID", `${field} cannot contain empty segments or parent-directory segments.`);
  }
  if (!options.allowGlob && /[*?[\]{}]/u.test(value)) {
    throw pipelineError("ASYNC_PIPELINE_GITHUB_CONTRACT_INVALID", `${field} cannot contain glob characters.`);
  }
  if (value.startsWith(".github/workflows/")) {
    throw pipelineError("ASYNC_PIPELINE_GITHUB_CONTRACT_INVALID", `${field} cannot include .github/workflows/**.`);
  }
}

function normalizeGitHubHygiene(input: GitHubHygieneInput | undefined): NormalizedGitHubHygieneConfig {
  const disabled: NormalizedGitHubHygieneConfig = {
    enabled: false,
    mode: "off",
    job: "hygiene",
    profiles: ["package", "github", "docs"],
    releaseGate: false,
    packagePath: ".",
    evidenceDir: ".async/hygiene",
    annotations: true
  };
  if (!input) return disabled;
  if (input === true) {
    return { ...disabled, enabled: true, mode: "report" };
  }
  const mode = input.mode ?? "report";
  if (!["off", "report", "check", "strict", "release"].includes(mode)) {
    throw pipelineError("ASYNC_PIPELINE_GITHUB_HYGIENE_INVALID", `sync.github.hygiene.mode must be off, report, check, strict, or release. Found: ${String(mode)}.`);
  }
  if (mode === "off") return disabled;
  const output: NormalizedGitHubHygieneConfig = {
    enabled: true,
    mode,
    job: normalizeOptionalNonEmptyString(input.job, "sync.github.hygiene.job", "ASYNC_PIPELINE_GITHUB_HYGIENE_INVALID") ?? "hygiene",
    profiles: normalizeGitHubHygieneProfiles(input.profiles),
    releaseGate: input.releaseGate ?? false,
    packagePath: normalizeOptionalNonEmptyString(input.packagePath, "sync.github.hygiene.packagePath", "ASYNC_PIPELINE_GITHUB_HYGIENE_INVALID") ?? ".",
    evidenceDir: normalizeOptionalNonEmptyString(input.evidenceDir, "sync.github.hygiene.evidenceDir", "ASYNC_PIPELINE_GITHUB_HYGIENE_INVALID") ?? ".async/hygiene",
    annotations: input.annotations ?? true
  };
  if (typeof output.releaseGate !== "boolean") {
    throw pipelineError("ASYNC_PIPELINE_GITHUB_HYGIENE_INVALID", "sync.github.hygiene.releaseGate must be a boolean.");
  }
  if (typeof output.annotations !== "boolean") {
    throw pipelineError("ASYNC_PIPELINE_GITHUB_HYGIENE_INVALID", "sync.github.hygiene.annotations must be a boolean.");
  }
  validateSafeHygienePathLike(output.packagePath, "sync.github.hygiene.packagePath", { allowDot: true });
  validateSafeHygienePathLike(output.evidenceDir, "sync.github.hygiene.evidenceDir", { allowDot: false });
  validateGeneratedJobId(output.job, "sync.github.hygiene.job");
  return output;
}

function normalizeGitHubHygieneProfiles(profiles: GitHubHygieneProfile[] | undefined): GitHubHygieneProfile[] {
  if (profiles === undefined) return ["package", "github", "docs"];
  if (!Array.isArray(profiles)) {
    throw pipelineError("ASYNC_PIPELINE_GITHUB_HYGIENE_INVALID", "sync.github.hygiene.profiles must be an array.");
  }
  if (profiles.length === 0) {
    throw pipelineError("ASYNC_PIPELINE_GITHUB_HYGIENE_INVALID", "sync.github.hygiene.profiles cannot be empty.");
  }
  const allowed = new Set(["package", "github", "docs", "repo", "release", "mixed"]);
  const normalized = profiles.map((profile, index) => {
    if (typeof profile !== "string" || !allowed.has(profile)) {
      throw pipelineError("ASYNC_PIPELINE_GITHUB_HYGIENE_INVALID", `sync.github.hygiene.profiles[${index}] must be package, github, docs, repo, release, or mixed.`);
    }
    return profile;
  });
  return [...new Set(normalized)];
}

function validateSafeHygienePathLike(value: string, field: string, options: { allowDot: boolean }): void {
  if (value === "." && options.allowDot) return;
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value)) {
    throw pipelineError("ASYNC_PIPELINE_GITHUB_HYGIENE_INVALID", `${field} must be repo-relative.`);
  }
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "..")) {
    throw pipelineError("ASYNC_PIPELINE_GITHUB_HYGIENE_INVALID", `${field} cannot contain empty segments or parent-directory segments.`);
  }
  if (/[*?[\]{}]/u.test(value)) {
    throw pipelineError("ASYNC_PIPELINE_GITHUB_HYGIENE_INVALID", `${field} cannot contain glob characters.`);
  }
  if (value.startsWith(".github/workflows/")) {
    throw pipelineError("ASYNC_PIPELINE_GITHUB_HYGIENE_INVALID", `${field} cannot include .github/workflows/**.`);
  }
}

function normalizeGitHubBridge(input: GitHubBridgeSyncInput | undefined): NormalizedGitHubBridgeSyncConfig {
  const disabled: NormalizedGitHubBridgeSyncConfig = {
    enabled: false,
    mode: "off",
    schedule: false,
    pullRequest: true,
    branchPrefix: "async/bridge/",
    allowedPaths: [],
    endpointVar: "ASYNC_PROJECT_URL",
    tokenEnv: "ASYNC_PROJECT_TOKEN",
    packageVersion: "latest"
  };
  if (!input) return disabled;

  const mode = input.mode ?? "actions";
  if (mode !== "actions" && mode !== "off") {
    throw pipelineError("ASYNC_PIPELINE_GITHUB_BRIDGE_INVALID", `sync.github.bridge.mode must be "actions" or "off". Found: ${String(mode)}.`);
  }
  if (mode === "off") return disabled;

  const output: NormalizedGitHubBridgeSyncConfig = {
    enabled: true,
    mode,
    schedule: normalizeGitHubBridgeSchedule(input.schedule),
    pullRequest: input.pullRequest ?? true,
    branchPrefix: normalizeGitHubBridgeBranchPrefix(input.branchPrefix),
    allowedPaths: normalizeGitHubBridgeAllowedPaths(input.allowedPaths),
    endpointVar: normalizeGitHubBridgeEnvName(input.endpointVar, "sync.github.bridge.endpointVar"),
    tokenEnv: normalizeGitHubBridgeEnvName(input.tokenEnv, "sync.github.bridge.tokenEnv"),
    packageVersion: normalizeOptionalNonEmptyString(input.packageVersion, "sync.github.bridge.packageVersion", "ASYNC_PIPELINE_GITHUB_BRIDGE_INVALID") ?? "latest"
  };

  if (typeof output.pullRequest !== "boolean") {
    throw pipelineError("ASYNC_PIPELINE_GITHUB_BRIDGE_INVALID", "sync.github.bridge.pullRequest must be a boolean.");
  }
  if (githubBridgeActionsEnabled(output) && output.allowedPaths.length === 0) {
    throw pipelineError(
      "ASYNC_PIPELINE_GITHUB_BRIDGE_INVALID",
      "sync.github.bridge.allowedPaths must include at least one safe repo-relative path or glob when an Actions bridge job is generated."
    );
  }
  return output;
}

function githubBridgeActionsEnabled(bridge: NormalizedGitHubBridgeSyncConfig): boolean {
  if (!bridge.enabled) return false;
  return bridge.mode === "actions";
}

function normalizeGitHubBridgeSchedule(schedule: string | false | undefined): string | false {
  if (schedule === false) return false;
  if (schedule !== undefined) {
    return normalizeOptionalNonEmptyString(schedule, "sync.github.bridge.schedule", "ASYNC_PIPELINE_GITHUB_BRIDGE_INVALID") ?? false;
  }
  return "*/15 * * * *";
}

function normalizeGitHubBridgeBranchPrefix(prefix: string | undefined): string {
  const normalized = normalizeOptionalNonEmptyString(prefix, "sync.github.bridge.branchPrefix", "ASYNC_PIPELINE_GITHUB_BRIDGE_INVALID") ?? "async/bridge/";
  validateSafeRepoPathLike(normalized, "sync.github.bridge.branchPrefix", { allowTrailingSlash: true, allowGlob: false });
  if (!normalized.endsWith("/")) {
    throw pipelineError("ASYNC_PIPELINE_GITHUB_BRIDGE_INVALID", "sync.github.bridge.branchPrefix must end with /.");
  }
  return normalized;
}

function normalizeGitHubBridgeAllowedPaths(paths: string[] | undefined): string[] {
  if (paths === undefined) return [];
  if (!Array.isArray(paths)) {
    throw pipelineError("ASYNC_PIPELINE_GITHUB_BRIDGE_INVALID", "sync.github.bridge.allowedPaths must be an array of repo-relative paths or globs.");
  }
  const normalized = paths.map((path, index) => {
    const value = normalizeOptionalNonEmptyString(path, `sync.github.bridge.allowedPaths[${index}]`, "ASYNC_PIPELINE_GITHUB_BRIDGE_INVALID");
    if (!value) {
      throw pipelineError("ASYNC_PIPELINE_GITHUB_BRIDGE_INVALID", `sync.github.bridge.allowedPaths[${index}] cannot be empty.`);
    }
    validateSafeRepoPathLike(value, `sync.github.bridge.allowedPaths[${index}]`, { allowTrailingSlash: false, allowGlob: true });
    if (value.startsWith(".github/workflows/")) {
      throw pipelineError("ASYNC_PIPELINE_GITHUB_BRIDGE_INVALID", "sync.github.bridge.allowedPaths cannot include .github/workflows/**; update pipeline.ts and regenerate workflows instead.");
    }
    return value;
  });
  return [...new Set(normalized)];
}

function normalizeGitHubBridgeEnvName(value: string | undefined, field: string): string {
  const normalized = normalizeOptionalNonEmptyString(value, field, "ASYNC_PIPELINE_GITHUB_BRIDGE_INVALID") ?? (field.endsWith("endpointVar") ? "ASYNC_PROJECT_URL" : "ASYNC_PROJECT_TOKEN");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(normalized)) {
    throw pipelineError("ASYNC_PIPELINE_GITHUB_BRIDGE_INVALID", `${field} must be an environment variable name. Found: ${normalized}.`);
  }
  return normalized;
}

function validateSafeRepoPathLike(value: string, field: string, options: { allowTrailingSlash: boolean; allowGlob: boolean }): void {
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value)) {
    throw pipelineError("ASYNC_PIPELINE_GITHUB_BRIDGE_INVALID", `${field} must be repo-relative.`);
  }
  const parts = value.split("/");
  const lastPart = parts.at(-1);
  if (!options.allowTrailingSlash && lastPart === "") {
    throw pipelineError("ASYNC_PIPELINE_GITHUB_BRIDGE_INVALID", `${field} cannot end with /.`);
  }
  const checkedParts = options.allowTrailingSlash && lastPart === "" ? parts.slice(0, -1) : parts;
  if (checkedParts.some((part) => part === "" || part === "..")) {
    throw pipelineError("ASYNC_PIPELINE_GITHUB_BRIDGE_INVALID", `${field} cannot contain empty segments or parent-directory segments.`);
  }
  if (!options.allowGlob && checkedParts.some((part) => part.includes("*"))) {
    throw pipelineError("ASYNC_PIPELINE_GITHUB_BRIDGE_INVALID", `${field} cannot contain glob characters.`);
  }
}

function normalizeGitHubPagesSync(input: GitHubPagesSyncInput | undefined): NormalizedGitHubPagesSyncConfig {
  const disabled: NormalizedGitHubPagesSyncConfig = {
    enabled: false,
    job: "pages",
    build: { kind: "static", path: ".async/pages" },
    triggers: normalizeGitHubPagesSyncTriggers(undefined)
  };
  if (!input) return disabled;
  const output: NormalizedGitHubPagesSyncConfig = input === true
    ? {
        enabled: true,
        job: "pages",
        build: { kind: "static", path: ".async/pages" },
        triggers: normalizeGitHubPagesSyncTriggers(undefined)
      }
    : {
        enabled: true,
        target: normalizeOptionalNonEmptyString(input.target, "sync.github.pages.target", "ASYNC_PIPELINE_GITHUB_PAGES_INVALID"),
        job: normalizeOptionalNonEmptyString(input.job, "sync.github.pages.job", "ASYNC_PIPELINE_GITHUB_PAGES_INVALID") ?? "pages",
        build: input.build ?? { kind: "static", path: ".async/pages" },
        triggers: normalizeGitHubPagesSyncTriggers(input.triggers)
      };
  if (input !== true && input.artifactName !== undefined) {
    output.artifactName = input.artifactName;
  }
  if (input !== true && input.environment !== undefined) {
    output.environment = input.environment;
  }
  validateGitHubPagesConfig(output.job, {
    build: output.build,
    artifactName: output.artifactName,
    environment: output.environment
  });
  return output;
}

function normalizeGitHubPagesSyncTriggers(input: GitHubPagesSyncTriggersConfig | undefined): NormalizedGitHubPagesSyncTriggersConfig {
  if (input?.pullRequest !== undefined && typeof input.pullRequest !== "boolean") {
    throw pipelineError("ASYNC_PIPELINE_GITHUB_PAGES_INVALID", "sync.github.pages.triggers.pullRequest must be a boolean.");
  }
  if (input?.manual !== undefined && typeof input.manual !== "boolean") {
    throw pipelineError("ASYNC_PIPELINE_GITHUB_PAGES_INVALID", "sync.github.pages.triggers.manual must be a boolean.");
  }
  const main = input?.main ?? true;
  let normalizedMain: NormalizedGitHubPagesSyncTriggersConfig["main"];
  if (main === false) {
    normalizedMain = false;
  } else if (main === true) {
    normalizedMain = { branch: "main" };
  } else if (isObjectRecord(main)) {
    normalizedMain = {
      branch: normalizeOptionalNonEmptyString(main.branch, "sync.github.pages.triggers.main.branch", "ASYNC_PIPELINE_GITHUB_PAGES_INVALID") ?? "main"
    };
  } else {
    throw pipelineError("ASYNC_PIPELINE_GITHUB_PAGES_INVALID", "sync.github.pages.triggers.main must be a boolean or an object with a branch.");
  }
  return {
    pullRequest: input?.pullRequest ?? true,
    main: normalizedMain,
    manual: input?.manual ?? true
  };
}

function normalizeOptionalNonEmptyString(input: unknown, field: string, code = "ASYNC_PIPELINE_PACKAGE_PREVIEWS_INVALID"): string | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== "string") {
    throw pipelineError(code, `${field} must be a string.`);
  }
  const normalized = input.trim();
  if (!normalized) {
    throw pipelineError(code, `${field} cannot be empty.`);
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

  for (const rawItem of items) {
    const item = normalizeDeclaredRunItem(rawItem);
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

function normalizeDeclaredRunItem(item: TaskRunItem): TaskRunItem {
  const metadata = assertSupportedDeclaration(item);
  if (!metadata || !isObjectRecord(item)) return item;
  if (metadata.kind === "shell") {
    rejectUnknownFields(SHELL_STEP_FIELDS, item, "shell declaration");
    const command = item.command;
    if (typeof command !== "string") {
      throw pipelineError("ASYNC_PIPELINE_DECLARATION_INVALID", "Shell declaration requires a string command.");
    }
    return brandDeclaration({ kind: "shell", command }, "shell");
  }
  if (metadata.kind === "deferred-shell") {
    rejectUnknownFields(SHELL_STEP_FIELDS, item, "deferred shell declaration");
    const command = item.command;
    if (typeof command !== "function") {
      throw pipelineError("ASYNC_PIPELINE_DECLARATION_INVALID", "Deferred shell declaration requires a command function.");
    }
    return brandDeclaration({ kind: "deferred-shell", command: command as DeferredShellCommandFactory }, "deferred-shell");
  }
  if (metadata.kind === "agent") {
    rejectUnknownFields(DECLARED_AGENT_STEP_FIELDS, item, "agent declaration");
    const use = item.use;
    const prompt = item.prompt;
    if ((typeof use !== "string" && !isEnvVarRef(use)) || (typeof use === "string" && use.length === 0)) {
      throw pipelineError("ASYNC_PIPELINE_AGENT_INVALID", 'agent declaration requires "use": a non-empty profile id or env.var(...).');
    }
    if (typeof prompt !== "string" || prompt.length === 0) {
      throw pipelineError("ASYNC_PIPELINE_AGENT_INVALID", 'agent declaration requires a non-empty "prompt" string.');
    }
    const step: AgentStep = brandDeclaration({ kind: "agent", use: use as AgentProfileId | EnvVarRef, prompt }, "agent");
    if (item.model !== undefined) step.model = item.model as string | EnvVarRef;
    if (item.stdoutTo !== undefined) step.stdoutTo = item.stdoutTo as string;
    return step;
  }
  return item;
}

function isDependsOnDirective(value: unknown): value is DependsOnDirective {
  return Boolean(value)
    && typeof value === "object"
    && ((value as { kind?: unknown }).kind === "async-pipeline.directive.dependsOn" || hasDeclarationKind(value, "directive.dependsOn"));
}

function uniqueTaskIds(taskIds: readonly TaskId[]): TaskId[] {
  return [...new Set(taskIds)];
}

function isTaskRunArray(value: TaskRunDefinition): value is readonly TaskRunItem[] {
  return Array.isArray(value);
}
