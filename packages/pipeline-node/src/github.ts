import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type { EnvValue, ExecutionProfileId, GitHubJobConfig, GitHubPagesConfig, GitHubRuntimeName, JobEnvironment, JobRequirements, JobId, NormalizedGitHubBridgeSyncConfig, NormalizedGitHubPagesSyncConfig, NormalizedJob, NormalizedPackagePreviewsConfig, NormalizedPipeline, NormalizedTask, TriggerDefinition, TriggerId } from "@async/pipeline-core";
import { githubConfigForJob, pipelineError } from "@async/pipeline-core";

export const GITHUB_WORKFLOW_PATH = ".github/workflows/async-pipeline.yml";
export const GITHUB_LOCK_PATH = ".github/async-pipeline.lock.json";
const GENERATOR_VERSION = 14;
const DEFAULT_NODE_VERSION = "24";
const DEFAULT_DENO_VERSION = "2";
const DEFAULT_PNPM_VERSION = "11.1.0";
const DEFAULT_DENO_PIPELINE_COMMAND = "deno run -A npm:@async/pipeline/cli";

interface GitHubActionRef {
  id: string;
  uses: string;
  sha: string;
  label: string;
  ref: string;
}

function defineActionRef(id: string, uses: string, sha: string, label: string): GitHubActionRef {
  return {
    id,
    uses,
    sha,
    label,
    ref: `${uses}@${sha} # ${label}`
  };
}

const ASYNC_ACTIONS_SHA = "313494352cd10207bf0331c83e83364eb45c8e02";
const ASYNC_ACTIONS_LABEL = "v0.1.5";

const GENERATED_ACTIONS = [
  defineActionRef("async.actions.setup", "async/actions/setup", ASYNC_ACTIONS_SHA, ASYNC_ACTIONS_LABEL),
  defineActionRef("async.actions.run", "async/actions/run", ASYNC_ACTIONS_SHA, ASYNC_ACTIONS_LABEL),
  defineActionRef("async.actions.pages", "async/actions/pages", ASYNC_ACTIONS_SHA, ASYNC_ACTIONS_LABEL),
  defineActionRef("async.actions.preview", "async/actions/preview", ASYNC_ACTIONS_SHA, ASYNC_ACTIONS_LABEL),
  defineActionRef("async.actions.publish", "async/actions/publish", ASYNC_ACTIONS_SHA, ASYNC_ACTIONS_LABEL),
  defineActionRef("async.actions.dependabot-merge", "async/actions/dependabot-merge", ASYNC_ACTIONS_SHA, ASYNC_ACTIONS_LABEL),
  defineActionRef("actions.checkout", "actions/checkout", "de0fac2e4500dabe0009e67214ff5f5447ce83dd", "v6.0.2"),
  defineActionRef("actions.cache", "actions/cache", "0057852bfaa89a56745cba8c7296529d2fc39830", "v4"),
  defineActionRef("pnpm.setup", "pnpm/setup", "cf03a9b516e09bc5a90f041fc26fc930c9dc631b", "v1.0.0"),
  defineActionRef("deno.setup", "denoland/setup-deno", "667a34cdef165d8d2b2e98dde39547c9daac7282", "v2.0.4"),
  defineActionRef("actions.setup-node", "actions/setup-node", "48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e", "v6"),
  defineActionRef("dependabot.fetch-metadata", "dependabot/fetch-metadata", "25dd0e34f4fe68f24cc83900b1fe3fe149efef98", "v3.1.0")
] as const;

const ACTION_LOCKS = GENERATED_ACTIONS.map(({ id, uses, sha, label, ref }) => ({ id, uses, sha, label, ref }))
  .sort((left, right) => left.id.localeCompare(right.id));
const ACTION_BY_ID: Record<string, GitHubActionRef> = Object.fromEntries(GENERATED_ACTIONS.map((action) => [action.id, action]));
const ASYNC_SETUP_ACTION = actionRef("async.actions.setup");
const ASYNC_RUN_ACTION = actionRef("async.actions.run");
const ASYNC_PAGES_ACTION = actionRef("async.actions.pages");
const ASYNC_PREVIEW_ACTION = actionRef("async.actions.preview");
const ASYNC_PUBLISH_ACTION = actionRef("async.actions.publish");
const ASYNC_DEPENDABOT_MERGE_ACTION = actionRef("async.actions.dependabot-merge");
const CHECKOUT_ACTION = actionRef("actions.checkout");
const CACHE_ACTION = actionRef("actions.cache");
const PNPM_SETUP_ACTION = actionRef("pnpm.setup");
const DENO_SETUP_ACTION = actionRef("deno.setup");
const SETUP_NODE_ACTION = actionRef("actions.setup-node");
const DEPENDABOT_FETCH_METADATA_ACTION = actionRef("dependabot.fetch-metadata");

function actionRef(id: string): string {
  const action = ACTION_BY_ID[id];
  if (!action) {
    throw new Error(`Missing generated GitHub action manifest entry ${id}.`);
  }
  return action.ref;
}

export interface GitHubRenderOptions {
  cwd: string;
  configPath: string;
  workflowPath?: string;
  lockPath?: string;
}

export interface GitHubLock {
  version: number;
  generator: string;
  config: string;
  workflow: string;
  hash: string;
  generatedAt: string;
  actions: Array<{ id: string; uses: string; sha: string; label: string; ref: string }>;
  triggers: Record<string, unknown>;
  jobs: Array<{ id: string; target: string[]; trigger: string[]; env: Record<string, EnvValue>; environment?: JobEnvironment; requires?: JobRequirements; execution?: ExecutionProfileId; github?: GitHubJobConfig; if?: string }>;
  packageManager: string;
  packageManagerVersion?: string;
  buildCommand?: string;
  command: string;
  setup: string;
  nodeVersion: string;
  runtime: string[];
  taskCache: boolean;
  dependencyCache: boolean;
  dependencyCachePath?: string;
  dependabotAutoMerge: {
    enabled: boolean;
    ecosystems: string[];
  };
  packagePreviews: {
    enabled: boolean;
    package?: string;
    target?: string;
    registry: string;
    namespace?: string;
    tokenEnv: string;
    comment: boolean;
  };
  bridge: NormalizedGitHubBridgeSyncConfig & {
    job: "async-bridge";
    actionsJob: {
      enabled: boolean;
      scheduled: boolean;
      manual: boolean;
    };
  };
  pages: NormalizedGitHubPagesSyncConfig;
  manualDispatchJobs?: string[];
}

interface PackageInfo {
  packageManager: string;
  packageManagerVersion?: string;
  buildCommand?: string;
  projectKind: "package" | "deno";
  dependencyCachePath?: string;
  publicPackagePaths: string[];
}

interface RuntimeSpec {
  name: GitHubRuntimeName;
  version?: string;
  spec: string;
}

type LifecyclePlanItem =
  | { kind: "run-task"; taskId: string }
  | { kind: "preview"; mode: "main" | "pr"; packagePath: string; registry: string; namespace?: string; comment: boolean; tokenEnv: string }
  | { kind: "publish"; mode: "npm" | "github-packages" | "github-release" | "doctor"; packagePath: string; registry: string; distTag: string };

export interface GitHubRenderResult {
  workflowPath: string;
  lockPath: string;
  workflow: string;
  lock: GitHubLock;
}

export interface GitHubEventContext {
  eventName: string;
  action?: string;
  ref?: string;
  baseRef?: string;
  headRef?: string;
  schedule?: string;
  selectedJob?: string;
  payload?: unknown;
}

export async function renderGitHubWorkflow(pipeline: NormalizedPipeline, options: GitHubRenderOptions): Promise<GitHubRenderResult> {
  const workflowPath = options.workflowPath ?? pipeline.sync.github.workflow ?? GITHUB_WORKFLOW_PATH;
  const lockPath = options.lockPath ?? pipeline.sync.github.lock ?? GITHUB_LOCK_PATH;
  const packageInfo = await readPackageInfo(options.cwd);
  const renderModel = buildRenderModel(pipeline, {
    ...packageInfo,
    configPath: relativePath(options.cwd, options.configPath),
    workflowPath
  });
  const workflow = renderWorkflow(renderModel);
  const hash = hashJson({
    version: GENERATOR_VERSION,
    config: renderModel.configPath,
    workflow: renderModel.workflowPath,
    triggers: renderModel.triggers,
    jobs: renderModel.jobs,
    packageManager: renderModel.packageManager,
    packageManagerVersion: renderModel.packageManagerVersion,
    buildCommand: renderModel.buildCommand,
    command: renderModel.command,
    setup: renderModel.setup,
    nodeVersion: renderModel.nodeVersion,
    runtime: renderModel.runtime.map((entry) => entry.spec),
    taskCache: renderModel.taskCache,
    dependencyCache: renderModel.dependencyCache,
    dependencyCachePath: renderModel.dependencyCachePath,
    dependabotAutoMerge: renderModel.dependabotAutoMerge,
    packagePreviews: renderModel.packagePreviews,
    bridge: renderModel.bridge,
    pages: renderModel.pages,
    manualDispatchJobs: renderModel.manualDispatchJobs,
    actions: ACTION_LOCKS
  });
  const lock: GitHubLock = {
    version: GENERATOR_VERSION,
    generator: "@async/pipeline",
    config: renderModel.configPath,
    workflow: renderModel.workflowPath,
    hash,
    generatedAt: new Date().toISOString(),
    actions: ACTION_LOCKS,
    triggers: renderModel.triggers,
    jobs: renderModel.jobs,
    packageManager: renderModel.packageManager,
    packageManagerVersion: renderModel.packageManagerVersion,
    buildCommand: renderModel.buildCommand,
    command: renderModel.command,
    setup: renderModel.setup,
    nodeVersion: renderModel.nodeVersion,
    runtime: renderModel.runtime.map((entry) => entry.spec),
    taskCache: renderModel.taskCache,
    dependencyCache: renderModel.dependencyCache,
    dependencyCachePath: renderModel.dependencyCachePath,
    dependabotAutoMerge: renderModel.dependabotAutoMerge,
    packagePreviews: renderModel.packagePreviews,
    bridge: renderModel.bridge,
    pages: renderModel.pages,
    manualDispatchJobs: renderModel.manualDispatchJobs
  };
  return {
    workflowPath,
    lockPath,
    workflow,
    lock
  };
}

export async function writeGitHubWorkflow(result: GitHubRenderResult, cwd: string): Promise<void> {
  const workflowFile = resolve(cwd, result.workflowPath);
  const lockFile = resolve(cwd, result.lockPath);
  await mkdir(dirname(workflowFile), { recursive: true });
  await mkdir(dirname(lockFile), { recursive: true });
  await writeFile(workflowFile, result.workflow, "utf8");
  await writeFile(lockFile, `${JSON.stringify(result.lock, null, 2)}\n`, "utf8");
}

export async function checkGitHubWorkflow(result: GitHubRenderResult, cwd: string): Promise<string[]> {
  const issues: string[] = [];
  const workflowFile = resolve(cwd, result.workflowPath);
  const lockFile = resolve(cwd, result.lockPath);
  const renderedMutableRefs = findMutableRemoteActionRefs(result.workflow);
  if (renderedMutableRefs.length > 0) {
    issues.push(`Generated workflow renderer produced mutable action refs: ${renderedMutableRefs.join(", ")}.`);
  }

  if (!existsSync(workflowFile)) {
    issues.push(`Missing generated workflow ${result.workflowPath}. Run async-pipeline github generate.`);
  } else {
    const existingWorkflow = await readFile(workflowFile, "utf8");
    const existingMutableRefs = findMutableRemoteActionRefs(existingWorkflow);
    if (existingMutableRefs.length > 0) {
      issues.push(`Generated workflow ${result.workflowPath} contains mutable action refs (${existingMutableRefs.join(", ")}). Run async-pipeline github generate.`);
    }
    if (existingWorkflow !== result.workflow) {
      issues.push(`Generated workflow ${result.workflowPath} is stale. Run async-pipeline github generate.`);
    }
  }

  if (!existsSync(lockFile)) {
    issues.push(`Missing GitHub generation lock ${result.lockPath}. Run async-pipeline github generate.`);
  } else {
    const existingLock = JSON.parse(await readFile(lockFile, "utf8")) as GitHubLock;
    if (existingLock.hash !== result.lock.hash || existingLock.workflow !== result.lock.workflow || existingLock.config !== result.lock.config) {
      issues.push(`GitHub generation lock ${result.lockPath} is stale. Run async-pipeline github generate.`);
    }
  }

  return issues;
}

function findMutableRemoteActionRefs(workflow: string): string[] {
  const refs = new Set<string>();
  for (const line of workflow.split("\n")) {
    const match = /^\s*uses:\s*([^#\s]+)/u.exec(line);
    if (!match) continue;
    const value = (match[1] ?? "").replace(/^["']|["']$/gu, "");
    if (value.startsWith("./") || value.startsWith("../") || value.startsWith("docker://")) continue;
    const atIndex = value.lastIndexOf("@");
    if (atIndex < 0 || !/^[0-9a-f]{40}$/iu.test(value.slice(atIndex + 1))) {
      refs.add(value);
    }
  }
  return [...refs].sort((left, right) => left.localeCompare(right));
}

export async function readGitHubEventContext(env: NodeJS.ProcessEnv): Promise<GitHubEventContext> {
  const eventName = env.ASYNC_PIPELINE_GITHUB_EVENT_NAME ?? env.GITHUB_EVENT_NAME ?? "workflow_dispatch";
  const eventPath = env.GITHUB_EVENT_PATH;
  let payload: unknown;
  if (eventPath && existsSync(eventPath)) {
    payload = JSON.parse(await readFile(eventPath, "utf8"));
  }
  return {
    eventName,
    action: env.ASYNC_PIPELINE_GITHUB_ACTION ?? eventAction(payload),
    ref: env.ASYNC_PIPELINE_GITHUB_REF ?? env.GITHUB_REF,
    baseRef: env.ASYNC_PIPELINE_GITHUB_BASE_REF ?? env.GITHUB_BASE_REF,
    headRef: env.ASYNC_PIPELINE_GITHUB_HEAD_REF ?? env.GITHUB_HEAD_REF,
    schedule: env.ASYNC_PIPELINE_GITHUB_SCHEDULE,
    selectedJob: env.ASYNC_PIPELINE_GITHUB_JOB ?? workflowDispatchInput(payload, "job"),
    payload
  };
}

export function jobsForGitHubEvent(pipeline: NormalizedPipeline, context: GitHubEventContext): NormalizedJob[] {
  if (context.eventName === "workflow_dispatch") {
    // Dispatch is never "run everything". Generated workflows expose a required
    // job selector, and the CLI mirrors that event shape for github run.
    if (!context.selectedJob) return [];
    const selected = pipeline.jobs[context.selectedJob];
    if (!selected || !selected.trigger.some((triggerId) => pipeline.triggers[triggerId]?.type === "manual")) return [];
    return [selected];
  }

  const matches: NormalizedJob[] = [];
  for (const job of Object.values(pipeline.jobs)) {
    for (const triggerId of job.trigger) {
      const trigger = pipeline.triggers[triggerId];
      if (trigger && triggerMatches(triggerId, trigger, context)) {
        matches.push(job);
        break;
      }
    }
  }
  return matches.sort((left, right) => left.id.localeCompare(right.id));
}

function buildRenderModel(
  pipeline: NormalizedPipeline,
  options: PackageInfo & { configPath: string; workflowPath: string }
) {
  const usedTriggerIds = new Set<TriggerId>(Object.values(pipeline.jobs).flatMap((job) => job.trigger));
  const usedTriggers = Object.fromEntries([...usedTriggerIds].sort().map((triggerId) => [triggerId, pipeline.triggers[triggerId]]));
  const triggers = normalizeGitHubTriggers(usedTriggers);
  if (pipeline.sync.github.dependabotAutoMerge.enabled) {
    addPullRequestTrigger(triggers, "pull_request_target");
  }
  const packagePreviews = resolvePackagePreviews(pipeline, options);
  if (packagePreviews.enabled) {
    addPullRequestTrigger(triggers, "pull_request");
  }
  const pages = resolveGitHubPages(pipeline);
  const bridge = resolveGitHubBridge(pipeline);
  if (pages.enabled) {
    if (pages.triggers.pullRequest) {
      addGitHubEventTrigger(triggers, "pull_request");
    }
    if (pages.triggers.main) {
      addPushBranchTrigger(triggers, pages.triggers.main.branch);
    }
  }
  if (bridge.actionsJob.scheduled && bridge.schedule) {
    addScheduleTrigger(triggers, bridge.schedule, "async-bridge");
  }
  const manualDispatchJobs = Object.values(pipeline.jobs)
    .filter((job) => job.trigger.some((triggerId) => pipeline.triggers[triggerId]?.type === "manual"))
    .map((job) => job.id)
    .sort((left, right) => left.localeCompare(right));
  if (pages.enabled && pages.triggers.manual) {
    manualDispatchJobs.push(pages.job);
    manualDispatchJobs.sort((left, right) => left.localeCompare(right));
  }
  if (bridge.actionsJob.manual) {
    manualDispatchJobs.push(bridge.job);
    manualDispatchJobs.sort((left, right) => left.localeCompare(right));
  }
  const nodeVersion = pipeline.sync.github.nodeVersion ?? DEFAULT_NODE_VERSION;
  const runtime = resolveRuntimeSpecs(pipeline.sync.github.runtime, options.projectKind, nodeVersion);
  const setup = resolveGitHubSetup(pipeline.sync.github.setup, options.packageManager, options.packageManagerVersion);
  return {
    name: "Async Pipeline",
    configPath: options.configPath,
    workflowPath: options.workflowPath,
    projectKind: options.projectKind,
    triggers,
    jobs: Object.values(pipeline.jobs)
      .map((job) => ({
        id: job.id,
        target: [...job.target],
        trigger: [...job.trigger],
        env: { ...pipeline.env, ...(job.env ?? {}) },
        environment: job.environment,
        requires: job.requires,
        execution: job.execution,
        github: githubConfigForJob(pipeline, job),
        if: renderGitHubJobCondition(job, pipeline.triggers)
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    tasks: pipeline.tasks,
    packageManager: options.packageManager,
    packageManagerVersion: options.packageManagerVersion,
    buildCommand: options.buildCommand,
    command: resolvePipelineCommand(pipeline.sync.command, options.projectKind, options.packageManager),
    setup,
    nodeVersion,
    runtime,
    taskCache: pipeline.sync.github.cache ?? true,
    dependencyCache: pipeline.sync.github.dependencyCache ?? true,
    dependencyCachePath: pipeline.sync.github.dependencyCache === false ? undefined : options.dependencyCachePath,
    dependabotAutoMerge: pipeline.sync.github.dependabotAutoMerge,
    packagePreviews,
    bridge,
    pages,
    manualDispatchJobs
  };
}

function resolveGitHubBridge(pipeline: NormalizedPipeline): NormalizedGitHubBridgeSyncConfig & {
  job: "async-bridge";
  actionsJob: { enabled: boolean; scheduled: boolean; manual: boolean };
} {
  const config = pipeline.sync.github.bridge;
  const actionsJobEnabled = gitHubBridgeActionsEnabled(config);
  const scheduled = actionsJobEnabled && config.schedule !== false;
  const manual = actionsJobEnabled;
  return {
    ...config,
    job: "async-bridge",
    actionsJob: {
      enabled: actionsJobEnabled,
      scheduled,
      manual
    }
  };
}

function gitHubBridgeActionsEnabled(bridge: NormalizedGitHubBridgeSyncConfig): boolean {
  if (!bridge.enabled) return false;
  return bridge.mode === "actions";
}

function resolveGitHubPages(pipeline: NormalizedPipeline): NormalizedGitHubPagesSyncConfig {
  const config = pipeline.sync.github.pages;
  if (!config.enabled) return config;
  const target = config.target ?? inferGitHubPagesTarget(pipeline);
  if (!pipeline.tasks[target]) {
    throw pipelineError(
      "ASYNC_PIPELINE_GITHUB_PAGES_UNKNOWN_TARGET",
      `sync.github.pages.target references missing task "${target}".`
    );
  }
  if (pipeline.jobs[config.job]) {
    throw pipelineError(
      "ASYNC_PIPELINE_GITHUB_PAGES_JOB_CONFLICT",
      `sync.github.pages.job "${config.job}" conflicts with an existing pipeline job. Remove the explicit job or set sync.github.pages.job to a different id.`
    );
  }
  return {
    ...config,
    target
  };
}

function inferGitHubPagesTarget(pipeline: NormalizedPipeline): string {
  for (const taskId of ["pages", "docs.site", "docs", "build-pages"]) {
    if (pipeline.tasks[taskId]) return taskId;
  }
  throw pipelineError(
    "ASYNC_PIPELINE_GITHUB_PAGES_NO_TARGET",
    "sync.github.pages: true needs a pages, docs.site, docs, or build-pages task. Set sync.github.pages.target explicitly."
  );
}

function addPullRequestTrigger(triggers: Record<string, unknown>, event: "pull_request" | "pull_request_target"): void {
  const existing = triggers[event] && typeof triggers[event] === "object" && !Array.isArray(triggers[event])
    ? triggers[event] as Record<string, unknown>
    : {};
  const existingTypes = Array.isArray(existing.types) ? existing.types.filter((value): value is string => typeof value === "string") : [];
  triggers[event] = sortObject({
    ...existing,
    types: [...new Set([...existingTypes, "opened", "reopened", "synchronize", "ready_for_review"])].sort()
  });
}

function addGitHubEventTrigger(triggers: Record<string, unknown>, event: string): void {
  if (triggers[event] === undefined) {
    triggers[event] = {};
  }
}

function addPushBranchTrigger(triggers: Record<string, unknown>, branch: string): void {
  const existing = triggers.push && typeof triggers.push === "object" && !Array.isArray(triggers.push)
    ? triggers.push as Record<string, unknown>
    : {};
  const existingBranches = Array.isArray(existing.branches) ? existing.branches.filter((value): value is string => typeof value === "string") : [];
  triggers.push = sortObject({
    ...existing,
    branches: [...new Set([...existingBranches, branch])].sort()
  });
}

function addScheduleTrigger(triggers: Record<string, unknown>, cron: string, id: string): void {
  const existing = Array.isArray(triggers.schedule)
    ? triggers.schedule.filter((value): value is { cron: string; timezone?: string; id?: string } => {
        return Boolean(value) && typeof value === "object" && typeof value.cron === "string";
      })
    : [];
  if (!existing.some((schedule) => schedule.cron === cron)) {
    existing.push({ cron, id });
  }
  triggers.schedule = existing.sort((left, right) => left.cron.localeCompare(right.cron));
}

function resolvePackagePreviews(pipeline: NormalizedPipeline, packageInfo: PackageInfo): NormalizedPackagePreviewsConfig {
  const config = pipeline.sync.github.packagePreviews;
  if (!config.enabled) return config;
  const packagePath = config.package ?? inferPackagePreviewPath(packageInfo.publicPackagePaths);
  const target = config.target ?? inferPackagePreviewTarget(pipeline);
  if (!pipeline.tasks[target]) {
    throw pipelineError(
      "ASYNC_PIPELINE_PACKAGE_PREVIEWS_UNKNOWN_TARGET",
      `sync.github.packagePreviews.target references missing task "${target}".`
    );
  }
  return {
    ...config,
    package: packagePath,
    target
  };
}

function inferPackagePreviewPath(publicPackagePaths: string[]): string {
  if (publicPackagePaths.length === 1) {
    const packagePath = publicPackagePaths[0];
    if (packagePath) return packagePath;
  }
  if (publicPackagePaths.length === 0) {
    throw pipelineError(
      "ASYNC_PIPELINE_PACKAGE_PREVIEWS_NO_PACKAGE",
      "sync.github.packagePreviews: true could not find a public root package or public packages/* workspace package. Set sync.github.packagePreviews.package explicitly."
    );
  }
  throw pipelineError(
    "ASYNC_PIPELINE_PACKAGE_PREVIEWS_AMBIGUOUS_PACKAGE",
    `sync.github.packagePreviews: true found multiple public packages (${publicPackagePaths.join(", ")}). Set sync.github.packagePreviews.package explicitly.`
  );
}

function inferPackagePreviewTarget(pipeline: NormalizedPipeline): string {
  if (pipeline.tasks.pack) return "pack";
  if (pipeline.tasks.build) return "build";
  throw pipelineError(
    "ASYNC_PIPELINE_PACKAGE_PREVIEWS_NO_TARGET",
    "sync.github.packagePreviews: true needs a pack or build task. Set sync.github.packagePreviews.target explicitly."
  );
}

function normalizeGitHubTriggers(triggers: Record<string, TriggerDefinition | undefined>): Record<string, unknown> {
  const events: Record<string, unknown> = {};
  const schedules: Array<{ cron: string; timezone?: string; id: string }> = [];

  for (const [id, trigger] of Object.entries(triggers)) {
    if (!trigger) continue;
    if (trigger.type === "github") {
      for (const event of trigger.events ?? []) {
        const existing = events[event] && typeof events[event] === "object" ? events[event] as Record<string, unknown> : {};
        events[event] = mergeEventFilters(existing, trigger);
      }
    }
    if (trigger.type === "schedule" && trigger.cron) {
      schedules.push({ id, cron: trigger.cron, timezone: trigger.timezone });
    }
  }

  if (schedules.length > 0) {
    events.schedule = schedules.sort((left, right) => left.cron.localeCompare(right.cron));
  }
  events.workflow_dispatch = {};
  return sortObject(events);
}

function renderWorkflow(model: ReturnType<typeof buildRenderModel>): string {
  const lines = [
    "# Generated by async-pipeline. Do not edit by hand.",
    "# Run: async-pipeline github generate",
    "",
    `name: ${model.name}`,
    "",
    "on:"
  ];
  renderOn(lines, model.triggers, model.manualDispatchJobs);
  lines.push(
    "",
    "permissions:",
    "  contents: read",
    "",
    "jobs:"
  );
  for (const job of model.jobs) {
    renderJob(lines, model, job);
    if (job.github?.pages) {
      renderPagesDeployJob(lines, job);
    }
  }
  if (model.pages.enabled) {
    renderGeneratedPagesJob(lines, model);
    renderPagesDeployJob(lines, {
      id: model.pages.job,
      github: {
        pages: {
          build: model.pages.build,
          artifactName: model.pages.artifactName,
          environment: model.pages.environment
        }
      }
    } as ReturnType<typeof buildRenderModel>["jobs"][number]);
  }
  if (model.dependabotAutoMerge.enabled) {
    renderDependabotAutoMergeJob(lines, model.dependabotAutoMerge.ecosystems);
  }
  if (model.packagePreviews.enabled) {
    renderPackagePreviewJob(lines, model);
  }
  if (model.bridge.actionsJob.enabled) {
    renderBridgeJob(lines, model);
  }
  return `${lines.join("\n").replace(/\n+$/u, "")}\n`;
}

function renderJob(lines: string[], model: ReturnType<typeof buildRenderModel>, job: ReturnType<typeof buildRenderModel>["jobs"][number]): void {
  const runnerMatrix = job.github?.runsOnMatrix;
  lines.push(
    `  ${yamlKey(job.id)}:`,
    runnerMatrix && runnerMatrix.length > 0
      ? `    name: ${job.id} (\${{ join(matrix.runner, ' ') }})`
      : `    name: ${job.id}`
  );
  if (job.if) {
    lines.push(`    if: ${job.if}`);
  }
  if (runnerMatrix && runnerMatrix.length > 0) {
    lines.push(
      "    strategy:",
      "      fail-fast: false",
      "      matrix:",
      "        runner:"
    );
    for (const entry of runnerMatrix) {
      const labels = Array.isArray(entry) ? entry : [entry];
      lines.push(`          - ${JSON.stringify(labels)}`);
    }
    lines.push("    runs-on: ${{ matrix.runner }}");
  } else {
    const runsOn = job.github?.runsOn ?? "ubuntu-latest";
    lines.push(`    runs-on: ${Array.isArray(runsOn) ? JSON.stringify(runsOn) : runsOn}`);
  }
  const environment = job.environment ?? job.github?.environment;
  if (environment) {
    renderGitHubEnvironment(lines, environment);
  }
  const grants = job.github?.permissions;
  const idToken = grants?.idToken ?? (job.requires?.provenance ? "write" as const : undefined);
  const issues = grants?.issues;
  const packages = grants?.packages;
  const pullRequests = grants?.pullRequests;
  // Job-level permissions replace the workflow default set, so any grant must
  // restate contents: read or checkout loses repo access.
  const contents = grants?.contents ?? ((idToken || issues || packages || pullRequests) ? "read" : undefined);
  if (contents || idToken || issues || packages || pullRequests) {
    lines.push("    permissions:");
    if (contents) lines.push(`      contents: ${contents}`);
    if (idToken) lines.push(`      id-token: ${idToken}`);
    if (issues) lines.push(`      issues: ${issues}`);
    if (packages) lines.push(`      packages: ${packages}`);
    if (pullRequests) lines.push(`      pull-requests: ${pullRequests}`);
  }
  lines.push(
    "    steps:",
    "      - name: Checkout",
    `        uses: ${CHECKOUT_ACTION}`,
    "",
    ...(model.taskCache
      ? [
          "      - name: Restore task cache",
          `        uses: ${CACHE_ACTION}`,
          "        with:",
          "          path: .async/cache",
          "          key: async-pipeline-${{ runner.os }}-${{ github.sha }}",
          "          restore-keys: |",
          "            async-pipeline-${{ runner.os }}-",
          ""
        ]
      : []),
    ...renderSetupSteps(model),
    ...(idToken === "write"
      ? [
          "      - name: Use current npm",
          "        run: npm install -g npm@11.16.0",
          ""
        ]
      : []),
    ...renderDependencyInstallSteps(model)
  );
  if (model.buildCommand) {
    lines.push(
      "",
      "      - name: Build pipeline CLI",
      `        run: ${model.buildCommand}`
    );
  }
  const lifecyclePlan = resolveLifecycleJobPlan(model, job);
  if (lifecyclePlan) {
    renderLifecycleJobPlan(lines, model, job, lifecyclePlan);
  } else {
    renderRunActionStep(lines, "Run pipeline job", `${model.command} github check && ${model.command} run ${shellWord(job.id)}${job.execution ? ` --execution ${shellWord(job.execution)}` : ""}`, job.env);
  }
  if (job.github?.pages) {
    lines.push("");
    renderPagesBuildSteps(lines, job.github.pages);
  }
  lines.push("");
}

function renderGeneratedPagesJob(lines: string[], model: ReturnType<typeof buildRenderModel>): void {
  const pages = model.pages;
  if (!pages.target) return;
  lines.push(
    `  ${yamlKey(pages.job)}:`,
    `    name: ${pages.job}`,
    `    if: ${renderGeneratedPagesCondition(pages)}`,
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - name: Checkout",
    `        uses: ${CHECKOUT_ACTION}`,
    "",
    ...(model.taskCache
      ? [
          "      - name: Restore task cache",
          `        uses: ${CACHE_ACTION}`,
          "        with:",
          "          path: .async/cache",
          "          key: async-pipeline-${{ runner.os }}-${{ github.sha }}",
          "          restore-keys: |",
          "            async-pipeline-${{ runner.os }}-",
          ""
        ]
      : []),
    ...renderSetupSteps(model),
    ...renderDependencyInstallSteps(model)
  );
  if (model.buildCommand) {
    lines.push(
      "",
      "      - name: Build pipeline CLI",
      `        run: ${model.buildCommand}`
    );
  }
  renderRunActionStep(lines, "Run Pages target", `${model.command} github check && ${model.command} run-task ${shellWord(pages.target)}`, {});
  lines.push("");
  renderPagesBuildSteps(lines, pages);
  lines.push("");
}

function renderGeneratedPagesCondition(pages: NormalizedGitHubPagesSyncConfig): string {
  const conditions: string[] = [];
  if (pages.triggers.pullRequest) {
    conditions.push("github.event_name == 'pull_request'");
  }
  if (pages.triggers.main) {
    conditions.push(`(github.event_name == 'push' && (github.ref == 'refs/heads/${pages.triggers.main.branch}'))`);
  }
  if (pages.triggers.manual) {
    conditions.push(`(github.event_name == 'workflow_dispatch' && github.event.inputs.job == '${pages.job}')`);
  }
  return conditions.length > 0 ? conditions.join(" || ") : "false";
}

function renderDependencyInstallSteps(model: ReturnType<typeof buildRenderModel>): string[] {
  if (model.setup === "async") return [];
  if (model.projectKind === "deno") {
    return [
      "      - name: Install dependencies",
      `        run: deno install --frozen=${model.dependencyCachePath ? "true" : "false"}`
    ];
  }
  return [
    "      - name: Install dependencies",
    `        run: ${model.packageManager} install --frozen-lockfile`
  ];
}

function renderRunActionStep(lines: string[], name: string, command: string, env: Record<string, EnvValue>, options: { artifactName?: string } = {}): void {
  lines.push(
    "",
    `      - name: ${name}`,
    `        uses: ${ASYNC_RUN_ACTION}`,
    "        with:",
    `          command: ${JSON.stringify(command)}`,
    "          check-generated: false",
    `          artifact-name: ${options.artifactName ?? "async-pipeline-${{ github.job }}-runs"}`
  );
  renderActionEnv(lines, env);
}

function resolveLifecycleJobPlan(
  model: ReturnType<typeof buildRenderModel>,
  job: ReturnType<typeof buildRenderModel>["jobs"][number]
): LifecyclePlanItem[] | undefined {
  if (job.execution || job.target.length !== 1) return undefined;
  const plan: LifecyclePlanItem[] = [];
  if (!appendLifecycleTaskPlan(model.tasks, job.target[0] ?? "", plan, new Set())) return undefined;
  return plan.some((item) => item.kind !== "run-task") ? plan : undefined;
}

function appendLifecycleTaskPlan(
  tasks: Record<string, NormalizedTask>,
  taskId: string,
  plan: LifecyclePlanItem[],
  visited: Set<string>
): boolean {
  if (visited.has(taskId)) return true;
  visited.add(taskId);
  const task = tasks[taskId];
  if (!task) return false;
  if (task.retry.attempts !== 1 || task.retry.delayMs || task.timeoutMs !== undefined) {
    return false;
  }

  const lifecycleSteps = task.steps.map((step) => {
    if (typeof step === "object" && step && "kind" in step && step.kind === "shell") {
      return parseLifecycleCommand(step.command);
    }
    return undefined;
  });
  const lifecycleActions = lifecycleSteps.filter((step): step is LifecyclePlanItem => Boolean(step));
  if (lifecycleActions.length > 0) {
    if (lifecycleActions.length !== task.steps.length) return false;
    for (const dependency of task.dependsOn) {
      if (!appendLifecycleTaskPlan(tasks, dependency, plan, visited)) return false;
    }
    plan.push(...lifecycleActions);
    return true;
  }

  plan.push({ kind: "run-task", taskId });
  return true;
}

function parseLifecycleCommand(command: string): LifecyclePlanItem | undefined {
  if (containsUnsupportedShellSyntax(command)) return undefined;
  const argv = splitShellWords(command);
  const cliIndex = argv.findIndex(isPipelineCliToken);
  if (cliIndex < 0) return undefined;
  if (!isAllowedCliPrefix(argv.slice(0, cliIndex))) return undefined;
  const args = argv.slice(cliIndex + 1);
  const packagePath = flagValue(args, "--package") ?? ".";
  if (args[0] === "publish" && args[1] === "github" && (args[2] === "main" || args[2] === "pr")) {
    if (!hasOnlyAllowedOptions(args, 3, new Set(["--package", "--registry", "--namespace", "--token-env-name"]), new Set(["--no-comment"]))) return undefined;
    return {
      kind: "preview",
      mode: args[2],
      packagePath,
      registry: flagValue(args, "--registry") ?? "https://npm.pkg.github.com",
      namespace: flagValue(args, "--namespace"),
      comment: args[2] === "pr" && !args.includes("--no-comment"),
      tokenEnv: flagValue(args, "--token-env-name") ?? "GITHUB_TOKEN"
    };
  }
  if (args[0] === "publish" && args[1] === "github" && args[2] === "release") {
    if (!hasOnlyAllowedOptions(args, 3, new Set(["--package", "--registry", "--tag", "--dist-tag"]), new Set())) return undefined;
    return {
      kind: "publish",
      mode: "github-packages",
      packagePath,
      registry: flagValue(args, "--registry") ?? "https://npm.pkg.github.com",
      distTag: flagValue(args, "--tag") ?? flagValue(args, "--dist-tag") ?? "latest"
    };
  }
  if (args[0] === "publish" && args[1] === "npm") {
    if (!hasOnlyAllowedOptions(args, 2, new Set(["--package", "--registry", "--tag", "--dist-tag"]), new Set())) return undefined;
    return {
      kind: "publish",
      mode: "npm",
      packagePath,
      registry: flagValue(args, "--registry") ?? "https://registry.npmjs.org",
      distTag: flagValue(args, "--tag") ?? flagValue(args, "--dist-tag") ?? "latest"
    };
  }
  if (args[0] === "release" && args[1] === "ensure") {
    if (!hasOnlyAllowedOptions(args, 2, new Set(["--package"]), new Set())) return undefined;
    return {
      kind: "publish",
      mode: "github-release",
      packagePath,
      registry: "https://registry.npmjs.org",
      distTag: "latest"
    };
  }
  if (args[0] === "release" && args[1] === "doctor") {
    if (!hasOnlyAllowedOptions(args, 2, new Set(["--package"]), new Set())) return undefined;
    return {
      kind: "publish",
      mode: "doctor",
      packagePath,
      registry: "https://registry.npmjs.org",
      distTag: "latest"
    };
  }
  return undefined;
}

function renderLifecycleJobPlan(
  lines: string[],
  model: ReturnType<typeof buildRenderModel>,
  job: ReturnType<typeof buildRenderModel>["jobs"][number],
  plan: LifecyclePlanItem[]
): void {
  for (const item of plan) {
    if (item.kind === "run-task") {
      renderRunActionStep(
        lines,
        `Run pipeline task ${item.taskId}`,
        `${model.command} github check && ${model.command} run-task ${shellWord(item.taskId)}`,
        scopeTaskRunEnv(job.env, model.tasks[item.taskId]),
        { artifactName: `async-pipeline-\${{ github.job }}-${safeArtifactPart(item.taskId)}-runs` }
      );
      continue;
    }
    if (item.kind === "preview") {
      renderPreviewActionStep(lines, item, job.env);
      continue;
    }
    renderPublishActionStep(lines, item, job.env, job.requires?.provenance === true);
  }
}

function renderPreviewActionStep(lines: string[], preview: Extract<LifecyclePlanItem, { kind: "preview" }>, env: Record<string, EnvValue>): void {
  lines.push(
    "",
    `      - name: Publish ${preview.mode === "main" ? "main" : "PR"} package preview`,
    `        uses: ${ASYNC_PREVIEW_ACTION}`,
    "        with:",
    `          package-path: ${JSON.stringify(preview.packagePath)}`,
    `          target-registry: ${JSON.stringify(preview.registry)}`,
    ...(preview.namespace ? [`          namespace: ${JSON.stringify(preview.namespace)}`] : []),
    `          mode: ${preview.mode}`,
    `          comment: ${preview.comment ? "true" : "false"}`,
    `          token-env-name: ${JSON.stringify(preview.tokenEnv)}`
  );
  renderActionEnv(lines, scopeActionEnv(env, new Set([preview.tokenEnv])));
}

function renderPublishActionStep(
  lines: string[],
  publish: Extract<LifecyclePlanItem, { kind: "publish" }>,
  env: Record<string, EnvValue>,
  provenance: boolean
): void {
  const label = publish.mode === "github-release"
    ? "Create or update GitHub Release"
    : publish.mode === "github-packages"
      ? "Publish GitHub Packages mirror"
      : publish.mode === "doctor"
        ? "Run release doctor"
        : "Publish npm package";
  lines.push(
    "",
    `      - name: ${label}`,
    `        uses: ${ASYNC_PUBLISH_ACTION}`,
    "        with:",
    `          package-path: ${JSON.stringify(publish.packagePath)}`,
    `          mode: ${publish.mode}`,
    `          registry: ${JSON.stringify(publish.registry)}`,
    `          dist-tag: ${JSON.stringify(publish.distTag)}`,
    ...(publish.mode === "npm" ? ["          token-env-name: NODE_AUTH_TOKEN"] : []),
    ...(publish.mode === "github-packages" ? ["          token-env-name: GITHUB_TOKEN"] : []),
    ...(publish.mode === "npm" ? [`          provenance: ${provenance ? "true" : "false"}`] : [])
  );
  renderActionEnv(lines, scopeActionEnv(env, publish.mode === "npm" ? new Set(["NODE_AUTH_TOKEN"]) : new Set(["GITHUB_TOKEN"])));
}

function scopeActionEnv(env: Record<string, EnvValue>, allowedSecretNames: Set<string>): Record<string, EnvValue> {
  return Object.fromEntries(
    Object.entries(env).filter(([name, value]) => !isSecretEnvValue(value) || isAllowedSecretEnv(name, value, allowedSecretNames))
  );
}

function isSecretEnvValue(value: EnvValue): boolean {
  return typeof value === "object" && value !== null && "kind" in value && value.kind === "async-pipeline.env.secret";
}

function isAllowedSecretEnv(name: string, value: EnvValue, allowedSecretNames: Set<string>): boolean {
  if (allowedSecretNames.has(name)) return true;
  if (typeof value === "object" && value !== null && "name" in value && typeof value.name === "string") {
    return allowedSecretNames.has(value.name);
  }
  return false;
}

function scopeTaskRunEnv(env: Record<string, EnvValue>, task: NormalizedTask | undefined): Record<string, EnvValue> {
  return scopeActionEnv(env, new Set(task?.requires?.secrets ?? []));
}

function renderActionEnv(lines: string[], env: Record<string, EnvValue>): void {
  lines.push(
    "        env:",
    "          CI: true"
  );
  for (const [envName, value] of Object.entries(env).sort(([left], [right]) => left.localeCompare(right))) {
    const rendered = renderGitHubEnvValue(value);
    if (rendered !== undefined) {
      lines.push(`          ${envName}: ${rendered}`);
    }
  }
}

function isPipelineCliToken(token: string): boolean {
  return token === "async-pipeline" || token.includes("@async/pipeline/cli");
}

function containsUnsupportedShellSyntax(command: string): boolean {
  return /(?:^|\s)(?:&&|\|\||;|\||&|>|<)(?:\s|$)|[`]|\$\(/u.test(command);
}

function isAllowedCliPrefix(prefix: string[]): boolean {
  const rendered = prefix.join(" ");
  return [
    "",
    "pnpm",
    "pnpm exec",
    "npx",
    "npm exec",
    "npm exec --",
    "deno run -A"
  ].includes(rendered);
}

function hasOnlyAllowedOptions(args: string[], startIndex: number, valueFlags: Set<string>, booleanFlags: Set<string>): boolean {
  for (let index = startIndex; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) return false;
    if (booleanFlags.has(arg)) continue;
    if (!valueFlags.has(arg)) return false;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) return false;
    index += 1;
  }
  return true;
}

function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function splitShellWords(command: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;
  let escaped = false;
  for (const character of command) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else {
        current += character;
      }
      continue;
    }
    if (character === "'" || character === "\"") {
      quote = character;
      continue;
    }
    if (/\s/u.test(character)) {
      if (current) {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }
  if (current) words.push(current);
  return words;
}

function safeArtifactPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/gu, "-");
}

function renderPackagePreviewJob(lines: string[], model: ReturnType<typeof buildRenderModel>): void {
  const preview = model.packagePreviews;
  if (!preview.package || !preview.target) return;
  lines.push(
    "  package-preview:",
    "    name: package-preview",
    "    if: github.event_name == 'pull_request' && github.event.pull_request.draft == false",
    "    runs-on: ubuntu-latest",
    "    permissions:",
    "      contents: read",
    "      issues: write",
    "      packages: write",
    "      pull-requests: write",
    "    steps:",
    "      - name: Checkout",
    `        uses: ${CHECKOUT_ACTION}`,
    "        with:",
    "          persist-credentials: false",
    "",
    ...(model.taskCache
      ? [
          "      - name: Restore task cache",
          `        uses: ${CACHE_ACTION}`,
          "        with:",
          "          path: .async/cache",
          "          key: async-pipeline-${{ runner.os }}-${{ github.sha }}",
          "          restore-keys: |",
          "            async-pipeline-${{ runner.os }}-",
          ""
        ]
      : []),
    ...renderSetupSteps(model),
    ...renderDependencyInstallSteps(model)
  );
  if (model.buildCommand) {
    lines.push(
      "",
      "      - name: Build pipeline CLI",
      `        run: ${model.buildCommand}`
    );
  }
  renderRunActionStep(lines, "Run package preview target", `${model.command} github check && ${model.command} run-task ${shellWord(preview.target)}`, {});
  lines.push(
    "",
    "      - name: Publish package preview",
    `        uses: ${ASYNC_PREVIEW_ACTION}`,
    "        with:",
    `          package-path: ${JSON.stringify(preview.package)}`,
    `          target-registry: ${JSON.stringify(preview.registry)}`,
    ...(preview.namespace ? [`          namespace: ${JSON.stringify(preview.namespace)}`] : []),
    "          mode: pr",
    `          comment: ${preview.comment ? "true" : "false"}`,
    `          token-env-name: ${JSON.stringify(preview.tokenEnv)}`,
    "        env:",
    "          CI: true",
    `          ${preview.tokenEnv}: \${{ secrets.${preview.tokenEnv} }}`,
    ""
  );
  lines.push("");
}

function renderBridgeJob(lines: string[], model: ReturnType<typeof buildRenderModel>): void {
  const bridge = model.bridge;
  lines.push(
    `  ${bridge.job}:`,
    `    name: ${bridge.job}`,
    `    if: ${renderBridgeCondition(bridge)}`,
    "    runs-on: ubuntu-latest",
    "    permissions:",
    "      contents: write",
    "      pull-requests: write",
    "    concurrency:",
    "      group: async-bridge-${{ github.repository }}",
    "      cancel-in-progress: false",
    "    steps:",
    "      - name: Checkout",
    `        uses: ${CHECKOUT_ACTION}`,
    "        with:",
    "          persist-credentials: false",
    "",
    ...(model.taskCache
      ? [
          "      - name: Restore task cache",
          `        uses: ${CACHE_ACTION}`,
          "        with:",
          "          path: .async/cache",
          "          key: async-pipeline-${{ runner.os }}-${{ github.sha }}",
          "          restore-keys: |",
          "            async-pipeline-${{ runner.os }}-",
          ""
        ]
      : []),
    ...renderSetupSteps(model),
    ...renderDependencyInstallSteps(model)
  );
  if (model.buildCommand) {
    lines.push(
      "",
      "      - name: Build pipeline CLI",
      `        run: ${model.buildCommand}`
    );
  }
  renderRunActionStep(lines, "Check generated workflow", `${model.command} github check`, {});
  renderBridgePullStep(lines, bridge);
  lines.push("");
}

function renderBridgeCondition(bridge: ReturnType<typeof buildRenderModel>["bridge"]): string {
  const conditions: string[] = [];
  if (bridge.actionsJob.scheduled && bridge.schedule) {
    conditions.push(`github.event_name == 'schedule' && github.event.schedule == '${escapeExpressionString(bridge.schedule)}'`);
  }
  if (bridge.actionsJob.manual) {
    conditions.push(`github.event_name == 'workflow_dispatch' && github.event.inputs.job == '${bridge.job}'`);
  }
  return conditions.length > 0 ? conditions.join(" || ") : "false";
}

function renderBridgePullStep(lines: string[], bridge: ReturnType<typeof buildRenderModel>["bridge"]): void {
  const command = [
    "npx",
    "--yes",
    `@async/github-app@${bridge.packageVersion}`,
    "actions",
    "pull",
    "--branch-prefix",
    bridge.branchPrefix,
    "--pull-request",
    String(bridge.pullRequest),
    ...bridge.allowedPaths.flatMap((path) => ["--allowed-path", path])
  ].map(shellWord).join(" ");
  lines.push(
    "",
    "      - name: Pull and apply Async bridge change sets",
    `        uses: ${ASYNC_RUN_ACTION}`,
    "        with:",
    `          command: ${JSON.stringify(command)}`,
    "          check-generated: false",
    "          artifact-name: async-bridge-${{ github.run_id }}",
    "        env:",
    "          CI: true",
    `          ASYNC_PROJECT_URL: \${{ vars.${bridge.endpointVar} }}`,
    `          ASYNC_PROJECT_TOKEN: \${{ secrets.${bridge.tokenEnv} }}`,
    "          GITHUB_REPOSITORY: ${{ github.repository }}",
    "          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}"
  );
}

function renderDependabotAutoMergeJob(lines: string[], ecosystems: string[]): void {
  lines.push(
    "  dependabot-auto-merge:",
    "    name: dependabot-auto-merge",
    "    if: github.event.pull_request.user.login == 'dependabot[bot]' && github.event.pull_request.draft == false",
    "    runs-on: ubuntu-latest",
    "    permissions:",
    "      contents: write",
    "      pull-requests: write",
    "    steps:",
    "      - name: Fetch Dependabot metadata",
    "        id: dependabot-metadata",
    `        uses: ${DEPENDABOT_FETCH_METADATA_ACTION}`,
    "        with:",
    "          github-token: ${{ secrets.GITHUB_TOKEN }}",
    "",
    "      - name: Merge validated Dependabot PR",
    `        uses: ${ASYNC_DEPENDABOT_MERGE_ACTION}`,
    "        with:",
    "          pull-request-number: ${{ github.event.pull_request.number }}",
    "          actor: ${{ github.event.pull_request.user.login }}",
    "          dependency-ecosystem: ${{ steps.dependabot-metadata.outputs.package-ecosystem }}",
    "          allowed-ecosystems: |",
    ...ecosystems.map((ecosystem) => `            ${ecosystem}`),
    "        env:",
    "          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}",
    ""
  );
}

function renderSetupSteps(model: ReturnType<typeof buildRenderModel>): string[] {
  const pnpmVersion = pnpmSetupVersion(model.packageManager, model.packageManagerVersion);
  if (model.setup === "async") {
    return [
      "      - name: Setup Async runtimes",
      `        uses: ${ASYNC_SETUP_ACTION}`,
      "        with:",
      `          node-version: ${model.nodeVersion}`,
      `          pnpm-version: ${pnpmVersion}`,
      "          npm-version: 11.16.0",
      "          runtime: |",
      ...model.runtime.map((runtime) => `            ${runtime.spec}`),
      `          package-manager: ${model.packageManager}`,
      "          install: true",
      "          frozen-lockfile: true",
      `          cache: ${model.dependencyCache && model.dependencyCachePath ? "true" : "false"}`,
      ...(model.dependencyCache && model.dependencyCachePath
        ? [
            `          dependency-cache-path: ${JSON.stringify(model.dependencyCachePath)}`
          ]
        : []),
      "          registry-url: https://registry.npmjs.org/",
      ""
    ];
  }
  if (model.setup === "pnpm") {
    if (model.projectKind === "deno") {
      return renderDenoOnlySetupSteps(model);
    }
    const primaryRuntimeIndex = pnpmSetupRuntimeIndex(model.runtime);
    const primaryRuntime = model.runtime[primaryRuntimeIndex];
    if (!primaryRuntime) {
      throw pipelineError("ASYNC_PIPELINE_SYNC_INVALID_RUNTIME", "sync.github.runtime must resolve to at least one runtime.");
    }
    const additionalRuntimes = model.runtime.filter((_runtime, index) => index !== primaryRuntimeIndex);
    return [
      "      - name: Setup pnpm runtime",
      `        uses: ${PNPM_SETUP_ACTION}`,
      "        with:",
      `          version: ${pnpmVersion}`,
      `          runtime: ${primaryRuntime.spec}`,
      "          install: false",
      `          cache: ${model.dependencyCache && model.dependencyCachePath ? "true" : "false"}`,
      ...(model.dependencyCache && model.dependencyCachePath
        ? [
            `          cache-dependency-path: ${JSON.stringify(model.dependencyCachePath)}`
          ]
        : []),
      "",
      ...renderRuntimeSetupSteps(additionalRuntimes),
      ...(additionalRuntimes.length > 0 ? [""] : [])
    ];
  }

  const nodeRuntime = model.runtime.find((runtime) => runtime.name === "node");
  if (!nodeRuntime || model.runtime.length > 1) {
    throw pipelineError(
      "ASYNC_PIPELINE_SYNC_INVALID_RUNTIME_SETUP",
      'sync.github.setup: "node" can only install a single Node runtime. Use setup: "auto" or "pnpm" for deno or bun runtimes.'
    );
  }

  return [
    "      - name: Setup Node",
    `        uses: ${SETUP_NODE_ACTION}`,
    "        with:",
    `          node-version: ${nodeRuntime.version ?? model.nodeVersion}`,
    "          registry-url: https://registry.npmjs.org/",
    ...renderSetupNodeCacheLines(model, { pnpmAvailableBeforeSetupNode: false }),
    "",
    "      - name: Enable pnpm",
    "        run: |",
    "          corepack enable",
    `          corepack prepare pnpm@${pnpmVersion} --activate`,
    ""
  ];
}

function renderDenoOnlySetupSteps(model: ReturnType<typeof buildRenderModel>): string[] {
  const lines: string[] = [];
  for (const runtime of model.runtime) {
    if (runtime.name === "deno") {
      lines.push(
        ...renderDenoSetupSteps(runtime, {
          dependencyCache: model.dependencyCache,
          dependencyCachePath: model.dependencyCachePath
        }),
        ""
      );
    } else if (runtime.name === "node") {
      lines.push(...renderNodeSetupSteps(runtime, model.nodeVersion), "");
    } else {
      lines.push(
        "      - name: Setup additional runtimes",
        "        run: |",
        `          pnpm runtime set ${runtime.name} ${runtime.version ?? "latest"} -g`,
        ""
      );
    }
  }
  return lines;
}

function pnpmSetupRuntimeIndex(runtimes: RuntimeSpec[]): number {
  const nodeIndex = runtimes.findIndex((runtime) => runtime.name === "node");
  if (nodeIndex >= 0) return nodeIndex;
  const nonDenoIndex = runtimes.findIndex((runtime) => runtime.name !== "deno");
  if (nonDenoIndex >= 0) return nonDenoIndex;
  return 0;
}

function renderRuntimeSetupSteps(runtimes: RuntimeSpec[]): string[] {
  if (runtimes.length === 0) return [];
  const lines: string[] = [];
  const pnpmRuntimes = runtimes.filter((runtime) => runtime.name !== "deno");
  for (const runtime of runtimes) {
    if (runtime.name === "deno") {
      if (lines.length > 0) lines.push("");
      lines.push(...renderDenoSetupSteps(runtime));
    }
  }
  if (pnpmRuntimes.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(...renderPnpmRuntimeSetupSteps(pnpmRuntimes));
  }
  return lines;
}

function renderDenoSetupSteps(runtime: RuntimeSpec, options: { dependencyCache?: boolean; dependencyCachePath?: string } = {}): string[] {
  return [
    "      - name: Setup Deno",
    `        uses: ${DENO_SETUP_ACTION}`,
    "        with:",
    `          deno-version: ${runtime.version ?? "latest"}`,
    ...(options.dependencyCache && options.dependencyCachePath
      ? [
          "          cache: true",
          `          cache-hash: \${{ hashFiles('${options.dependencyCachePath}') }}`
        ]
      : [])
  ];
}

function renderNodeSetupSteps(runtime: RuntimeSpec, defaultNodeVersion: string): string[] {
  return [
    "      - name: Setup Node",
    `        uses: ${SETUP_NODE_ACTION}`,
    "        with:",
    `          node-version: ${runtime.version ?? defaultNodeVersion}`,
    "          registry-url: https://registry.npmjs.org/"
  ];
}

function renderPnpmRuntimeSetupSteps(runtimes: RuntimeSpec[]): string[] {
  return [
    "      - name: Setup additional runtimes",
    "        run: |",
    ...runtimes.map((runtime) => `          pnpm runtime set ${runtime.name} ${runtime.version ?? "latest"} -g`)
  ];
}

function renderSetupNodeCacheLines(model: ReturnType<typeof buildRenderModel>, options: { pnpmAvailableBeforeSetupNode: boolean }): string[] {
  const canUseDependencyCache = model.dependencyCache && model.dependencyCachePath && (model.packageManager !== "pnpm" || options.pnpmAvailableBeforeSetupNode);
  if (canUseDependencyCache) {
    return [
      `          cache: ${JSON.stringify(model.packageManager)}`,
      `          cache-dependency-path: ${JSON.stringify(model.dependencyCachePath)}`
    ];
  }
  if (model.packageManager === "npm" || (model.packageManager === "pnpm" && !options.pnpmAvailableBeforeSetupNode)) {
    return [
      "          package-manager-cache: false"
    ];
  }
  return [];
}

function resolveGitHubSetup(setup: string, packageManager: string, packageManagerVersion: string | undefined): string {
  if (setup !== "pnpm") return setup;
  if (pnpmSupportsRuntime(pnpmSetupVersion(packageManager, packageManagerVersion))) return "pnpm";
  return "node";
}

function pnpmSetupVersion(packageManager: string, packageManagerVersion: string | undefined): string {
  return packageManager === "pnpm" && packageManagerVersion ? packageManagerVersion : DEFAULT_PNPM_VERSION;
}

function pnpmSupportsRuntime(version: string): boolean {
  const major = /^(\d+)/.exec(version)?.[1];
  return major !== undefined && Number(major) >= 11;
}

function resolveRuntimeSpecs(configured: string[], projectKind: PackageInfo["projectKind"], nodeVersion: string): RuntimeSpec[] {
  const runtimeSpecs = configured.length > 0 ? configured : [projectKind === "deno" ? `deno@${DEFAULT_DENO_VERSION}` : `node@${nodeVersion}`];
  return runtimeSpecs.map(parseRuntimeSpec);
}

function parseRuntimeSpec(spec: string): RuntimeSpec {
  const match = /^(node|deno|bun)(?:@(.+))?$/.exec(spec);
  if (!match) {
    throw pipelineError("ASYNC_PIPELINE_SYNC_INVALID_RUNTIME", `Invalid GitHub runtime "${spec}". Use node, deno, or bun with an optional version.`);
  }
  const name = match[1] as GitHubRuntimeName;
  const version = match[2];
  return {
    name,
    version,
    spec: version ? `${name}@${version}` : name
  };
}

function resolvePipelineCommand(command: string, projectKind: PackageInfo["projectKind"], packageManager: string): string {
  if (command !== "async-pipeline") return command;
  if (projectKind === "deno") return DEFAULT_DENO_PIPELINE_COMMAND;
  return `${packageManager} ${command}`;
}

function renderPagesBuildSteps(lines: string[], pages: GitHubPagesConfig): void {
  lines.push(
    "      - name: Upload Pages artifact",
    `        uses: ${ASYNC_PAGES_ACTION}`,
    "        with:",
    `          mode: ${pages.build.kind}`
  );
  if (pages.build.kind === "jekyll") {
    lines.push(
      `          source: ${JSON.stringify(pages.build.source)}`,
      `          destination: ${JSON.stringify(pages.build.destination ?? "./_site")}`
    );
  } else {
    lines.push(`          path: ${JSON.stringify(pages.build.path)}`);
  }
  if (pages.build.kind === "prerender") {
    lines.push(
      `          validate-index: ${pages.build.validateIndex ?? true}`,
      `          spa-fallback: ${pages.build.spaFallback ?? false}`
    );
  }
  if (pages.artifactName) lines.push(`          artifact-name: ${JSON.stringify(pages.artifactName)}`);
}

function renderPagesDeployJob(lines: string[], job: ReturnType<typeof buildRenderModel>["jobs"][number]): void {
  const pages = job.github?.pages;
  if (!pages) return;
  const deployJobId = `${job.id}-deploy`;
  lines.push(
    `  ${yamlKey(deployJobId)}:`,
    `    name: ${deployJobId}`,
    `    needs: ${JSON.stringify(job.id)}`,
    "    if: github.event_name != 'pull_request'",
    "    runs-on: ubuntu-latest"
  );
  const environment = pages.environment ?? {
    name: "github-pages",
    url: "${{ steps.deployment.outputs.page_url }}"
  };
  renderGitHubEnvironment(lines, environment);
  lines.push(
    "    permissions:",
    "      pages: write",
    "      id-token: write",
    "    steps:",
    "      - name: Deploy to GitHub Pages",
    "        id: deployment",
    `        uses: ${ASYNC_PAGES_ACTION}`,
    "        with:",
    "          upload: false",
    "          deploy: true"
  );
  if (pages.artifactName) {
    lines.push(`          artifact-name: ${JSON.stringify(pages.artifactName)}`);
  }
  lines.push("");
}

function renderGitHubEnvironment(lines: string[], environment: JobEnvironment): void {
  if (typeof environment === "string") {
    lines.push(`    environment: ${JSON.stringify(environment)}`);
    return;
  }
  lines.push(
    "    environment:",
    `      name: ${JSON.stringify(environment.name)}`
  );
  if (environment.url) {
    lines.push(`      url: ${JSON.stringify(environment.url)}`);
  }
}

function renderGitHubEnvValue(value: EnvValue): string | undefined {
  if (typeof value === "string") return JSON.stringify(value);
  if (value.kind === "async-pipeline.env.secret") return `\${{ secrets.${value.name} }}`;
  if (value.kind === "async-pipeline.env.var" && !value.values) return `\${{ vars.${value.name} }}`;
  return undefined;
}

function renderOn(lines: string[], triggers: Record<string, unknown>, manualDispatchJobs: string[]): void {
  for (const [event, value] of Object.entries(triggers)) {
    if (event === "schedule" && Array.isArray(value)) {
      lines.push("  schedule:");
      for (const schedule of value as Array<{ cron: string; timezone?: string }>) {
        lines.push(`    - cron: ${JSON.stringify(schedule.cron)}`);
        if (schedule.timezone) lines.push(`      timezone: ${JSON.stringify(schedule.timezone)}`);
      }
      continue;
    }
    if (event === "workflow_dispatch") {
      lines.push("  workflow_dispatch:");
      if (manualDispatchJobs.length > 0) {
        lines.push(
          "    inputs:",
          "      job:",
          "        description: \"Pipeline job to run\"",
          "        required: true",
          "        type: choice",
          "        options:"
        );
        for (const jobId of manualDispatchJobs) {
          lines.push(`          - ${JSON.stringify(jobId)}`);
        }
      }
      continue;
    }
    const filters = value as Record<string, unknown>;
    if (Object.keys(filters).length === 0) {
      lines.push(`  ${event}:`);
      continue;
    }
    lines.push(`  ${event}:`);
    for (const [key, values] of Object.entries(filters)) {
      if (!Array.isArray(values) || values.length === 0) continue;
      lines.push(`    ${key}:`);
      for (const item of values) lines.push(`      - ${JSON.stringify(item)}`);
    }
  }
}

function mergeEventFilters(existing: Record<string, unknown>, trigger: TriggerDefinition): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing };
  for (const key of ["types", "branches", "paths", "tags"] as const) {
    if (!trigger[key]) continue;
    merged[key] = [...new Set([...(Array.isArray(merged[key]) ? merged[key] as string[] : []), ...trigger[key]])].sort();
  }
  return merged;
}

function triggerMatches(triggerId: string, trigger: TriggerDefinition, context: GitHubEventContext): boolean {
  if (trigger.type === "manual") return context.eventName === "workflow_dispatch";
  if (trigger.type === "schedule") {
    return context.eventName === "schedule" && (!trigger.cron || !context.schedule || trigger.cron === context.schedule);
  }
  if (trigger.type !== "github") return false;
  if (!(trigger.events ?? []).includes(context.eventName)) return false;
  if (trigger.types?.length && (!context.action || !matchesAnyPattern(context.action, trigger.types))) return false;
  const branch = branchForEvent(context);
  if (trigger.branches && branch && !matchesAnyPattern(branch, trigger.branches)) return false;
  if (trigger.tags && context.ref?.startsWith("refs/tags/")) {
    const tag = context.ref.slice("refs/tags/".length);
    if (!matchesAnyPattern(tag, trigger.tags)) return false;
  }
  return Boolean(triggerId);
}

function renderGitHubJobCondition(job: NormalizedJob, triggers: Record<TriggerId, TriggerDefinition>): string | undefined {
  const clauses = job.trigger.flatMap((triggerId) => {
    const trigger = triggers[triggerId];
    if (!trigger) return [];
    if (trigger.type === "manual") return [`github.event_name == 'workflow_dispatch' && github.event.inputs.job == '${escapeExpressionString(job.id)}'`];
    if (trigger.type === "schedule") {
      return trigger.cron
        ? [`github.event_name == 'schedule' && github.event.schedule == '${escapeExpressionString(trigger.cron)}'`]
        : ["github.event_name == 'schedule'"];
    }
    if (trigger.type === "github") {
      return (trigger.events ?? []).map((event) => {
        const filters: string[] = [`github.event_name == '${escapeExpressionString(event)}'`];
        if (trigger.branches?.length) {
          filters.push(`(${trigger.branches.map((branch) => `github.ref == 'refs/heads/${escapeExpressionString(branch)}'`).join(" || ")})`);
        }
        if (trigger.types?.length) {
          filters.push(`(${trigger.types.map((type) => `github.event.action == '${escapeExpressionString(type)}'`).join(" || ")})`);
        }
        if (trigger.tags?.length) {
          filters.push(`(${trigger.tags.map((tag) => `github.ref == 'refs/tags/${escapeExpressionString(tag)}'`).join(" || ")})`);
        }
        return filters.join(" && ");
      });
    }
    return [];
  });
  if (clauses.length === 0) return undefined;
  return clauses.length === 1 ? clauses[0] : clauses.map((clause) => `(${clause})`).join(" || ");
}

function workflowDispatchInput(payload: unknown, name: string): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const inputs = (payload as { inputs?: unknown }).inputs;
  if (!inputs || typeof inputs !== "object") return undefined;
  const value = (inputs as Record<string, unknown>)[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function eventAction(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const action = (payload as { action?: unknown }).action;
  return typeof action === "string" && action.length > 0 ? action : undefined;
}

function branchForEvent(context: GitHubEventContext): string | undefined {
  if (context.baseRef) return context.baseRef;
  if (context.ref?.startsWith("refs/heads/")) return context.ref.slice("refs/heads/".length);
  if (context.payload && typeof context.payload === "object") {
    const pullRequest = (context.payload as { pull_request?: { base?: { ref?: string } } }).pull_request;
    if (pullRequest?.base?.ref) return pullRequest.base.ref;
  }
  return undefined;
}

function matchesAnyPattern(value: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(value));
}

function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (const char of pattern) {
    source += char === "*" ? ".*" : char.replaceAll(/[\\^$+?.()|[\]{}]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

async function readPackageInfo(cwd: string): Promise<PackageInfo> {
  const packagePath = join(cwd, "package.json");
  if (!existsSync(packagePath)) {
    const denoManifest = denoManifestPath(cwd);
    if (denoManifest) {
      return {
        packageManager: "deno",
        projectKind: "deno",
        dependencyCachePath: existsSync(join(cwd, "deno.lock")) ? "deno.lock" : undefined,
        publicPackagePaths: []
      };
    }
    return { packageManager: "pnpm", projectKind: "package", publicPackagePaths: [] };
  }
  const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as {
    name?: string;
    private?: boolean;
    packageManager?: string;
    scripts?: Record<string, string>;
  };
  const parsedPackageManager = parsePackageManager(packageJson.packageManager);
  const packageManager = parsedPackageManager.name;
  const asyncPipelineScript = packageJson.scripts?.["async-pipeline"] ?? "";
  const buildCommand = asyncPipelineScript.includes("dist/cli.js") && packageJson.scripts?.build ? `${packageManager} build` : undefined;
  return {
    packageManager,
    packageManagerVersion: parsedPackageManager.version,
    buildCommand,
    projectKind: "package",
    dependencyCachePath: dependencyLockfilePath(cwd, packageManager),
    publicPackagePaths: await findPublicPackagePaths(cwd, packageJson)
  };
}

function denoManifestPath(cwd: string): string | undefined {
  for (const name of ["deno.json", "deno.jsonc"]) {
    if (existsSync(join(cwd, name))) return name;
  }
  return undefined;
}

function parsePackageManager(packageManager: string | undefined): { name: string; version?: string } {
  if (typeof packageManager !== "string") return { name: "pnpm" };
  const match = /^(npm|pnpm|yarn)@(.+)$/.exec(packageManager);
  const name = match?.[1];
  const version = match?.[2];
  if (!name || !version) return { name: "pnpm" };
  return { name, version };
}

async function findPublicPackagePaths(cwd: string, rootPackageJson: { name?: string; private?: boolean }): Promise<string[]> {
  const publicPackages: string[] = [];
  if (typeof rootPackageJson.name === "string" && !rootPackageJson.private) {
    publicPackages.push(".");
  }
  const packagesDir = join(cwd, "packages");
  if (!existsSync(packagesDir)) return publicPackages;
  const entries = await readdir(packagesDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const packagePath = join(packagesDir, entry.name, "package.json");
    if (!existsSync(packagePath)) continue;
    const manifest = JSON.parse(await readFile(packagePath, "utf8")) as { name?: string; private?: boolean };
    if (typeof manifest.name === "string" && !manifest.private) {
      publicPackages.push(`packages/${entry.name}`);
    }
  }
  return publicPackages.sort();
}

function dependencyLockfilePath(cwd: string, packageManager: string): string | undefined {
  if (packageManager === "deno") return existsSync(join(cwd, "deno.lock")) ? "deno.lock" : undefined;
  const lockfile = packageManager === "npm"
    ? "package-lock.json"
    : packageManager === "yarn"
      ? "yarn.lock"
      : "pnpm-lock.yaml";
  return existsSync(join(cwd, lockfile)) ? lockfile : undefined;
}

function sortObject(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).sort(([left], [right]) => left.localeCompare(right)));
}

function yamlKey(value: string): string {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(value) ? value : JSON.stringify(value);
}

function shellWord(value: string): string {
  return /^[A-Za-z0-9_./:-]+$/.test(value) ? value : JSON.stringify(value);
}

function escapeExpressionString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

function hashJson(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function relativePath(cwd: string, path: string): string {
  const relativeConfig = relative(cwd, resolve(path));
  if (relativeConfig.startsWith("..")) {
    throw pipelineError("ASYNC_PIPELINE_GITHUB_CONFIG_OUTSIDE_ROOT", `Pipeline config "${path}" must be inside ${cwd}.`);
  }
  return relativeConfig || "pipeline.ts";
}
