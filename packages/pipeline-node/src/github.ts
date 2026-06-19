import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type { EnvValue, ExecutionProfileId, GitHubJobConfig, GitHubPagesConfig, GitHubRuntimeName, JobEnvironment, JobRequirements, JobId, NormalizedGitHubAttestConfig, NormalizedGitHubBridgeSyncConfig, NormalizedGitHubContractConfig, NormalizedGitHubEvidenceConfig, NormalizedGitHubHygieneConfig, NormalizedGitHubPagesSyncConfig, NormalizedGitHubSourceImpactConfig, NormalizedJob, NormalizedPackagePreviewsConfig, NormalizedPipeline, NormalizedTask, TriggerDefinition, TriggerId } from "@async/pipeline-core";
import { githubConfigForJob, pipelineError } from "@async/pipeline-core";
import { sourceImpactPlanForJob, type SourceImpactPlan } from "./sources.js";

export const GITHUB_WORKFLOW_PATH = ".github/workflows/async-pipeline.yml";
export const GITHUB_LOCK_PATH = ".locks/pipeline/github-workflow.lock.json";
export const LEGACY_GITHUB_LOCK_PATH = ".github/async-pipeline.lock.json";
const GENERATOR_VERSION = 22;
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

const ASYNC_ACTIONS_SHA = "e77416c811e51a2218543656617fbb5688238540";
const ASYNC_ACTIONS_LABEL = "v0.1.18";
const ASYNC_RELEASE_PACKAGE = "github:async/release#v0.1.3";
const ASYNC_RELEASE_COMMAND = `pnpm dlx ${ASYNC_RELEASE_PACKAGE}`;

const GENERATED_ACTIONS = [
  defineActionRef("async.actions.setup", "async/actions/setup", ASYNC_ACTIONS_SHA, ASYNC_ACTIONS_LABEL),
  defineActionRef("async.actions.run", "async/actions/run", ASYNC_ACTIONS_SHA, ASYNC_ACTIONS_LABEL),
  defineActionRef("async.actions.pages", "async/actions/pages", ASYNC_ACTIONS_SHA, ASYNC_ACTIONS_LABEL),
  defineActionRef("async.actions.preview", "async/actions/preview", ASYNC_ACTIONS_SHA, ASYNC_ACTIONS_LABEL),
  defineActionRef("async.actions.publish", "async/actions/publish", ASYNC_ACTIONS_SHA, ASYNC_ACTIONS_LABEL),
  defineActionRef("async.actions.doctor", "async/actions/doctor", ASYNC_ACTIONS_SHA, ASYNC_ACTIONS_LABEL),
  defineActionRef("async.actions.comment", "async/actions/comment", ASYNC_ACTIONS_SHA, ASYNC_ACTIONS_LABEL),
  defineActionRef("async.actions.dependabot-merge", "async/actions/dependabot-merge", ASYNC_ACTIONS_SHA, ASYNC_ACTIONS_LABEL),
  defineActionRef("async.actions.evidence", "async/actions/evidence", ASYNC_ACTIONS_SHA, ASYNC_ACTIONS_LABEL),
  defineActionRef("async.actions.agent-evidence", "async/actions/agent-evidence", ASYNC_ACTIONS_SHA, ASYNC_ACTIONS_LABEL),
  defineActionRef("async.actions.source-impact", "async/actions/source-impact", ASYNC_ACTIONS_SHA, ASYNC_ACTIONS_LABEL),
  defineActionRef("async.actions.cache", "async/actions/cache", ASYNC_ACTIONS_SHA, ASYNC_ACTIONS_LABEL),
  defineActionRef("async.actions.attest", "async/actions/attest", ASYNC_ACTIONS_SHA, ASYNC_ACTIONS_LABEL),
  defineActionRef("async.actions.contract", "async/actions/contract", ASYNC_ACTIONS_SHA, ASYNC_ACTIONS_LABEL),
  defineActionRef("async.actions.hygiene", "async/actions/hygiene", ASYNC_ACTIONS_SHA, ASYNC_ACTIONS_LABEL),
  defineActionRef("actions.checkout", "actions/checkout", "de0fac2e4500dabe0009e67214ff5f5447ce83dd", "v6.0.2"),
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
const ASYNC_DOCTOR_ACTION = actionRef("async.actions.doctor");
const ASYNC_COMMENT_ACTION = actionRef("async.actions.comment");
const ASYNC_DEPENDABOT_MERGE_ACTION = actionRef("async.actions.dependabot-merge");
const ASYNC_EVIDENCE_ACTION = actionRef("async.actions.evidence");
const ASYNC_AGENT_EVIDENCE_ACTION = actionRef("async.actions.agent-evidence");
const ASYNC_SOURCE_IMPACT_ACTION = actionRef("async.actions.source-impact");
const ASYNC_CACHE_ACTION = actionRef("async.actions.cache");
const ASYNC_ATTEST_ACTION = actionRef("async.actions.attest");
const ASYNC_CONTRACT_ACTION = actionRef("async.actions.contract");
const ASYNC_HYGIENE_ACTION = actionRef("async.actions.hygiene");
const CHECKOUT_ACTION = actionRef("actions.checkout");
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
  evidence: NormalizedGitHubEvidenceConfig;
  sourceImpact: NormalizedGitHubSourceImpactConfig & {
    generatedJobs: Array<{ job: string; planJob: string; matrixJob: string; matrixRows: number; sources: string[] }>;
  };
  attest: NormalizedGitHubAttestConfig;
  contract: NormalizedGitHubContractConfig;
  hygiene: NormalizedGitHubHygieneConfig;
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

interface RenderJobModel {
  id: JobId;
  target: string[];
  trigger: string[];
  env: Record<string, EnvValue>;
  environment?: JobEnvironment;
  requires?: JobRequirements;
  execution?: ExecutionProfileId;
  github?: GitHubJobConfig;
  if?: string;
}

interface SourceImpactRenderJob {
  job: JobId;
  planJob: JobId;
  matrixJob: JobId;
  planPath: string;
  plan: SourceImpactPlan;
  if?: string;
  github?: GitHubJobConfig;
  env: Record<string, EnvValue>;
}

type LifecyclePlanItem =
  | { kind: "run-task"; taskId: string }
  | { kind: "preview"; mode: "main" | "pr"; packagePath: string; registry: string; namespace?: string; comment: boolean; tokenEnv: string }
  | { kind: "publish"; mode: "npm" | "github-packages" | "github-release"; packagePath: string; registry: string; distTag: string }
  | { kind: "release"; mode: "doctor"; packagePath: string };

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

export type GitHubLocalNetworkMode = "mock" | "deny" | "allow";

export interface GitHubManifestEvent {
  name: string;
  action?: string;
  ref?: string;
  sha?: string;
  actor?: string;
  schedule?: string;
  selectedJob?: string;
  pullRequest?: {
    number?: number;
    headRepo?: string;
    headSha?: string;
    baseRef?: string;
  };
}

export interface GitHubManifestStep {
  id: string;
  name: string;
  uses?: string;
  label?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
  permissions?: Record<string, "read" | "write">;
  secrets: string[];
  local: {
    contract: string;
    mode: "action" | "shell" | "mock";
    network: GitHubLocalNetworkMode;
    networked: boolean;
    dangerous: boolean;
    mockReason?: string;
    fallbackReason?: string;
  };
}

export interface GitHubJobManifest {
  version: 1;
  generatedBy: "@async/pipeline";
  repo: string;
  workflow: string;
  lock: string;
  event: GitHubManifestEvent;
  job: {
    id: string;
    name: string;
    kind: "pipeline" | "generated";
    target: string[];
    runsOn: string | string[];
    matrix?: Array<{ runner: string[]; index: number }>;
    permissions: Record<string, "read" | "write">;
    environment: JobEnvironment | null;
    concurrency: string | null;
    if: string | null;
    trigger: string[];
  };
  steps: GitHubManifestStep[];
  trust: {
    actionRefsPinned: boolean;
    workflow: string;
    lock: string;
    lifecycleFallbackReason: string | null;
  };
  artifacts: Array<{
    name: string;
    path: string;
    mode: "upload" | "download" | "local";
    producerJob?: string;
    consumerJob?: string;
    retentionDays?: number;
    ifNoFilesFound?: string;
  }>;
  local: {
    workspace: string;
    stateDirectory: string;
    network: GitHubLocalNetworkMode;
    permissionsMode: "enforced";
    mocks: string[];
  };
}

export interface GitHubPlanOptions extends GitHubRenderOptions {
  job?: string;
  eventName?: string;
  eventAction?: string;
  ref?: string;
  sha?: string;
  actor?: string;
  schedule?: string;
  selectedJob?: string;
  prNumber?: number;
  headRepo?: string;
  headSha?: string;
  baseRef?: string;
  network?: GitHubLocalNetworkMode;
}

export interface GitHubPlanResult {
  version: 1;
  generatedBy: "@async/pipeline";
  workflow: string;
  lock: string;
  event: GitHubManifestEvent;
  manifests: GitHubJobManifest[];
  skippedJobs: Array<{
    id: string;
    reason: string;
    trigger: string[];
  }>;
}

export interface GitHubLocalStepReceipt {
  id: string;
  name: string;
  contract: string;
  status: "passed" | "failed" | "planned";
  decision: "mocked" | "simulated" | "allowed" | "denied" | "planned";
  issues: string[];
}

export interface GitHubLocalRunReceipt {
  job: string;
  status: "passed" | "failed" | "planned";
  dryRun: boolean;
  network: GitHubLocalNetworkMode;
  manifestPath?: string;
  stepReceipts: GitHubLocalStepReceipt[];
  artifacts: GitHubJobManifest["artifacts"];
  issues: string[];
}

export interface GitHubLocalRunResult {
  status: "passed" | "failed" | "skipped" | "planned";
  plan: GitHubPlanResult;
  receipts: GitHubLocalRunReceipt[];
}

export async function renderGitHubWorkflow(pipeline: NormalizedPipeline, options: GitHubRenderOptions): Promise<GitHubRenderResult> {
  const workflowPath = options.workflowPath ?? pipeline.sync.github.workflow ?? GITHUB_WORKFLOW_PATH;
  const lockPath = options.lockPath ?? pipeline.sync.github.lock ?? GITHUB_LOCK_PATH;
  const packageInfo = await readPackageInfo(options.cwd);
  const renderModel = buildRenderModel(pipeline, {
    ...packageInfo,
    cwd: options.cwd,
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
    evidence: renderModel.evidence,
    sourceImpact: renderModel.sourceImpact,
    attest: renderModel.attest,
    contract: renderModel.contract,
    hygiene: renderModel.hygiene,
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
    evidence: renderModel.evidence,
    sourceImpact: renderModel.sourceImpact,
    attest: renderModel.attest,
    contract: renderModel.contract,
    hygiene: renderModel.hygiene,
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
  if (result.lockPath === GITHUB_LOCK_PATH) {
    await rm(resolve(cwd, LEGACY_GITHUB_LOCK_PATH), { force: true });
  }
}

export async function checkGitHubWorkflow(result: GitHubRenderResult, cwd: string): Promise<string[]> {
  const issues: string[] = [];
  const workflowFile = resolve(cwd, result.workflowPath);
  const lockFile = resolve(cwd, result.lockPath);
  const legacyLockFile = resolve(cwd, LEGACY_GITHUB_LOCK_PATH);
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
    if (normalizeWorkflowLineEndings(existingWorkflow) !== normalizeWorkflowLineEndings(result.workflow)) {
      issues.push(`Generated workflow ${result.workflowPath} is stale. Run async-pipeline github generate.`);
    }
  }

  const existingLockFile = existsSync(lockFile) ? lockFile : existsSync(legacyLockFile) ? legacyLockFile : undefined;
  if (!existingLockFile) {
    issues.push(`Missing GitHub generation lock ${result.lockPath}. Run async-pipeline github generate.`);
  } else {
    const existingLock = JSON.parse(await readFile(existingLockFile, "utf8")) as GitHubLock;
    if (existingLock.hash !== result.lock.hash || existingLock.workflow !== result.lock.workflow || existingLock.config !== result.lock.config) {
      issues.push(`GitHub generation lock ${existingLockFile === legacyLockFile ? LEGACY_GITHUB_LOCK_PATH : result.lockPath} is stale. Run async-pipeline github generate.`);
    }
  }

  return issues;
}

function normalizeWorkflowLineEndings(workflow: string): string {
  return workflow.replace(/\r\n?/gu, "\n");
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

export async function planGitHubJobs(pipeline: NormalizedPipeline, options: GitHubPlanOptions): Promise<GitHubPlanResult> {
  const rendered = await renderGitHubWorkflow(pipeline, options);
  const packageInfo = await readPackageInfo(options.cwd);
  const model = buildRenderModel(pipeline, {
    ...packageInfo,
    cwd: options.cwd,
    configPath: relativePath(options.cwd, options.configPath),
    workflowPath: rendered.workflowPath
  });
  const event = manifestEventFromOptions(options);
  const network = options.network ?? "mock";
  const candidates = buildManifestCandidates(pipeline, model, rendered, event, network);
  const selected = options.job
    ? candidates.filter((candidate) => candidate.manifest.job.id === options.job)
    : candidates.filter((candidate) => candidate.selected);
  if (options.job && selected.length === 0) {
    throw pipelineError("ASYNC_PIPELINE_GITHUB_PLAN_UNKNOWN_JOB", `Unknown generated GitHub job "${options.job}".`);
  }
  const selectedIds = new Set(selected.map((candidate) => candidate.manifest.job.id));
  return {
    version: 1,
    generatedBy: "@async/pipeline",
    workflow: rendered.workflowPath,
    lock: rendered.lockPath,
    event,
    manifests: selected.map((candidate) => candidate.manifest),
    skippedJobs: candidates
      .filter((candidate) => !selectedIds.has(candidate.manifest.job.id))
      .map((candidate) => ({
        id: candidate.manifest.job.id,
        reason: candidate.skipReason || (options.job ? "job_filter" : "event_filter"),
        trigger: candidate.manifest.job.trigger
      }))
      .sort((left, right) => left.id.localeCompare(right.id))
  };
}

export async function runGitHubLocalPlan(
  pipeline: NormalizedPipeline,
  options: GitHubPlanOptions & { env?: NodeJS.ProcessEnv; dryRun?: boolean }
): Promise<GitHubLocalRunResult> {
  const plan = await planGitHubJobs(pipeline, options);
  if (plan.manifests.length === 0) {
    return { status: "skipped", plan, receipts: [] };
  }
  const receipts: GitHubLocalRunReceipt[] = [];
  for (const manifest of plan.manifests) {
    receipts.push(await runGitHubLocalManifest(manifest, options.cwd, {
      env: options.env ?? process.env,
      dryRun: options.dryRun ?? false
    }));
  }
  const status = options.dryRun
    ? "planned"
    : receipts.some((receipt) => receipt.status === "failed")
      ? "failed"
      : "passed";
  return { status, plan, receipts };
}

export async function runGitHubLocalManifest(
  manifest: GitHubJobManifest,
  cwd: string,
  options: { env?: NodeJS.ProcessEnv; dryRun?: boolean } = {}
): Promise<GitHubLocalRunReceipt> {
  const env = options.env ?? process.env;
  const dryRun = options.dryRun ?? false;
  const stepReceipts: GitHubLocalStepReceipt[] = [];
  const issues: string[] = [];

  for (const step of manifest.steps) {
    const stepIssues = validateLocalStep(manifest, step, env);
    issues.push(...stepIssues.map((issue) => `${step.id}: ${issue}`));
    const blockedByNetwork = step.local.networked && manifest.local.network === "deny";
    const status = dryRun ? "planned" : stepIssues.length > 0 ? "failed" : "passed";
    stepReceipts.push({
      id: step.id,
      name: step.name,
      contract: step.local.contract,
      status,
      decision: dryRun
        ? "planned"
        : blockedByNetwork
          ? "denied"
          : manifest.local.network === "allow" && step.local.networked
            ? "allowed"
            : step.local.mode === "shell"
              ? "simulated"
              : "mocked",
      issues: stepIssues
    });
    if (stepIssues.length > 0 && !dryRun) break;
  }

  const receipt: GitHubLocalRunReceipt = {
    job: manifest.job.id,
    status: dryRun ? "planned" : issues.length > 0 ? "failed" : "passed",
    dryRun,
    network: manifest.local.network,
    artifacts: manifest.artifacts,
    stepReceipts,
    issues
  };

  if (!dryRun) {
    const jobDir = resolve(cwd, manifest.local.stateDirectory);
    await mkdir(join(jobDir, "steps"), { recursive: true });
    await mkdir(join(jobDir, "outputs"), { recursive: true });
    await mkdir(join(jobDir, "artifacts"), { recursive: true });
    await writeFile(join(jobDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    for (const [index, step] of manifest.steps.entries()) {
      await writeFile(join(jobDir, "steps", `${String(index + 1).padStart(2, "0")}-${step.id}.json`), `${JSON.stringify(step, null, 2)}\n`, "utf8");
    }
    for (const artifact of manifest.artifacts) {
      await mkdir(join(jobDir, "artifacts", safeArtifactPart(artifact.name)), { recursive: true });
    }
    receipt.manifestPath = relativePath(cwd, join(jobDir, "manifest.json"));
    await writeFile(join(jobDir, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  }

  return receipt;
}

interface ManifestCandidate {
  manifest: GitHubJobManifest;
  selected: boolean;
  skipReason: string;
}

function manifestEventFromOptions(options: GitHubPlanOptions): GitHubManifestEvent {
  const name = options.eventName ?? "workflow_dispatch";
  const selectedJob = options.selectedJob ?? (name === "workflow_dispatch" ? options.job : undefined);
  return {
    name,
    ...(options.eventAction ? { action: options.eventAction } : {}),
    ref: options.ref ?? (name === "push" ? "refs/heads/main" : undefined),
    sha: options.sha,
    actor: options.actor,
    schedule: options.schedule,
    selectedJob,
    pullRequest: name === "pull_request" || name === "pull_request_target"
      ? {
          number: options.prNumber,
          headRepo: options.headRepo,
          headSha: options.headSha,
          baseRef: options.baseRef
        }
      : undefined
  };
}

function eventContextFromManifestEvent(event: GitHubManifestEvent): GitHubEventContext {
  return {
    eventName: event.name,
    action: event.action,
    ref: event.ref,
    baseRef: event.pullRequest?.baseRef,
    schedule: event.schedule,
    selectedJob: event.selectedJob
  };
}

function buildManifestCandidates(
  pipeline: NormalizedPipeline,
  model: ReturnType<typeof buildRenderModel>,
  rendered: GitHubRenderResult,
  event: GitHubManifestEvent,
  network: GitHubLocalNetworkMode
): ManifestCandidate[] {
  const selectedPipelineJobs = new Set(jobsForGitHubEvent(pipeline, eventContextFromManifestEvent(event)).map((job) => job.id));
  const candidates: ManifestCandidate[] = [];
  for (const job of model.jobs) {
    const selected = selectedPipelineJobs.has(job.id);
    candidates.push({
      manifest: buildPipelineJobManifest(model, rendered, event, job, network),
      selected,
      skipReason: selected ? "" : skipReasonForJob(event, job.trigger)
    });
  }

  for (const generated of buildGeneratedJobManifests(model, rendered, event, network, selectedPipelineJobs)) {
    candidates.push(generated);
  }
  return candidates.sort((left, right) => left.manifest.job.id.localeCompare(right.manifest.job.id));
}

function buildPipelineJobManifest(
  model: ReturnType<typeof buildRenderModel>,
  rendered: GitHubRenderResult,
  event: GitHubManifestEvent,
  job: ReturnType<typeof buildRenderModel>["jobs"][number],
  network: GitHubLocalNetworkMode
): GitHubJobManifest {
  const lifecyclePlan = resolveLifecycleJobPlan(model, job);
  const permissions = manifestJobPermissions(model, job, lifecyclePlan);
  const runnerMatrix = job.github?.runsOnMatrix;
  const steps = [
    checkoutStep(),
    ...setupManifestSteps(model),
    ...dependencyInstallManifestSteps(model),
    ...(model.buildCommand ? [shellManifestStep("build-pipeline-cli", "Build pipeline CLI", model.buildCommand, "build")] : []),
    ...taskCacheManifestSteps(model, { kind: "job", id: job.id }),
    ...(lifecyclePlan ? lifecycleManifestSteps(model, job, lifecyclePlan) : [
      runActionManifestStep(
        "run-pipeline-job",
        "Run pipeline job",
        `${model.command} github check && ${model.command} run ${shellWord(job.id)}${job.execution ? ` --execution ${shellWord(job.execution)}` : ""}`,
        scopeTaskRunEnv(job.env, undefined),
        "run"
      )
    ]),
    ...attestManifestSteps(model, lifecyclePlan, job.requires?.provenance === true),
    ...agentEvidenceManifestSteps(model, job),
    ...taskCacheSaveManifestSteps(model, { kind: "job", id: job.id }),
    ...(job.github?.pages ? [pagesActionManifestStep("upload-pages-artifact", "Upload Pages artifact", job.github.pages)] : []),
    ...evidenceCollectManifestSteps(model)
  ];
  return makeJobManifest(model, rendered, event, {
    id: job.id,
    kind: "pipeline",
    target: job.target,
    runsOn: runnerMatrix && runnerMatrix.length > 0 ? "${{ matrix.runner }}" : job.github?.runsOn ?? "ubuntu-latest",
    matrix: runnerMatrix ? runnerMatrix.map((runner, index) => ({ runner: Array.isArray(runner) ? runner : [runner], index })) : undefined,
    permissions,
    environment: job.environment ?? job.github?.environment ?? null,
    concurrency: null,
    if: job.if ?? null,
    trigger: job.trigger,
    steps,
    network
  });
}

function buildGeneratedJobManifests(
  model: ReturnType<typeof buildRenderModel>,
  rendered: GitHubRenderResult,
  event: GitHubManifestEvent,
  network: GitHubLocalNetworkMode,
  selectedPipelineJobs: Set<string>
): ManifestCandidate[] {
  const candidates: ManifestCandidate[] = [];
  if (model.pages.enabled && model.pages.target) {
    const selected = generatedPagesSelected(model.pages, event);
    candidates.push({
      manifest: buildGeneratedPagesManifest(model, rendered, event, network),
      selected,
      skipReason: selected ? "" : skipReasonForGeneratedJob(event, [model.pages.job])
    });
  }
  if (model.packagePreviews.enabled && model.packagePreviews.target) {
    const selected = event.name === "pull_request";
    candidates.push({
      manifest: buildPackagePreviewManifest(model, rendered, event, network),
      selected,
      skipReason: selected ? "" : "event_filter"
    });
  }
  if (model.bridge.actionsJob.enabled) {
    const selected = bridgeSelected(model.bridge, event);
    candidates.push({
      manifest: buildBridgeManifest(model, rendered, event, network),
      selected,
      skipReason: selected ? "" : "event_filter"
    });
  }
  if (model.contract.enabled) {
    const selected = contractSelected(model.contract, event);
    candidates.push({
      manifest: buildContractManifest(model, rendered, event, network),
      selected,
      skipReason: selected ? "" : skipReasonForGeneratedJob(event, [model.contract.job])
    });
  }
  if (model.hygiene.enabled) {
    const manualIds = hygieneManualJobIds(model);
    const selected = hygieneSelected(model, event);
    candidates.push({
      manifest: buildHygieneManifest(model, rendered, event, network),
      selected,
      skipReason: selected ? "" : skipReasonForGeneratedJob(event, manualIds)
    });
  }
  if (model.dependabotAutoMerge.enabled) {
    const selected = event.name === "pull_request_target";
    candidates.push({
      manifest: buildDependabotManifest(model, rendered, event, network),
      selected,
      skipReason: selected ? "" : "event_filter"
    });
  }
  for (const sourceJob of model.sourceImpactJobs) {
    const selected = selectedPipelineJobs.has(sourceJob.job);
    candidates.push({
      manifest: buildSourceImpactPlanManifest(model, rendered, event, sourceJob, network),
      selected,
      skipReason: selected ? "" : "upstream_job_skipped"
    });
    candidates.push({
      manifest: buildSourceImpactMatrixManifest(model, rendered, event, sourceJob, network),
      selected,
      skipReason: selected ? "" : "upstream_job_skipped"
    });
  }
  if (model.evidence.enabled) {
    const producerIds = new Set(evidenceProducerJobIds(model));
    const selected = candidates.some((candidate) => candidate.selected && producerIds.has(candidate.manifest.job.id))
      || [...selectedPipelineJobs].some((jobId) => producerIds.has(jobId));
    candidates.push({
      manifest: buildEvidenceFanInManifest(model, rendered, event, network),
      selected,
      skipReason: selected ? "" : "no_evidence_producers"
    });
  }
  return candidates;
}

function makeJobManifest(
  model: ReturnType<typeof buildRenderModel>,
  rendered: GitHubRenderResult,
  event: GitHubManifestEvent,
  options: {
    id: string;
    kind: "pipeline" | "generated";
    target: string[];
    runsOn: string | string[];
    matrix?: Array<{ runner: string[]; index: number }>;
    permissions: Record<string, "read" | "write">;
    environment: JobEnvironment | null;
    concurrency: string | null;
    if: string | null;
    trigger: string[];
    steps: GitHubManifestStep[];
    network: GitHubLocalNetworkMode;
  }
): GitHubJobManifest {
  const stateDirectory = `.async/github-local/jobs/${safeArtifactPart(options.id)}`;
  return {
    version: 1,
    generatedBy: "@async/pipeline",
    repo: "${{ github.repository }}",
    workflow: rendered.workflowPath,
    lock: rendered.lockPath,
    event,
    job: {
      id: options.id,
      name: options.id,
      kind: options.kind,
      target: options.target,
      runsOn: options.runsOn,
      ...(options.matrix ? { matrix: options.matrix } : {}),
      permissions: options.permissions,
      environment: options.environment,
      concurrency: options.concurrency,
      if: options.if,
      trigger: options.trigger
    },
    steps: options.steps,
    trust: {
      actionRefsPinned: ACTION_LOCKS.every((action) => /^[0-9a-f]{40}$/iu.test(action.sha)),
      workflow: rendered.workflowPath,
      lock: rendered.lockPath,
      lifecycleFallbackReason: lifecycleFallbackReason(options.steps)
    },
    artifacts: artifactsForSteps(options.id, options.steps, model.evidence.retentionDays, model.evidence.ifNoFilesFound),
    local: {
      workspace: ".",
      stateDirectory,
      network: options.network,
      permissionsMode: "enforced",
      mocks: [
        "setup",
        "run",
        "pages",
        "preview",
        "publish",
        "storage-bridge",
        "release",
        "contract",
        "hygiene",
        "comment",
        "evidence",
        "agent-evidence",
        "source-impact",
        "cache",
        "attest"
      ]
    }
  };
}

function lifecycleFallbackReason(steps: GitHubManifestStep[]): string | null {
  return steps.find((step) => step.local.fallbackReason)?.local.fallbackReason ?? null;
}

function manifestJobPermissions(
  model: ReturnType<typeof buildRenderModel>,
  job: ReturnType<typeof buildRenderModel>["jobs"][number],
  lifecyclePlan: LifecyclePlanItem[] | undefined
): Record<string, "read" | "write"> {
  const grants = job.github?.permissions;
  const idToken = grants?.idToken ?? (job.requires?.provenance || attestRequiresOidc(model, lifecyclePlan) ? "write" as const : undefined);
  const issues = grants?.issues;
  const packages = grants?.packages;
  const pullRequests = grants?.pullRequests;
  const contents = grants?.contents ?? ((idToken || issues || packages || pullRequests) ? "read" : "read");
  return cleanPermissions({
    contents,
    ...(idToken ? { "id-token": idToken } : {}),
    ...(issues ? { issues } : {}),
    ...(packages ? { packages } : {}),
    ...(pullRequests ? { "pull-requests": pullRequests } : {})
  });
}

function cleanPermissions(permissions: Record<string, string | undefined>): Record<string, "read" | "write"> {
  return Object.fromEntries(
    Object.entries(permissions).filter((entry): entry is [string, "read" | "write"] => entry[1] === "read" || entry[1] === "write")
  );
}

function checkoutStep(): GitHubManifestStep {
  return actionManifestStep("checkout", "Checkout", CHECKOUT_ACTION, {}, "checkout");
}

function setupManifestSteps(model: ReturnType<typeof buildRenderModel>): GitHubManifestStep[] {
  const runtime = model.runtime.map((entry) => entry.spec);
  if (model.setup === "async") {
    return [
      actionManifestStep("setup-async-runtimes", "Setup Async runtimes", ASYNC_SETUP_ACTION, {
        "node-version": model.nodeVersion,
        "pnpm-version": pnpmSetupVersion(model.packageManager, model.packageManagerVersion),
        "npm-version": "11.16.0",
        runtime: runtime.length > 1 ? runtime.join("\n") : runtime[0] ?? `node@${model.nodeVersion}`,
        "package-manager": model.packageManager,
        install: model.projectKind === "package",
        "frozen-lockfile": true,
        cache: model.dependencyCache,
        ...(model.dependencyCachePath ? { "dependency-cache-path": model.dependencyCachePath } : {})
      }, "setup")
    ];
  }
  const steps = [actionManifestStep("setup-node", "Setup Node", SETUP_NODE_ACTION, { "node-version": model.nodeVersion }, "setup")];
  if (model.projectKind === "deno") {
    steps.push(actionManifestStep("setup-deno", "Setup Deno", DENO_SETUP_ACTION, { "deno-version": `v${DEFAULT_DENO_VERSION}.x` }, "setup"));
  }
  return steps;
}

function dependencyInstallManifestSteps(model: ReturnType<typeof buildRenderModel>): GitHubManifestStep[] {
  if (model.setup === "async") return [];
  return renderDependencyInstallSteps(model).map((_, index) => {
    const command = model.projectKind === "deno"
      ? `deno install --frozen=${model.dependencyCachePath ? "true" : "false"}`
      : `${model.packageManager} install --frozen-lockfile`;
    return shellManifestStep(`install-dependencies-${index}`, "Install dependencies", command, "setup");
  });
}

function taskCacheManifestSteps(model: ReturnType<typeof buildRenderModel>, target: TaskCacheTarget): GitHubManifestStep[] {
  if (!model.taskCache) return [];
  const manifestPath = target.manifestPath ?? `.async/actions/cache/${safeArtifactPart(target.id)}-cache-manifest.json`;
  return [
    shellManifestStep("write-task-cache-manifest", "Write task cache manifest", renderCacheManifestCommand(model, target, manifestPath, "read-only"), "cache"),
    actionManifestStep("restore-async-task-cache", "Restore Async task cache", ASYNC_CACHE_ACTION, {
      mode: "restore",
      manifest: manifestPath,
      trust: "read-only"
    }, "cache")
  ];
}

function taskCacheSaveManifestSteps(model: ReturnType<typeof buildRenderModel>, target: TaskCacheTarget): GitHubManifestStep[] {
  if (!model.taskCache) return [];
  const manifestPath = target.manifestPath ?? `.async/actions/cache/${safeArtifactPart(target.id)}-cache-manifest.json`;
  return [
    actionManifestStep("save-async-task-cache", "Save Async task cache", ASYNC_CACHE_ACTION, {
      mode: "save",
      manifest: manifestPath,
      trust: "read-write"
    }, "cache", { if: "${{ success() && github.event_name != 'pull_request' && steps.async-cache-restore.outputs.cache-hit != 'true' }}" })
  ];
}

function lifecycleManifestSteps(
  model: ReturnType<typeof buildRenderModel>,
  job: ReturnType<typeof buildRenderModel>["jobs"][number],
  plan: LifecyclePlanItem[]
): GitHubManifestStep[] {
  const steps: GitHubManifestStep[] = [];
  const releaseEvidenceTasks = leadingRunTasks(plan);
  for (const item of releaseEvidenceTasks) {
    steps.push(runActionManifestStep(
      `run-pipeline-task-${safeArtifactPart(item.taskId)}`,
      `Run pipeline task ${item.taskId}`,
      `${model.command} github check && ${model.command} run-task ${shellWord(item.taskId)}`,
      scopeTaskRunEnv(job.env, model.tasks[item.taskId]),
      "run",
      { "artifact-name": `async-pipeline-\${{ github.job }}-${safeArtifactPart(item.taskId)}-runs` }
    ));
  }
  if (hasReleaseLifecycle(plan)) {
    const packagePath = lifecyclePackagePath(plan) ?? ".";
    steps.push(
      releaseDoctorManifestStep("plan-release-package", "Plan release package", "plan", packagePath),
      releaseDoctorManifestStep("inspect-release-package", "Inspect release package", "inspect", packagePath),
      releaseDoctorManifestStep("check-release-changelog", "Check release changelog", "changelog", packagePath),
      releaseDoctorManifestStep("render-release-notes", "Render release notes", "notes", packagePath)
    );
  }
  for (const item of plan.slice(releaseEvidenceTasks.length)) {
    if (item.kind === "run-task") {
      steps.push(runActionManifestStep(
        `run-pipeline-task-${safeArtifactPart(item.taskId)}`,
        `Run pipeline task ${item.taskId}`,
        `${model.command} github check && ${model.command} run-task ${shellWord(item.taskId)}`,
        scopeTaskRunEnv(job.env, model.tasks[item.taskId]),
        "run",
        { "artifact-name": `async-pipeline-\${{ github.job }}-${safeArtifactPart(item.taskId)}-runs` }
      ));
      continue;
    }
    if (item.kind === "preview") {
      steps.push(...previewEvidenceManifestSteps(item, "before-publish"));
      steps.push(previewManifestStep(item));
      steps.push(previewDoctorManifestStep(item));
      if (item.mode === "pr" && item.comment) steps.push(commentManifestStep("comment-package-preview", "Comment package preview"));
      continue;
    }
    if (item.kind === "release") {
      steps.push(releaseDoctorManifestStep("run-release-doctor", "Run release doctor", "doctor", item.packagePath, true));
      continue;
    }
    steps.push(publishManifestStep(item, job.requires?.provenance === true));
  }
  return steps;
}

function attestManifestSteps(
  model: ReturnType<typeof buildRenderModel>,
  lifecyclePlan: LifecyclePlanItem[] | undefined,
  provenance: boolean
): GitHubManifestStep[] {
  if (!model.attest.enabled || !hasReleaseLifecycle(lifecyclePlan)) return [];
  const packagePath = model.attest.packagePath ?? lifecyclePackagePath(lifecyclePlan) ?? ".";
  const steps = [
    actionManifestStep("create-attestation-subject-manifest", "Create attestation subject manifest", ASYNC_ATTEST_ACTION, {
      mode: "digest",
      "package-path": packagePath,
      "subject-manifest": model.attest.subjectManifest,
      "sbom-path": model.attest.sbomPath,
      "require-npm-provenance": model.attest.requireNpmProvenance,
      "tarball-scan": model.attest.tarballScan
    }, "attest"),
    actionManifestStep("write-attestation-sbom-evidence", "Write attestation SBOM evidence", ASYNC_ATTEST_ACTION, {
      mode: "sbom",
      "package-path": packagePath,
      "subject-manifest": model.attest.subjectManifest,
      "sbom-path": model.attest.sbomPath
    }, "attest")
  ];
  if (model.attest.githubAttestation || provenance) {
    steps.push(actionManifestStep("record-github-attestation-intent", "Record GitHub attestation intent", ASYNC_ATTEST_ACTION, {
      mode: "attest",
      "package-path": packagePath,
      "subject-manifest": model.attest.subjectManifest,
      "github-attestation": true
    }, "attest", { permissions: { "id-token": "write" }, networked: true, dangerous: true }));
  }
  return steps;
}

function agentEvidenceManifestSteps(model: ReturnType<typeof buildRenderModel>, job: ReturnType<typeof buildRenderModel>["jobs"][number]): GitHubManifestStep[] {
  const evidence = agentEvidenceForTargets(model.tasks, job.target);
  if (!evidence.hasAgentStep) return [];
  const canComment = job.github?.permissions?.issues === "write" || job.github?.permissions?.pullRequests === "write";
  const steps = [
    actionManifestStep("bundle-agent-evidence", "Bundle agent evidence", ASYNC_AGENT_EVIDENCE_ACTION, {
      mode: canComment ? "comment" : "bundle",
      "run-directory": ".async/runs",
      outputs: evidence.outputs,
      "evidence-path": ".async/actions/agent-evidence/${{ github.job }}/manifest.json",
      "bundle-path": ".async/actions/agent-evidence/${{ github.job }}/bundle.json",
      "receipt-path": ".async/actions/receipts/${{ github.job }}-agent-evidence.json",
      comment: canComment,
      "comment-marker": "async-agent-evidence-${{ github.job }}"
    }, "agent-evidence")
  ];
  if (canComment) {
    steps.push(commentManifestStep("comment-agent-evidence", "Comment agent evidence"));
  }
  return steps;
}

function evidenceCollectManifestSteps(model: ReturnType<typeof buildRenderModel>, options: { extraPaths?: string[] } = {}): GitHubManifestStep[] {
  if (!model.evidence.enabled) return [];
  const paths = [...new Set([...model.evidence.paths, ...(options.extraPaths ?? [])])];
  return [
    actionManifestStep("collect-evidence-manifest", "Collect evidence manifest", ASYNC_EVIDENCE_ACTION, {
      mode: "collect",
      paths,
      "receipt-paths": model.evidence.receiptPaths,
      "manifest-path": ".async/evidence/${{ github.job }}/manifest.json",
      "summary-path": ".async/evidence/${{ github.job }}/summary.md",
      "artifact-name": `${model.evidence.artifactNamePrefix}-\${{ github.job }}`,
      "retention-days": model.evidence.retentionDays,
      "if-no-files-found": model.evidence.ifNoFilesFound,
      "include-summary": model.evidence.includeSummary
    }, "evidence", { if: "${{ always() }}" })
  ];
}

function contractActionInput(contract: NormalizedGitHubContractConfig): Record<string, unknown> {
  return sortObject({
    mode: contract.mode,
    checks: contractChecks(contract).join(","),
    "package-path": contract.packagePath,
    ...(contract.schema.enabled
      ? {
          "schema-sources": contract.schema.sources.join("\n"),
          "schema-output": contract.schema.output
        }
      : {}),
    "evidence-dir": contract.evidenceDir,
    annotations: contract.annotations,
    "fail-on": contract.mode === "report" ? "advisory" : "blocking"
  });
}

function contractChecks(contract: NormalizedGitHubContractConfig): string[] {
  const checks: string[] = [];
  if (contract.api) checks.push("api");
  if (contract.claims) checks.push("claims");
  if (contract.schema.enabled) checks.push("schema");
  return checks;
}

function hygieneActionInput(hygiene: NormalizedGitHubHygieneConfig): Record<string, unknown> {
  return sortObject({
    mode: hygiene.mode,
    profiles: hygiene.profiles.join(","),
    "package-path": hygiene.packagePath,
    "evidence-dir": hygiene.evidenceDir,
    annotations: hygiene.annotations,
    "fail-on": hygiene.mode === "report" ? "generated-policy" : "blocking",
    "release-gate": hygiene.releaseGate
  });
}

function runActionManifestStep(
  id: string,
  name: string,
  command: string,
  env: Record<string, EnvValue>,
  contract: string,
  extraWith: Record<string, unknown> = {}
): GitHubManifestStep {
  const networked = commandLooksNetworked(command);
  return actionManifestStep(id, name, ASYNC_RUN_ACTION, {
    command,
    "check-generated": false,
    "artifact-name": "async-pipeline-${{ github.job }}-runs",
    ...extraWith
  }, contract, { env: manifestEnv(env), secrets: secretNamesFromEnv(env), networked, dangerous: networked });
}

function releaseDoctorManifestStep(id: string, name: string, mode: string, packagePath: string, live = false): GitHubManifestStep {
  return actionManifestStep(id, name, ASYNC_DOCTOR_ACTION, {
    mode,
    "package-path": packagePath,
    "evidence-dir": ".async/release",
    "release-command": ASYNC_RELEASE_COMMAND,
    ...(mode === "doctor" ? { network: live ? "live" : "mock" } : {})
  }, "release", { networked: live, dangerous: live, secrets: live ? ["GITHUB_TOKEN"] : [] });
}

function previewManifestStep(preview: Extract<LifecyclePlanItem, { kind: "preview" }>): GitHubManifestStep {
  return actionManifestStep(previewPublishStepId(preview), `Publish ${preview.mode === "main" ? "main" : "PR"} package preview`, ASYNC_PREVIEW_ACTION, {
    "package-path": preview.packagePath,
    "target-registry": preview.registry,
    ...(preview.namespace ? { namespace: preview.namespace } : {}),
    mode: preview.mode,
    comment: preview.comment,
    "token-env-name": preview.tokenEnv,
    "release-package": ASYNC_RELEASE_PACKAGE
  }, "preview", { permissions: { packages: "write" }, secrets: [preview.tokenEnv], networked: true, dangerous: true });
}

function previewEvidenceManifestSteps(preview: Extract<LifecyclePlanItem, { kind: "preview" }>, phase: "before-publish"): GitHubManifestStep[] {
  return [
    shellManifestStep(
      `plan-${preview.mode}-package-preview-${preview.packagePath}`,
      `Plan ${preview.mode === "main" ? "main" : "PR"} package preview`,
      previewEvidenceCommand("plan", preview),
      "preview"
    ),
    shellManifestStep(
      `stage-${preview.mode}-package-preview-${preview.packagePath}`,
      `Stage ${preview.mode === "main" ? "main" : "PR"} package preview`,
      previewEvidenceCommand("stage", preview),
      "preview"
    ),
    shellManifestStep(
      `inspect-${preview.mode}-package-preview-${preview.packagePath}`,
      `Inspect ${preview.mode === "main" ? "main" : "PR"} package preview`,
      previewEvidenceCommand("inspect", preview),
      "preview"
    )
  ].map((step) => ({
    ...step,
    id: `${step.id}-${phase}`,
    local: {
      ...step.local,
      networked: true,
      dangerous: false,
      mockReason: "released @async/release package source is fetched by pnpm dlx unless the package is already cached"
    }
  }));
}

function previewDoctorManifestStep(preview: Extract<LifecyclePlanItem, { kind: "preview" }>): GitHubManifestStep {
  return {
    ...shellManifestStep(
      `doctor-${preview.mode}-package-preview`,
      `Verify ${preview.mode === "main" ? "main" : "PR"} package preview`,
      previewEvidenceCommand("doctor", preview, { network: "live" }),
      "preview"
    ),
    if: previewDoctorCondition(preview),
    secrets: [preview.tokenEnv],
    permissions: { packages: "write" },
    local: {
      contract: "preview",
      mode: "shell",
      network: "mock",
      networked: true,
      dangerous: false,
      mockReason: "preview doctor reads the package registry in live workflows"
    }
  };
}

function previewEvidenceCommand(
  command: "plan" | "stage" | "inspect" | "doctor",
  preview: Extract<LifecyclePlanItem, { kind: "preview" }>,
  options: { network?: "live" | "mock" } = {}
): string {
  const args = [
    ASYNC_RELEASE_COMMAND,
    "preview",
    command,
    "--package",
    shellWord(preview.packagePath),
    "--mode",
    preview.mode,
    "--namespace",
    shellWord(preview.namespace ?? "${{ github.repository_owner }}"),
    "--source-repository",
    "\"${{ github.repository }}\"",
    "--source-sha",
    "\"${{ github.sha }}\"",
    "--evidence-dir",
    ".async/release",
    "--json"
  ];
  if (command === "stage") {
    args.push("--registry", shellWord(preview.registry));
  }
  if (command === "doctor") {
    args.push("--registry", shellWord(preview.registry), "--network", options.network ?? "mock");
  }
  if (preview.mode === "pr") {
    args.push(
      "--pr-number",
      "\"${{ github.event.pull_request.number }}\"",
      "--head-sha",
      "\"${{ github.event.pull_request.head.sha }}\""
    );
  }
  if (preview.mode === "pr" && !preview.comment) {
    args.push("--no-comment");
  }
  return args.join(" ");
}

function previewPublishStepId(preview: Extract<LifecyclePlanItem, { kind: "preview" }>): string {
  return safeGeneratedJobId(`async-${preview.mode}-package-preview-${preview.packagePath}`);
}

function previewDoctorCondition(preview: Extract<LifecyclePlanItem, { kind: "preview" }>, stepId = previewPublishStepId(preview)): string {
  if (preview.mode === "pr") {
    return `github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository && steps.${stepId}.outputs.package-spec != ''`;
  }
  return `steps.${stepId}.outputs.package-spec != ''`;
}

function publishManifestStep(publish: Extract<LifecyclePlanItem, { kind: "publish" }>, provenance: boolean): GitHubManifestStep {
  const name = publish.mode === "github-release"
    ? "Create or update GitHub Release"
    : publish.mode === "github-packages"
      ? "Publish GitHub Packages mirror"
      : "Publish npm package";
  return actionManifestStep(`publish-${publish.mode}`, name, ASYNC_PUBLISH_ACTION, {
    "package-path": publish.packagePath,
    mode: publish.mode,
    registry: publish.registry,
    "dist-tag": publish.distTag,
    ...(publish.mode === "npm" ? { "token-env-name": "NODE_AUTH_TOKEN", provenance } : {}),
    ...(publish.mode === "github-packages" ? { "token-env-name": "GITHUB_TOKEN" } : {}),
    ...(publish.mode === "github-release" ? { "notes-file": ".async/release/release-notes.md" } : {})
  }, "publish", {
    permissions: {
      ...(publish.mode === "github-packages" || publish.mode === "github-release" ? { packages: "write", contents: "write" } : {}),
      ...(provenance ? { "id-token": "write" } : {})
    },
    secrets: publish.mode === "npm" ? ["NODE_AUTH_TOKEN"] : ["GITHUB_TOKEN"],
    networked: true,
    dangerous: true
  });
}

function commentManifestStep(id: string, name: string): GitHubManifestStep {
  return actionManifestStep(id, name, ASYNC_COMMENT_ACTION, {
    mode: "pr-comment",
    repository: "${{ github.repository }}",
    number: "${{ github.event.pull_request.number }}",
    marker: "${{ steps.source.outputs.comment-marker }}",
    body: "${{ steps.source.outputs.comment-body }}"
  }, "comment", { permissions: { issues: "write" }, secrets: ["GITHUB_TOKEN"], networked: true });
}

function pagesActionManifestStep(id: string, name: string, pages: GitHubPagesConfig): GitHubManifestStep {
  return actionManifestStep(id, name, ASYNC_PAGES_ACTION, {
    mode: pages.build.kind,
    ...(pages.build.kind === "jekyll" ? { source: pages.build.source, destination: pages.build.destination ?? "./_site" } : {}),
    ...(pages.build.kind === "static" ? { path: pages.build.path } : {}),
    ...(pages.build.kind === "prerender" ? { path: pages.build.path, "validate-index": pages.build.validateIndex ?? true, "spa-fallback": pages.build.spaFallback ?? false } : {})
  }, "pages", { permissions: { pages: "write", "id-token": "write" } });
}

function actionManifestStep(
  id: string,
  name: string,
  ref: string,
  input: Record<string, unknown>,
  contract: string,
  options: {
    if?: string;
    env?: Record<string, string>;
    permissions?: Record<string, "read" | "write">;
    secrets?: string[];
    networked?: boolean;
    dangerous?: boolean;
    fallbackReason?: string;
  } = {}
): GitHubManifestStep {
  const action = actionFromRef(ref);
  return {
    id: safeGeneratedJobId(id),
    name,
    uses: `${action.uses}@${action.sha}`,
    label: action.label,
    ...(options.if ? { if: options.if } : {}),
    with: sortObject(input),
    ...(options.env && Object.keys(options.env).length > 0 ? { env: options.env } : {}),
    permissions: options.permissions ?? {},
    secrets: [...new Set(options.secrets ?? [])].sort(),
    local: {
      contract,
      mode: "action",
      network: options.networked ? "mock" : "mock",
      networked: options.networked ?? false,
      dangerous: options.dangerous ?? false,
      ...(options.networked ? { mockReason: "networked action is mocked unless --network allow is selected" } : {}),
      ...(options.fallbackReason ? { fallbackReason: options.fallbackReason } : {})
    }
  };
}

function shellManifestStep(id: string, name: string, command: string, contract: string): GitHubManifestStep {
  return {
    id: safeGeneratedJobId(id),
    name,
    run: command,
    secrets: [],
    permissions: {},
    local: {
      contract,
      mode: "shell",
      network: "mock",
      networked: commandLooksNetworked(command),
      dangerous: commandLooksDangerous(command),
      ...(commandLooksNetworked(command) ? { mockReason: "networked shell command is simulated unless --network allow is selected" } : {})
    }
  };
}

function actionFromRef(ref: string): GitHubActionRef {
  const found = GENERATED_ACTIONS.find((action) => action.ref === ref);
  if (found) return found;
  const [usesPart, rest] = ref.split("@");
  const sha = rest?.split(/\s+/u)[0] ?? "";
  return { id: usesPart ?? ref, uses: usesPart ?? ref, sha, label: "", ref };
}

function manifestEnv(env: Record<string, EnvValue>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env)
      .map(([name, value]) => [name, renderGitHubEnvValue(value)] as const)
      .filter((entry): entry is readonly [string, string] => typeof entry[1] === "string")
      .sort(([left], [right]) => left.localeCompare(right))
  );
}

function secretNamesFromEnv(env: Record<string, EnvValue>): string[] {
  const names = new Set<string>();
  for (const [envName, value] of Object.entries(env)) {
    if (isSecretEnvValue(value)) {
      names.add(typeof value === "object" && value !== null && "name" in value && typeof value.name === "string" ? value.name : envName);
    }
  }
  return [...names].sort();
}

function artifactsForSteps(
  jobId: string,
  steps: GitHubManifestStep[],
  retentionDays: number,
  ifNoFilesFound: string
): GitHubJobManifest["artifacts"] {
  const artifacts: GitHubJobManifest["artifacts"] = [];
  for (const step of steps) {
    const artifactName = typeof step.with?.["artifact-name"] === "string" ? step.with["artifact-name"] : undefined;
    if (artifactName) {
      artifacts.push({
        name: artifactName,
        path: artifactPathForContract(step.local.contract),
        mode: step.local.contract === "evidence" ? "upload" : "local",
        producerJob: jobId,
        retentionDays,
        ifNoFilesFound
      });
    }
  }
  return artifacts.sort((left, right) => left.name.localeCompare(right.name));
}

function artifactPathForContract(contract: string): string {
  if (contract === "evidence") return ".async/evidence";
  if (contract === "agent-evidence") return ".async/actions/agent-evidence";
  if (contract === "contract") return ".async/contract";
  if (contract === "hygiene") return ".async/hygiene";
  if (contract === "pages") return ".async/pages";
  return ".async/runs";
}

function buildGeneratedPagesManifest(
  model: ReturnType<typeof buildRenderModel>,
  rendered: GitHubRenderResult,
  event: GitHubManifestEvent,
  network: GitHubLocalNetworkMode
): GitHubJobManifest {
  const pages = model.pages;
  const steps = [
    checkoutStep(),
    ...setupManifestSteps(model),
    ...dependencyInstallManifestSteps(model),
    ...(model.buildCommand ? [shellManifestStep("build-pipeline-cli", "Build pipeline CLI", model.buildCommand, "build")] : []),
    ...taskCacheManifestSteps(model, { kind: "task", id: pages.target ?? "docs.site" }),
    runActionManifestStep("run-pages-target", "Run Pages target", `${model.command} github check && ${model.command} run-task ${shellWord(pages.target ?? "docs.site")}`, {}, "run"),
    ...taskCacheSaveManifestSteps(model, { kind: "task", id: pages.target ?? "docs.site" }),
    pagesActionManifestStep("upload-pages-artifact", "Upload Pages artifact", pages),
    ...evidenceCollectManifestSteps(model)
  ];
  return makeJobManifest(model, rendered, event, {
    id: pages.job,
    kind: "generated",
    target: pages.target ? [pages.target] : [],
    runsOn: "ubuntu-latest",
    permissions: { contents: "read", pages: "write", "id-token": "write" },
    environment: pages.environment ?? null,
    concurrency: null,
    if: renderGeneratedPagesCondition(pages),
    trigger: ["pull_request", "push", "workflow_dispatch"],
    steps,
    network
  });
}

function buildPackagePreviewManifest(
  model: ReturnType<typeof buildRenderModel>,
  rendered: GitHubRenderResult,
  event: GitHubManifestEvent,
  network: GitHubLocalNetworkMode
): GitHubJobManifest {
  const preview = model.packagePreviews;
  const previewItem: Extract<LifecyclePlanItem, { kind: "preview" }> = {
    kind: "preview",
    mode: "pr",
    packagePath: preview.package ?? ".",
    registry: preview.registry,
    namespace: preview.namespace,
    comment: preview.comment,
    tokenEnv: preview.tokenEnv
  };
  const steps = [
    checkoutStep(),
    ...setupManifestSteps(model),
    ...dependencyInstallManifestSteps(model),
    ...(model.buildCommand ? [shellManifestStep("build-pipeline-cli", "Build pipeline CLI", model.buildCommand, "build")] : []),
    ...taskCacheManifestSteps(model, { kind: "task", id: preview.target ?? "pack", manifestPath: ".async/actions/cache/package-preview-cache-manifest.json" }),
    runActionManifestStep("run-package-preview-target", "Run package preview target", `${model.command} github check && ${model.command} run-task ${shellWord(preview.target ?? "pack")}`, {}, "run"),
    ...taskCacheSaveManifestSteps(model, { kind: "task", id: preview.target ?? "pack", manifestPath: ".async/actions/cache/package-preview-cache-manifest.json" }),
    ...previewEvidenceManifestSteps(previewItem, "before-publish"),
    actionManifestStep("publish-package-preview", "Publish package preview", ASYNC_PREVIEW_ACTION, {
      "package-path": preview.package ?? ".",
      "target-registry": preview.registry,
      ...(preview.namespace ? { namespace: preview.namespace } : {}),
      mode: "pr",
      comment: preview.comment,
      "token-env-name": preview.tokenEnv,
      "release-package": ASYNC_RELEASE_PACKAGE
    }, "preview", { permissions: { packages: "write" }, secrets: [preview.tokenEnv], networked: true, dangerous: true }),
    previewDoctorManifestStep(previewItem),
    ...(preview.comment ? [commentManifestStep("comment-package-preview", "Comment package preview")] : []),
    ...evidenceCollectManifestSteps(model, { extraPaths: [".async/release"] })
  ];
  return makeJobManifest(model, rendered, event, {
    id: "package-preview",
    kind: "generated",
    target: preview.target ? [preview.target] : [],
    runsOn: "ubuntu-latest",
    permissions: { contents: "read", issues: "write", packages: "write", "pull-requests": "write" },
    environment: null,
    concurrency: null,
    if: "github.event_name == 'pull_request' && github.event.pull_request.draft == false",
    trigger: ["pull_request"],
    steps,
    network
  });
}

function buildBridgeManifest(
  model: ReturnType<typeof buildRenderModel>,
  rendered: GitHubRenderResult,
  event: GitHubManifestEvent,
  network: GitHubLocalNetworkMode
): GitHubJobManifest {
  const bridge = model.bridge;
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
  const steps = [
    checkoutStep(),
    ...setupManifestSteps(model),
    ...dependencyInstallManifestSteps(model),
    ...(model.buildCommand ? [shellManifestStep("build-pipeline-cli", "Build pipeline CLI", model.buildCommand, "build")] : []),
    runActionManifestStep("check-generated-workflow", "Check generated workflow", `${model.command} github check`, {}, "run"),
    runActionManifestStep("pull-and-apply-async-bridge-change-sets", "Pull and apply Async bridge change sets", command, {
      ASYNC_PROJECT_URL: { kind: "async-pipeline.env.var", name: bridge.endpointVar } as EnvValue,
      ASYNC_PROJECT_TOKEN: { kind: "async-pipeline.env.secret", name: bridge.tokenEnv } as EnvValue,
      GITHUB_TOKEN: { kind: "async-pipeline.env.secret", name: "GITHUB_TOKEN" } as EnvValue
    }, "storage-bridge"),
    ...evidenceCollectManifestSteps(model)
  ];
  return makeJobManifest(model, rendered, event, {
    id: bridge.job,
    kind: "generated",
    target: [],
    runsOn: "ubuntu-latest",
    permissions: { contents: "write", "pull-requests": "write" },
    environment: null,
    concurrency: "async-bridge-${{ github.repository }}",
    if: renderBridgeCondition(bridge),
    trigger: ["schedule", "workflow_dispatch"],
    steps,
    network
  });
}

function buildContractManifest(
  model: ReturnType<typeof buildRenderModel>,
  rendered: GitHubRenderResult,
  event: GitHubManifestEvent,
  network: GitHubLocalNetworkMode
): GitHubJobManifest {
  const contract = model.contract;
  const steps = [
    checkoutStep(),
    ...setupManifestSteps(model),
    ...dependencyInstallManifestSteps(model),
    ...(model.buildCommand ? [shellManifestStep("build-pipeline-cli", "Build pipeline CLI", model.buildCommand, "build")] : []),
    actionManifestStep("run-contract-evidence", "Run contract evidence", ASYNC_CONTRACT_ACTION, contractActionInput(contract), "contract"),
    ...evidenceCollectManifestSteps(model, { extraPaths: [contract.evidenceDir] })
  ];
  return makeJobManifest(model, rendered, event, {
    id: contract.job,
    kind: "generated",
    target: [],
    runsOn: "ubuntu-latest",
    permissions: { contents: "read" },
    environment: null,
    concurrency: null,
    if: renderContractCondition(contract),
    trigger: contract.mode === "release" ? ["release", "workflow_dispatch"] : ["pull_request", "workflow_dispatch"],
    steps,
    network
  });
}

function buildHygieneManifest(
  model: ReturnType<typeof buildRenderModel>,
  rendered: GitHubRenderResult,
  event: GitHubManifestEvent,
  network: GitHubLocalNetworkMode
): GitHubJobManifest {
  const hygiene = model.hygiene;
  const steps = [
    checkoutStep(),
    ...setupManifestSteps(model),
    ...dependencyInstallManifestSteps(model),
    ...(model.buildCommand ? [shellManifestStep("build-pipeline-cli", "Build pipeline CLI", model.buildCommand, "build")] : []),
    actionManifestStep("run-hygiene-evidence", "Run hygiene evidence", ASYNC_HYGIENE_ACTION, hygieneActionInput(hygiene), "hygiene"),
    ...evidenceCollectManifestSteps(model, { extraPaths: [hygiene.evidenceDir] })
  ];
  return makeJobManifest(model, rendered, event, {
    id: hygiene.job,
    kind: "generated",
    target: [],
    runsOn: "ubuntu-latest",
    permissions: { contents: "read" },
    environment: null,
    concurrency: null,
    if: renderHygieneCondition(model),
    trigger: hygieneTriggers(hygiene),
    steps,
    network
  });
}

function buildEvidenceFanInManifest(
  model: ReturnType<typeof buildRenderModel>,
  rendered: GitHubRenderResult,
  event: GitHubManifestEvent,
  network: GitHubLocalNetworkMode
): GitHubJobManifest {
  return makeJobManifest(model, rendered, event, {
    id: model.evidence.job,
    kind: "generated",
    target: [],
    runsOn: "ubuntu-latest",
    permissions: { contents: "read" },
    environment: null,
    concurrency: null,
    if: "always()",
    trigger: ["fan-in"],
    steps: [
      actionManifestStep("merge-evidence-manifests", "Merge evidence manifests", ASYNC_EVIDENCE_ACTION, {
        mode: "merge",
        "artifact-pattern": `${model.evidence.artifactNamePrefix}-*`,
        "manifest-path": ".async/evidence/index.json",
        "summary-path": ".async/evidence/index.md",
        "artifact-name": `${model.evidence.artifactNamePrefix}-index`,
        "retention-days": model.evidence.retentionDays,
        "if-no-files-found": model.evidence.ifNoFilesFound,
        "include-summary": model.evidence.includeSummary
      }, "evidence")
    ],
    network
  });
}

function buildDependabotManifest(
  model: ReturnType<typeof buildRenderModel>,
  rendered: GitHubRenderResult,
  event: GitHubManifestEvent,
  network: GitHubLocalNetworkMode
): GitHubJobManifest {
  return makeJobManifest(model, rendered, event, {
    id: "dependabot-auto-merge",
    kind: "generated",
    target: [],
    runsOn: "ubuntu-latest",
    permissions: { contents: "write", "pull-requests": "write" },
    environment: null,
    concurrency: null,
    if: "github.event.pull_request.user.login == 'dependabot[bot]' && github.event.pull_request.draft == false",
    trigger: ["pull_request_target"],
    steps: [
      actionManifestStep("fetch-dependabot-metadata", "Fetch Dependabot metadata", DEPENDABOT_FETCH_METADATA_ACTION, { "github-token": "${{ secrets.GITHUB_TOKEN }}" }, "dependabot", { secrets: ["GITHUB_TOKEN"], networked: true }),
      actionManifestStep("merge-validated-dependabot-pr", "Merge validated Dependabot PR", ASYNC_DEPENDABOT_MERGE_ACTION, { "allowed-ecosystems": model.dependabotAutoMerge.ecosystems }, "dependabot", { permissions: { contents: "write", "pull-requests": "write" }, secrets: ["GITHUB_TOKEN"], networked: true, dangerous: true })
    ],
    network
  });
}

function buildSourceImpactPlanManifest(
  model: ReturnType<typeof buildRenderModel>,
  rendered: GitHubRenderResult,
  event: GitHubManifestEvent,
  sourceJob: SourceImpactRenderJob,
  network: GitHubLocalNetworkMode
): GitHubJobManifest {
  return makeJobManifest(model, rendered, event, {
    id: sourceJob.planJob,
    kind: "generated",
    target: [],
    runsOn: sourceJob.github?.runsOn ?? "ubuntu-latest",
    permissions: { contents: "read" },
    environment: null,
    concurrency: null,
    if: sourceJob.if ?? null,
    trigger: ["source-impact"],
    steps: [
      checkoutStep(),
      ...setupManifestSteps(model),
      shellManifestStep("write-generated-source-plan", "Write generated source plan", `write ${sourceJob.planPath}`, "source-impact"),
      actionManifestStep("plan-source-impact-matrix", "Plan source impact matrix", ASYNC_SOURCE_IMPACT_ACTION, {
        mode: "matrix",
        "plan-path": sourceJob.planPath,
        "matrix-path": `.async/actions/source-impact/${safeArtifactPart(sourceJob.job)}-matrix.json`
      }, "source-impact")
    ],
    network
  });
}

function buildSourceImpactMatrixManifest(
  model: ReturnType<typeof buildRenderModel>,
  rendered: GitHubRenderResult,
  event: GitHubManifestEvent,
  sourceJob: SourceImpactRenderJob,
  network: GitHubLocalNetworkMode
): GitHubJobManifest {
  return makeJobManifest(model, rendered, event, {
    id: sourceJob.matrixJob,
    kind: "generated",
    target: [sourceJob.job],
    runsOn: sourceJob.github?.runsOn ?? "ubuntu-latest",
    matrix: sourceJob.plan.matrix.include.map((entry, index) => ({ runner: [String(entry.source)], index })),
    permissions: { contents: "read" },
    environment: null,
    concurrency: null,
    if: sourceJob.if ?? null,
    trigger: ["source-impact"],
    steps: [
      checkoutStep(),
      ...setupManifestSteps(model),
      actionManifestStep("validate-source-impact-row", "Validate source impact row", ASYNC_SOURCE_IMPACT_ACTION, {
        mode: "validate",
        source: "${{ matrix.source }}"
      }, "source-impact"),
      runActionManifestStep("run-source-impact-task", "Run source impact task", `${model.command} github check && ${model.command} run-task ${shellWord(sourceJob.job)}`, sourceJob.env, "run"),
      ...evidenceCollectManifestSteps(model)
    ],
    network
  });
}

function generatedPagesSelected(pages: ReturnType<typeof buildRenderModel>["pages"], event: GitHubManifestEvent): boolean {
  if (event.name === "pull_request") return pages.triggers.pullRequest;
  if (event.name === "push") return Boolean(pages.triggers.main);
  return event.name === "workflow_dispatch" && event.selectedJob === pages.job;
}

function bridgeSelected(bridge: ReturnType<typeof buildRenderModel>["bridge"], event: GitHubManifestEvent): boolean {
  if (event.name === "schedule") return Boolean(bridge.schedule && (!event.schedule || event.schedule === bridge.schedule));
  return event.name === "workflow_dispatch" && event.selectedJob === bridge.job;
}

function contractSelected(contract: NormalizedGitHubContractConfig, event: GitHubManifestEvent): boolean {
  if (event.name === "workflow_dispatch") return event.selectedJob === contract.job;
  if (contract.mode === "release") {
    return event.name === "release" && (!event.action || event.action === "published");
  }
  return event.name === "pull_request";
}

function hygieneSelected(model: ReturnType<typeof buildRenderModel>, event: GitHubManifestEvent): boolean {
  const hygiene = model.hygiene;
  if (event.name === "workflow_dispatch") return Boolean(event.selectedJob && hygieneManualJobIds(model).includes(event.selectedJob));
  if (hygiene.mode === "release") {
    return event.name === "release" && (!event.action || event.action === "published");
  }
  if (event.name === "release") {
    return hygiene.releaseGate && (!event.action || event.action === "published");
  }
  return event.name === "pull_request";
}

function skipReasonForJob(event: GitHubManifestEvent, trigger: string[]): string {
  if (event.name === "workflow_dispatch" && !event.selectedJob && trigger.some((id) => id === "manual")) return "manual_selector_missing";
  return "event_filter";
}

function skipReasonForGeneratedJob(event: GitHubManifestEvent, manualIds: string[]): string {
  if (event.name === "workflow_dispatch" && !event.selectedJob && manualIds.length > 0) return "manual_selector_missing";
  return "event_filter";
}

function validateLocalStep(manifest: GitHubJobManifest, step: GitHubManifestStep, env: NodeJS.ProcessEnv): string[] {
  const issues: string[] = [];
  for (const [permission, required] of Object.entries(step.permissions ?? {})) {
    const actual = manifest.job.permissions[permission];
    if (!permissionAllows(actual, required)) {
      issues.push(`requires ${permission}: ${required}, but job grants ${actual ?? "none"}`);
    }
  }
  if (step.local.networked && manifest.local.network === "deny") {
    issues.push("networked step is denied by --network deny");
  }
  if (step.local.networked && manifest.local.network === "allow") {
    for (const secret of step.secrets) {
      if (!env[secret]) issues.push(`requires secret env ${secret} for --network allow`);
    }
  }
  return issues;
}

function permissionAllows(actual: "read" | "write" | undefined, required: "read" | "write"): boolean {
  if (required === "read") return actual === "read" || actual === "write";
  return actual === "write";
}

function commandLooksNetworked(command: string): boolean {
  return /\b(?:gh|npm\s+publish|npx|curl|wget|git\s+(?:push|fetch|pull|clone))\b/u.test(command);
}

function commandLooksDangerous(command: string): boolean {
  return /\b(?:publish|push|release|comment|merge|pull-request)\b/u.test(command);
}

function buildRenderModel(
  pipeline: NormalizedPipeline,
  options: PackageInfo & { cwd: string; configPath: string; workflowPath: string }
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
  const evidence = resolveGitHubEvidence(pipeline);
  const pages = resolveGitHubPages(pipeline);
  const bridge = resolveGitHubBridge(pipeline);
  const contract = resolveGitHubContract(pipeline, { pages, bridge });
  const hygiene = resolveGitHubHygiene(pipeline, { pages, bridge, contract });
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
  if (contract.enabled) {
    if (contract.mode === "release") {
      addReleasePublishedTrigger(triggers);
    } else {
      addPullRequestTrigger(triggers, "pull_request");
    }
  }
  if (hygiene.enabled) {
    if (hygiene.mode !== "release") {
      addPullRequestTrigger(triggers, "pull_request");
    }
    if (hygiene.mode === "release" || hygiene.releaseGate) {
      addReleasePublishedTrigger(triggers);
    }
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
  if (contract.enabled) {
    manualDispatchJobs.push(contract.job);
    manualDispatchJobs.sort((left, right) => left.localeCompare(right));
  }
  if (hygiene.enabled) {
    manualDispatchJobs.push(hygiene.job);
    manualDispatchJobs.sort((left, right) => left.localeCompare(right));
  }
  const nodeVersion = pipeline.sync.github.nodeVersion ?? DEFAULT_NODE_VERSION;
  const runtime = resolveRuntimeSpecs(pipeline.sync.github.runtime, options.projectKind, nodeVersion);
  const setup = resolveGitHubSetup(pipeline.sync.github.setup, options.packageManager, options.packageManagerVersion);
  const jobs: RenderJobModel[] = Object.values(pipeline.jobs)
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
    .sort((left, right) => left.id.localeCompare(right.id));
  const sourceImpactJobs = resolveGitHubSourceImpactJobs(pipeline, options.cwd, jobs);
  const sourceImpact = {
    ...pipeline.sync.github.sourceImpact,
    generatedJobs: sourceImpactJobs.map((job) => ({
      job: job.job,
      planJob: job.planJob,
      matrixJob: job.matrixJob,
      matrixRows: job.plan.matrix.include.length,
      sources: Object.keys(job.plan.sources).sort((left, right) => left.localeCompare(right))
    }))
  };
  return {
    name: "Async Pipeline",
    configPath: options.configPath,
    workflowPath: options.workflowPath,
    projectKind: options.projectKind,
    triggers,
    jobs,
    sourceImpactJobs,
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
    evidence,
    sourceImpact,
    attest: pipeline.sync.github.attest,
    contract,
    hygiene,
    bridge,
    pages,
    manualDispatchJobs
  };
}

function resolveGitHubEvidence(pipeline: NormalizedPipeline): NormalizedGitHubEvidenceConfig {
  const config = pipeline.sync.github.evidence;
  if (!config.enabled) return config;
  if (pipeline.jobs[config.job]) {
    throw pipelineError(
      "ASYNC_PIPELINE_GITHUB_EVIDENCE_JOB_CONFLICT",
      `sync.github.evidence.job "${config.job}" conflicts with an existing pipeline job. Remove the explicit job or set sync.github.evidence.job to a different id.`
    );
  }
  const generatedJobs = new Set<string>([
    "package-preview",
    "dependabot-auto-merge",
    pipeline.sync.github.pages.job,
    "async-bridge",
    pipeline.sync.github.contract.enabled ? pipeline.sync.github.contract.job : "",
    pipeline.sync.github.hygiene.enabled ? pipeline.sync.github.hygiene.job : ""
  ].filter(Boolean));
  if (generatedJobs.has(config.job)) {
    throw pipelineError(
      "ASYNC_PIPELINE_GITHUB_EVIDENCE_JOB_CONFLICT",
      `sync.github.evidence.job "${config.job}" conflicts with a generated GitHub job. Set sync.github.evidence.job to a different id.`
    );
  }
  return config;
}

function resolveGitHubContract(
  pipeline: NormalizedPipeline,
  generated: {
    pages: NormalizedGitHubPagesSyncConfig;
    bridge: ReturnType<typeof resolveGitHubBridge>;
  }
): NormalizedGitHubContractConfig {
  const config = pipeline.sync.github.contract;
  if (!config.enabled) return config;
  const jobId = config.job.toLowerCase();
  if (Object.keys(pipeline.jobs).some((id) => id.toLowerCase() === jobId)) {
    throw pipelineError(
      "ASYNC_PIPELINE_GITHUB_CONTRACT_JOB_CONFLICT",
      `sync.github.contract.job "${config.job}" conflicts with an existing pipeline job. Remove the explicit job or set sync.github.contract.job to a different id.`
    );
  }
  const generatedJobs = new Set<string>();
  if (pipeline.sync.github.packagePreviews.enabled) generatedJobs.add("package-preview");
  if (pipeline.sync.github.dependabotAutoMerge.enabled) generatedJobs.add("dependabot-auto-merge");
  if (pipeline.sync.github.evidence.enabled) generatedJobs.add(pipeline.sync.github.evidence.job);
  if (generated.pages.enabled) generatedJobs.add(generated.pages.job);
  if (generated.bridge.actionsJob.enabled) generatedJobs.add(generated.bridge.job);
  if (pipeline.sync.github.hygiene.enabled) generatedJobs.add(pipeline.sync.github.hygiene.job);
  if ([...generatedJobs].some((id) => id.toLowerCase() === jobId)) {
    throw pipelineError(
      "ASYNC_PIPELINE_GITHUB_CONTRACT_JOB_CONFLICT",
      `sync.github.contract.job "${config.job}" conflicts with a generated GitHub job. Set sync.github.contract.job to a different id.`
    );
  }
  return config;
}

function resolveGitHubHygiene(
  pipeline: NormalizedPipeline,
  generated: {
    pages: NormalizedGitHubPagesSyncConfig;
    bridge: ReturnType<typeof resolveGitHubBridge>;
    contract: NormalizedGitHubContractConfig;
  }
): NormalizedGitHubHygieneConfig {
  const config = pipeline.sync.github.hygiene;
  if (!config.enabled) return config;
  const jobId = config.job.toLowerCase();
  if (Object.keys(pipeline.jobs).some((id) => id.toLowerCase() === jobId)) {
    throw pipelineError(
      "ASYNC_PIPELINE_GITHUB_HYGIENE_JOB_CONFLICT",
      `sync.github.hygiene.job "${config.job}" conflicts with an existing pipeline job. Remove the explicit job or set sync.github.hygiene.job to a different id.`
    );
  }
  const generatedJobs = new Set<string>();
  if (pipeline.sync.github.packagePreviews.enabled) generatedJobs.add("package-preview");
  if (pipeline.sync.github.dependabotAutoMerge.enabled) generatedJobs.add("dependabot-auto-merge");
  if (pipeline.sync.github.evidence.enabled) generatedJobs.add(pipeline.sync.github.evidence.job);
  if (generated.pages.enabled) generatedJobs.add(generated.pages.job);
  if (generated.bridge.actionsJob.enabled) generatedJobs.add(generated.bridge.job);
  if (generated.contract.enabled) generatedJobs.add(generated.contract.job);
  if ([...generatedJobs].some((id) => id.toLowerCase() === jobId)) {
    throw pipelineError(
      "ASYNC_PIPELINE_GITHUB_HYGIENE_JOB_CONFLICT",
      `sync.github.hygiene.job "${config.job}" conflicts with a generated GitHub job. Set sync.github.hygiene.job to a different id.`
    );
  }
  return config;
}

function resolveGitHubSourceImpactJobs(pipeline: NormalizedPipeline, cwd: string, jobs: RenderJobModel[]): SourceImpactRenderJob[] {
  const config = pipeline.sync.github.sourceImpact;
  if (!config.enabled) return [];

  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  const explicitJobs = new Set(config.jobs);
  const selectedJobIds = config.jobs.length > 0 ? config.jobs : jobs.map((job) => job.id);
  const generatedIds = new Set<string>([
    "package-preview",
    "dependabot-auto-merge",
    "async-bridge",
    pipeline.sync.github.evidence.job,
    pipeline.sync.github.contract.enabled ? pipeline.sync.github.contract.job : "",
    pipeline.sync.github.hygiene.enabled ? pipeline.sync.github.hygiene.job : "",
    pipeline.sync.github.pages.job
  ].filter(Boolean).map((id) => id.toLowerCase()));
  const existingJobIds = new Set(Object.keys(pipeline.jobs).map((id) => id.toLowerCase()));
  const result: SourceImpactRenderJob[] = [];

  for (const jobId of selectedJobIds) {
    const job = jobsById.get(jobId);
    if (!job) {
      throw pipelineError("ASYNC_PIPELINE_GITHUB_SOURCE_IMPACT_INVALID", `sync.github.sourceImpact references missing job "${jobId}".`);
    }
    if (job.github?.runsOnMatrix) {
      throw pipelineError(
        "ASYNC_PIPELINE_GITHUB_SOURCE_IMPACT_INVALID",
        `sync.github.sourceImpact cannot target job "${jobId}" because that job already uses github.runsOnMatrix.`
      );
    }
    const plan = sourceImpactPlanForJob(pipeline, cwd, jobId);
    if (plan.matrix.include.length === 0) {
      if (explicitJobs.has(jobId)) {
        throw pipelineError("ASYNC_PIPELINE_GITHUB_SOURCE_IMPACT_INVALID", `sync.github.sourceImpact job "${jobId}" has no source task refs.`);
      }
      continue;
    }

    const generatedJobPrefix = safeGeneratedJobId(jobId);
    const planJob = `${generatedJobPrefix}-source-plan`;
    const matrixJob = `${generatedJobPrefix}-sources`;
    for (const generatedJob of [planJob, matrixJob]) {
      const generatedJobKey = generatedJob.toLowerCase();
      if (existingJobIds.has(generatedJobKey)) {
        throw pipelineError("ASYNC_PIPELINE_GITHUB_SOURCE_IMPACT_JOB_CONFLICT", `Generated source-impact job "${generatedJob}" conflicts with an existing pipeline job.`);
      }
      if (generatedIds.has(generatedJobKey)) {
        throw pipelineError("ASYNC_PIPELINE_GITHUB_SOURCE_IMPACT_JOB_CONFLICT", `Generated source-impact job "${generatedJob}" conflicts with another generated GitHub job.`);
      }
      generatedIds.add(generatedJobKey);
    }

    result.push({
      job: jobId,
      planJob,
      matrixJob,
      planPath: `.async/actions/source-impact/${safeArtifactPart(jobId)}-source-plan.json`,
      plan,
      if: job.if,
      github: job.github,
      env: job.env
    });
  }

  return result.sort((left, right) => left.job.localeCompare(right.job));
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

function addReleasePublishedTrigger(triggers: Record<string, unknown>): void {
  const existing = triggers.release && typeof triggers.release === "object" && !Array.isArray(triggers.release)
    ? triggers.release as Record<string, unknown>
    : {};
  const existingTypes = Array.isArray(existing.types) ? existing.types.filter((value): value is string => typeof value === "string") : [];
  triggers.release = sortObject({
    ...existing,
    types: [...new Set([...existingTypes, "published"])].sort()
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
  for (const sourceJob of model.sourceImpactJobs) {
    renderSourceImpactPlanJob(lines, model, sourceJob);
    renderSourceImpactMatrixJob(lines, model, sourceJob);
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
  if (model.contract.enabled) {
    renderContractJob(lines, model);
  }
  if (model.hygiene.enabled) {
    renderHygieneJob(lines, model);
  }
  if (model.evidence.enabled) {
    renderEvidenceFanInJob(lines, model);
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
  const needs = releaseGateNeeds(model, job);
  if (needs.length > 0) {
    lines.push(`    needs: ${JSON.stringify(needs)}`);
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
  const lifecyclePlan = resolveLifecycleJobPlan(model, job);
  const grants = job.github?.permissions;
  const idToken = grants?.idToken ?? (job.requires?.provenance || attestRequiresOidc(model, lifecyclePlan) ? "write" as const : undefined);
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
  renderTaskCacheRestoreSteps(lines, model, { kind: "job", id: job.id });
  if (lifecyclePlan) {
    renderLifecycleJobPlan(lines, model, job, lifecyclePlan);
  } else {
    renderRunActionStep(lines, "Run pipeline job", `${model.command} github check && ${model.command} run ${shellWord(job.id)}${job.execution ? ` --execution ${shellWord(job.execution)}` : ""}`, job.env);
  }
  renderAttestSteps(lines, model, lifecyclePlan);
  renderAgentEvidenceStep(lines, model, job, { matrix: Boolean(runnerMatrix && runnerMatrix.length > 0) });
  renderTaskCacheSaveSteps(lines, model, { kind: "job", id: job.id });
  if (job.github?.pages) {
    lines.push("");
    renderPagesBuildSteps(lines, job.github.pages);
  }
  renderEvidenceCollectStep(lines, model, { matrix: Boolean(runnerMatrix && runnerMatrix.length > 0) });
  lines.push("");
}

function renderSourceImpactPlanJob(lines: string[], model: ReturnType<typeof buildRenderModel>, sourceJob: SourceImpactRenderJob): void {
  const runsOn = sourceJob.github?.runsOn ?? "ubuntu-latest";
  lines.push(
    `  ${yamlKey(sourceJob.planJob)}:`,
    `    name: ${sourceJob.planJob}`
  );
  if (sourceJob.if) {
    lines.push(`    if: ${sourceJob.if}`);
  }
  lines.push(
    `    runs-on: ${Array.isArray(runsOn) ? JSON.stringify(runsOn) : runsOn}`,
    "    permissions:",
    "      contents: read",
    "    outputs:",
    "      matrix: ${{ steps.source-plan.outputs.matrix }}",
    "    steps:",
    "      - name: Checkout",
    `        uses: ${CHECKOUT_ACTION}`,
    "",
    ...renderSetupSteps(model)
  );
  renderWriteSourceImpactPlanStep(lines, sourceJob);
  lines.push(
    "",
    "      - name: Plan source impact matrix",
    "        id: source-plan",
    `        uses: ${ASYNC_SOURCE_IMPACT_ACTION}`,
    "        with:",
    "          mode: plan",
    `          source-plan: ${sourceJob.planPath}`,
    "          output-matrix: true"
  );
  renderEvidenceCollectStep(lines, model);
  lines.push("");
}

function renderSourceImpactMatrixJob(lines: string[], model: ReturnType<typeof buildRenderModel>, sourceJob: SourceImpactRenderJob): void {
  const runsOn = sourceJob.github?.runsOn ?? "ubuntu-latest";
  lines.push(
    `  ${yamlKey(sourceJob.matrixJob)}:`,
    `    name: ${sourceJob.job} source (\${{ matrix.source }}:\${{ matrix.taskId }})`,
    `    needs: ${JSON.stringify(sourceJob.planJob)}`,
    `    if: \${{ always() && needs['${sourceJob.planJob}'].result == 'success' }}`,
    "    strategy:",
    "      fail-fast: false",
    `      matrix: \${{ fromJSON(needs['${sourceJob.planJob}'].outputs.matrix || '{"include":[]}') }}`,
    `    runs-on: ${Array.isArray(runsOn) ? JSON.stringify(runsOn) : runsOn}`,
    "    permissions:",
    "      contents: read",
    "    steps:",
    "      - name: Checkout",
    `        uses: ${CHECKOUT_ACTION}`,
    "",
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
  renderWriteSourceImpactPlanStep(lines, sourceJob);
  lines.push(
    "",
    "      - name: Validate source checkout",
    `        uses: ${ASYNC_SOURCE_IMPACT_ACTION}`,
    "        with:",
    "          mode: checkout",
    `          source-plan: ${sourceJob.planPath}`,
    "          source-id: ${{ matrix.source }}",
    "          ref: ${{ matrix.ref }}",
    "          path: ${{ matrix.path }}",
    "",
    "      - name: Prepare source checkout",
    `        uses: ${ASYNC_SOURCE_IMPACT_ACTION}`,
    "        with:",
    "          mode: prepare",
    `          source-plan: ${sourceJob.planPath}`,
    "          source-id: ${{ matrix.source }}",
    "          path: ${{ matrix.path }}"
  );
  renderTaskCacheRestoreSteps(lines, model, {
    kind: "task",
    id: "\"${{ matrix.task }}\"",
    manifestPath: ".async/actions/cache/${{ matrix.source }}-${{ matrix.taskId }}-cache-manifest.json"
  });
  renderRunActionStep(
    lines,
    "Run source task",
    `${model.command} github check && ${model.command} run-task "\${{ matrix.task }}"`,
    scopeActionEnv(sourceJob.env, new Set()),
    { artifactName: "async-pipeline-${{ github.job }}-${{ matrix.source }}-${{ matrix.taskId }}-runs" }
  );
  renderTaskCacheSaveSteps(lines, model, {
    kind: "task",
    id: "\"${{ matrix.task }}\"",
    manifestPath: ".async/actions/cache/${{ matrix.source }}-${{ matrix.taskId }}-cache-manifest.json"
  });
  renderEvidenceCollectStep(lines, model, { matrix: true });
  lines.push("");
}

type TaskCacheTarget = { kind: "job" | "task"; id: string; manifestPath?: string };

function renderTaskCacheRestoreSteps(lines: string[], model: ReturnType<typeof buildRenderModel>, target: TaskCacheTarget): void {
  if (!model.taskCache) return;
  const manifestPath = target.manifestPath ?? `.async/actions/cache/${safeArtifactPart(target.id)}-cache-manifest.json`;
  lines.push(
    "",
    "      - name: Write task cache manifest",
    `        run: ${renderCacheManifestCommand(model, target, manifestPath, "read-only")}`,
    "",
    "      - name: Restore Async task cache",
    "        id: async-cache-restore",
    `        uses: ${ASYNC_CACHE_ACTION}`,
    "        with:",
    "          mode: restore",
    `          manifest: ${manifestPath}`,
    "          trust: read-only"
  );
}

function renderTaskCacheSaveSteps(lines: string[], model: ReturnType<typeof buildRenderModel>, target: TaskCacheTarget): void {
  if (!model.taskCache) return;
  const manifestPath = target.manifestPath ?? `.async/actions/cache/${safeArtifactPart(target.id)}-cache-manifest.json`;
  lines.push(
    "",
    "      - name: Save Async task cache",
    "        if: ${{ success() && github.event_name != 'pull_request' && steps.async-cache-restore.outputs.cache-hit != 'true' }}",
    `        uses: ${ASYNC_CACHE_ACTION}`,
    "        with:",
    "          mode: save",
    `          manifest: ${manifestPath}`,
    "          trust: read-write"
  );
}

function renderCacheManifestCommand(model: ReturnType<typeof buildRenderModel>, target: TaskCacheTarget, manifestPath: string, trust: "read-only" | "read-write"): string {
  const targetFlag = target.kind === "job" ? "--job" : "--task";
  return `${model.command} cache manifest ${targetFlag} ${target.id.startsWith("\"") ? target.id : shellWord(target.id)} --output ${shellWord(manifestPath)} --trust ${trust}`;
}

function renderWriteSourceImpactPlanStep(lines: string[], sourceJob: SourceImpactRenderJob): void {
  const planJson = JSON.stringify(sourceJob.plan, null, 2);
  lines.push(
    "",
    "      - name: Write generated source plan",
    "        run: |",
    `          mkdir -p ${shellWord(dirname(sourceJob.planPath))}`,
    `          cat > ${shellWord(sourceJob.planPath)} <<'ASYNC_SOURCE_PLAN'`,
    ...planJson.split("\n").map((line) => `          ${line}`),
    "          ASYNC_SOURCE_PLAN"
  );
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
  renderTaskCacheRestoreSteps(lines, model, { kind: "task", id: pages.target });
  renderRunActionStep(lines, "Run Pages target", `${model.command} github check && ${model.command} run-task ${shellWord(pages.target)}`, {});
  renderTaskCacheSaveSteps(lines, model, { kind: "task", id: pages.target });
  lines.push("");
  renderPagesBuildSteps(lines, pages);
  renderEvidenceCollectStep(lines, model);
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

function renderEvidenceCollectStep(lines: string[], model: ReturnType<typeof buildRenderModel>, options: { matrix?: boolean; extraPaths?: string[] } = {}): void {
  if (!model.evidence.enabled) return;
  const suffix = options.matrix ? "${{ github.job }}-${{ strategy.job-index }}" : "${{ github.job }}";
  const paths = [...new Set([...model.evidence.paths, ...(options.extraPaths ?? [])])];
  lines.push(
    "",
    "      - name: Collect evidence manifest",
    "        if: ${{ always() }}",
    `        uses: ${ASYNC_EVIDENCE_ACTION}`,
    "        with:",
    "          mode: collect",
    "          paths: |",
    ...paths.map((path) => `            ${path}`),
    ...(model.evidence.receiptPaths.length > 0
      ? [
          "          receipt-paths: |",
          ...model.evidence.receiptPaths.map((path) => `            ${path}`)
        ]
      : []),
    `          manifest-path: ".async/evidence/${suffix}/manifest.json"`,
    `          summary-path: ".async/evidence/${suffix}/summary.md"`,
    `          artifact-name: ${model.evidence.artifactNamePrefix}-${suffix}`,
    `          retention-days: ${model.evidence.retentionDays}`,
    `          if-no-files-found: ${model.evidence.ifNoFilesFound}`,
    `          include-summary: ${model.evidence.includeSummary ? "true" : "false"}`
  );
}

function renderAgentEvidenceStep(
  lines: string[],
  model: ReturnType<typeof buildRenderModel>,
  job: ReturnType<typeof buildRenderModel>["jobs"][number],
  options: { matrix?: boolean } = {}
): void {
  const evidence = agentEvidenceForTargets(model.tasks, job.target);
  if (!evidence.hasAgentStep) return;
  const suffix = options.matrix ? "${{ github.job }}-${{ strategy.job-index }}" : "${{ github.job }}";
  const canComment = job.github?.permissions?.issues === "write" || job.github?.permissions?.pullRequests === "write";
  lines.push(
    "",
    "      - name: Bundle agent evidence",
    "        if: ${{ always() }}",
    "        id: async-agent-evidence",
    `        uses: ${ASYNC_AGENT_EVIDENCE_ACTION}`,
    "        with:",
    `          mode: ${canComment ? "comment" : "bundle"}`,
    "          run-directory: .async/runs",
    ...(evidence.outputs.length > 0
      ? [
          "          outputs: |",
          ...evidence.outputs.map((path) => `            ${path}`)
        ]
      : []),
    `          evidence-path: ".async/actions/agent-evidence/${suffix}/manifest.json"`,
    `          bundle-path: ".async/actions/agent-evidence/${suffix}/bundle.json"`,
    `          receipt-path: ".async/actions/receipts/${suffix}-agent-evidence.json"`,
    `          comment: ${canComment ? "true" : "false"}`,
    "          comment-marker: async-agent-evidence-${{ github.job }}"
  );
  if (canComment) {
    renderPrCommentActionStep(lines, "Comment agent evidence", "async-agent-evidence");
  }
}

function renderPrCommentActionStep(lines: string[], name: string, sourceStepId: string): void {
  lines.push(
    "",
    `      - name: ${name}`,
    `        if: github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository && steps.${sourceStepId}.outputs.comment-body != ''`,
    `        uses: ${ASYNC_COMMENT_ACTION}`,
    "        with:",
    "          mode: pr-comment",
    "          repository: ${{ github.repository }}",
    "          number: ${{ github.event.pull_request.number }}",
    `          marker: \${{ steps.${sourceStepId}.outputs.comment-marker }}`,
    `          body: \${{ steps.${sourceStepId}.outputs.comment-body }}`,
    "          token: ${{ secrets.GITHUB_TOKEN }}"
  );
}

function agentEvidenceForTargets(tasks: Record<string, NormalizedTask>, targets: readonly string[]): { hasAgentStep: boolean; outputs: string[] } {
  const visited = new Set<string>();
  const outputs = new Set<string>();
  let hasAgentStep = false;

  const visit = (taskId: string): void => {
    if (visited.has(taskId)) return;
    visited.add(taskId);
    const task = tasks[taskId];
    if (!task) return;
    for (const dependency of task.dependsOn) visit(dependency);
    const taskHasAgent = task.steps.some((step) => typeof step === "object" && step !== null && "kind" in step && step.kind === "agent");
    if (taskHasAgent) {
      hasAgentStep = true;
      for (const path of task.outputs) outputs.add(path);
    }
  };

  for (const target of targets) visit(target);
  return { hasAgentStep, outputs: [...outputs].sort((left, right) => left.localeCompare(right)) };
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
      kind: "release",
      mode: "doctor",
      packagePath
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
  const releaseEvidenceTasks = leadingRunTasks(plan);
  for (const item of releaseEvidenceTasks) {
    renderRunActionStep(
      lines,
      `Run pipeline task ${item.taskId}`,
      `${model.command} github check && ${model.command} run-task ${shellWord(item.taskId)}`,
      scopeTaskRunEnv(job.env, model.tasks[item.taskId]),
      { artifactName: `async-pipeline-\${{ github.job }}-${safeArtifactPart(item.taskId)}-runs` }
    );
  }
  if (hasReleaseLifecycle(plan)) {
    renderReleaseEvidenceSteps(lines, lifecyclePackagePath(plan) ?? ".", job.env);
  }
  for (const item of plan.slice(releaseEvidenceTasks.length)) {
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
      renderPreviewEvidenceSteps(lines, item);
      renderPreviewActionStep(lines, item, job.env);
      renderPreviewDoctorStep(lines, item);
      continue;
    }
    if (item.kind === "release") {
      renderReleaseDoctorActionStep(lines, "Run release doctor", "doctor", item.packagePath, job.env, { network: "live" });
      continue;
    }
    renderPublishActionStep(lines, item, job.env, job.requires?.provenance === true);
  }
}

function leadingRunTasks(plan: LifecyclePlanItem[]): Array<Extract<LifecyclePlanItem, { kind: "run-task" }>> {
  const tasks: Array<Extract<LifecyclePlanItem, { kind: "run-task" }>> = [];
  for (const item of plan) {
    if (item.kind !== "run-task") break;
    tasks.push(item);
  }
  return tasks;
}

function renderReleaseEvidenceSteps(lines: string[], packagePath: string, env: Record<string, EnvValue>): void {
  renderReleaseDoctorActionStep(lines, "Plan release package", "plan", packagePath, env);
  renderReleaseDoctorActionStep(lines, "Inspect release package", "inspect", packagePath, env);
  renderReleaseDoctorActionStep(lines, "Check release changelog", "changelog", packagePath, env);
  renderReleaseDoctorActionStep(lines, "Render release notes", "notes", packagePath, env);
}

function renderPreviewEvidenceSteps(lines: string[], preview: Extract<LifecyclePlanItem, { kind: "preview" }>): void {
  for (const [command, label] of [
    ["plan", "Plan"],
    ["stage", "Stage"],
    ["inspect", "Inspect"]
  ] as const) {
    lines.push(
      "",
      `      - name: ${label} ${preview.mode === "main" ? "main" : "PR"} package preview`,
      `        run: ${previewEvidenceCommand(command, preview)}`
    );
  }
}

function renderPreviewActionStep(lines: string[], preview: Extract<LifecyclePlanItem, { kind: "preview" }>, env: Record<string, EnvValue>): void {
  const stepId = previewPublishStepId(preview);
  lines.push(
    "",
    `      - name: Publish ${preview.mode === "main" ? "main" : "PR"} package preview`,
    `        id: ${stepId}`,
    `        uses: ${ASYNC_PREVIEW_ACTION}`,
    "        with:",
    `          package-path: ${JSON.stringify(preview.packagePath)}`,
    `          target-registry: ${JSON.stringify(preview.registry)}`,
    ...(preview.namespace ? [`          namespace: ${JSON.stringify(preview.namespace)}`] : []),
    `          mode: ${preview.mode}`,
    `          comment: ${preview.comment ? "true" : "false"}`,
    `          token-env-name: ${JSON.stringify(preview.tokenEnv)}`,
    `          release-package: ${JSON.stringify(ASYNC_RELEASE_PACKAGE)}`
  );
  renderActionEnv(lines, scopeActionEnv(env, new Set([preview.tokenEnv])));
  if (preview.mode === "pr" && preview.comment) {
    renderPreviewCommentStep(lines, stepId);
  }
}

function renderPreviewDoctorStep(lines: string[], preview: Extract<LifecyclePlanItem, { kind: "preview" }>, publishStepId = previewPublishStepId(preview)): void {
  lines.push(
    "",
    `      - name: Verify ${preview.mode === "main" ? "main" : "PR"} package preview`,
    `        if: ${previewDoctorCondition(preview, publishStepId)}`,
    `        run: ${previewEvidenceCommand("doctor", preview, { network: "live" })}`,
    "        env:",
    `          ${preview.tokenEnv}: \${{ secrets.${preview.tokenEnv} }}`
  );
}

function renderPreviewCommentStep(lines: string[], previewStepId: string): void {
  lines.push(
    "",
    "      - name: Comment package preview",
    `        if: github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository && steps.${previewStepId}.outputs.comment-body != ''`,
    `        uses: ${ASYNC_COMMENT_ACTION}`,
    "        with:",
    "          mode: pr-comment",
    "          repository: ${{ github.repository }}",
    "          number: ${{ github.event.pull_request.number }}",
    `          marker: \${{ steps.${previewStepId}.outputs.comment-marker }}`,
    `          body: \${{ steps.${previewStepId}.outputs.comment-body }}`,
    "          token: ${{ secrets.GITHUB_TOKEN }}"
  );
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
    ...(publish.mode === "github-release" ? ["          notes-file: .async/release/release-notes.md"] : []),
    ...(publish.mode === "npm" ? [`          provenance: ${provenance ? "true" : "false"}`] : [])
  );
  renderActionEnv(lines, scopeActionEnv(env, publish.mode === "npm" ? new Set(["NODE_AUTH_TOKEN"]) : new Set(["GITHUB_TOKEN"])));
}

function renderReleaseDoctorActionStep(
  lines: string[],
  label: string,
  mode: "plan" | "inspect" | "changelog" | "notes" | "doctor",
  packagePath: string,
  env: Record<string, EnvValue>,
  options: { network?: "live" | "mock" } = {}
): void {
  lines.push(
    "",
    `      - name: ${label}`,
    `        uses: ${ASYNC_DOCTOR_ACTION}`,
    "        with:",
    `          mode: ${mode}`,
    `          package-path: ${JSON.stringify(packagePath)}`,
    "          evidence-dir: .async/release",
    `          release-command: ${JSON.stringify(ASYNC_RELEASE_COMMAND)}`,
    ...(mode === "doctor" ? [`          network: ${options.network ?? "live"}`] : [])
  );
  renderActionEnv(lines, scopeActionEnv(env, mode === "doctor" ? new Set(["GITHUB_TOKEN"]) : new Set()));
}

function attestRequiresOidc(model: ReturnType<typeof buildRenderModel>, lifecyclePlan: LifecyclePlanItem[] | undefined): boolean {
  return model.attest.enabled && model.attest.githubAttestation && hasReleaseLifecycle(lifecyclePlan);
}

function renderAttestSteps(lines: string[], model: ReturnType<typeof buildRenderModel>, lifecyclePlan: LifecyclePlanItem[] | undefined): void {
  const attest = model.attest;
  if (!attest.enabled || !hasReleaseLifecycle(lifecyclePlan)) return;

  const packagePath = attest.packagePath ?? lifecyclePackagePath(lifecyclePlan) ?? ".";
  const artifacts = attest.artifacts.length > 0
    ? attest.artifacts
    : [packagePath === "." ? "package.json" : `${packagePath}/package.json`];
  const subjectManifest = attest.subjectManifest;
  const sbomPath = attest.sbomPath;

  lines.push(
    "",
    "      - name: Create attestation subject manifest",
    `        uses: ${ASYNC_ATTEST_ACTION}`,
    "        with:",
    "          mode: digest",
    `          package-path: ${JSON.stringify(packagePath)}`,
    "          artifacts: |",
    ...artifacts.map((artifact) => `            ${artifact}`),
    `          subject-manifest: ${subjectManifest}`,
    `          sbom-path: ${sbomPath}`,
    `          evidence-path: ${attestReceiptPath(attest.evidencePath, "digest")}`,
    `          require-npm-provenance: ${attest.requireNpmProvenance ? "true" : "false"}`,
    `          tarball-scan: ${attest.tarballScan ? "true" : "false"}`,
    "",
    "      - name: Write attestation SBOM evidence",
    `        uses: ${ASYNC_ATTEST_ACTION}`,
    "        with:",
    "          mode: sbom",
    `          package-path: ${JSON.stringify(packagePath)}`,
    "          artifacts: |",
    ...artifacts.map((artifact) => `            ${artifact}`),
    `          subject-manifest: ${subjectManifest}`,
    `          sbom-path: ${sbomPath}`,
    `          evidence-path: ${attestReceiptPath(attest.evidencePath, "sbom")}`
  );

  if (attest.githubAttestation) {
    lines.push(
      "",
      "      - name: Record GitHub attestation intent",
      `        uses: ${ASYNC_ATTEST_ACTION}`,
      "        with:",
      "          mode: attest",
      `          package-path: ${JSON.stringify(packagePath)}`,
      `          subject-manifest: ${subjectManifest}`,
      `          evidence-path: ${attestReceiptPath(attest.evidencePath, "github")}`,
      "          github-attestation: true"
    );
  }
}

function hasReleaseLifecycle(lifecyclePlan: LifecyclePlanItem[] | undefined): boolean {
  return Boolean(lifecyclePlan?.some((item) => item.kind === "publish"));
}

function lifecyclePackagePath(lifecyclePlan: LifecyclePlanItem[] | undefined): string | undefined {
  const item = lifecyclePlan?.find((entry): entry is Extract<LifecyclePlanItem, { kind: "publish" | "release" }> => entry.kind === "publish" || entry.kind === "release");
  return item?.packagePath;
}

function attestReceiptPath(path: string, suffix: string): string {
  const extensionIndex = path.endsWith(".json") ? path.length - ".json".length : -1;
  if (extensionIndex >= 0) {
    return `${path.slice(0, extensionIndex)}-${suffix}.json`;
  }
  return `${path}-${suffix}`;
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

function safeGeneratedJobId(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return normalized || "job";
}

function renderPackagePreviewJob(lines: string[], model: ReturnType<typeof buildRenderModel>): void {
  const preview = model.packagePreviews;
  if (!preview.package || !preview.target) return;
  const previewItem: Extract<LifecyclePlanItem, { kind: "preview" }> = {
    kind: "preview",
    mode: "pr",
    packagePath: preview.package,
    registry: preview.registry,
    namespace: preview.namespace,
    comment: preview.comment,
    tokenEnv: preview.tokenEnv
  };
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
  renderTaskCacheRestoreSteps(lines, model, { kind: "task", id: preview.target, manifestPath: ".async/actions/cache/package-preview-cache-manifest.json" });
  renderRunActionStep(lines, "Run package preview target", `${model.command} github check && ${model.command} run-task ${shellWord(preview.target)}`, {});
  renderTaskCacheSaveSteps(lines, model, { kind: "task", id: preview.target, manifestPath: ".async/actions/cache/package-preview-cache-manifest.json" });
  renderPreviewEvidenceSteps(lines, previewItem);
  lines.push(
    "",
    "      - name: Publish package preview",
    "        id: async-package-preview",
    `        uses: ${ASYNC_PREVIEW_ACTION}`,
    "        with:",
    `          package-path: ${JSON.stringify(preview.package)}`,
    `          target-registry: ${JSON.stringify(preview.registry)}`,
    ...(preview.namespace ? [`          namespace: ${JSON.stringify(preview.namespace)}`] : []),
    "          mode: pr",
    `          comment: ${preview.comment ? "true" : "false"}`,
    `          token-env-name: ${JSON.stringify(preview.tokenEnv)}`,
    `          release-package: ${JSON.stringify(ASYNC_RELEASE_PACKAGE)}`,
    "        env:",
    "          CI: true",
    `          ${preview.tokenEnv}: \${{ secrets.${preview.tokenEnv} }}`
  );
  renderPreviewDoctorStep(lines, previewItem, "async-package-preview");
  if (preview.comment) {
    renderPreviewCommentStep(lines, "async-package-preview");
  }
  renderEvidenceCollectStep(lines, model, { extraPaths: [".async/release"] });
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
  renderEvidenceCollectStep(lines, model);
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

function renderContractJob(lines: string[], model: ReturnType<typeof buildRenderModel>): void {
  const contract = model.contract;
  lines.push(
    `  ${yamlKey(contract.job)}:`,
    `    name: ${contract.job}`,
    `    if: ${renderContractCondition(contract)}`,
    "    runs-on: ubuntu-latest",
    "    permissions:",
    "      contents: read",
    "    steps:",
    "      - name: Checkout",
    `        uses: ${CHECKOUT_ACTION}`,
    "",
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
  renderContractActionStep(lines, contract);
  renderEvidenceCollectStep(lines, model, { extraPaths: [contract.evidenceDir] });
  lines.push("");
}

function renderContractActionStep(lines: string[], contract: NormalizedGitHubContractConfig): void {
  lines.push(
    "",
    "      - name: Run contract evidence",
    `        uses: ${ASYNC_CONTRACT_ACTION}`,
    "        with:",
    `          mode: ${contract.mode}`,
    `          checks: ${JSON.stringify(contractChecks(contract).join(","))}`,
    `          package-path: ${JSON.stringify(contract.packagePath)}`,
    ...(contract.schema.enabled
      ? [
          "          schema-sources: |",
          ...contract.schema.sources.map((source) => `            ${source}`),
          `          schema-output: ${JSON.stringify(contract.schema.output)}`
        ]
      : []),
    `          evidence-dir: ${JSON.stringify(contract.evidenceDir)}`,
    `          annotations: ${contract.annotations ? "true" : "false"}`,
    `          fail-on: ${contract.mode === "report" ? "advisory" : "blocking"}`
  );
}

function renderContractCondition(contract: NormalizedGitHubContractConfig): string {
  const manual = `github.event_name == 'workflow_dispatch' && github.event.inputs.job == '${escapeExpressionString(contract.job)}'`;
  if (contract.mode === "release") {
    return `(github.event_name == 'release' && github.event.action == 'published') || (${manual})`;
  }
  return `(github.event_name == 'pull_request' && github.event.pull_request.draft == false) || (${manual})`;
}

function renderHygieneJob(lines: string[], model: ReturnType<typeof buildRenderModel>): void {
  const hygiene = model.hygiene;
  lines.push(
    `  ${yamlKey(hygiene.job)}:`,
    `    name: ${hygiene.job}`,
    `    if: ${renderHygieneCondition(model)}`,
    "    runs-on: ubuntu-latest",
    "    permissions:",
    "      contents: read",
    "    steps:",
    "      - name: Checkout",
    `        uses: ${CHECKOUT_ACTION}`,
    "",
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
  renderHygieneActionStep(lines, hygiene);
  renderEvidenceCollectStep(lines, model, { extraPaths: [hygiene.evidenceDir] });
  lines.push("");
}

function renderHygieneActionStep(lines: string[], hygiene: NormalizedGitHubHygieneConfig): void {
  lines.push(
    "",
    "      - name: Run hygiene evidence",
    `        uses: ${ASYNC_HYGIENE_ACTION}`,
    "        with:",
    `          mode: ${hygiene.mode}`,
    `          profiles: ${JSON.stringify(hygiene.profiles.join(","))}`,
    `          package-path: ${JSON.stringify(hygiene.packagePath)}`,
    `          evidence-dir: ${JSON.stringify(hygiene.evidenceDir)}`,
    `          annotations: ${hygiene.annotations ? "true" : "false"}`,
    `          fail-on: ${hygiene.mode === "report" ? "generated-policy" : "blocking"}`,
    `          release-gate: ${hygiene.releaseGate ? "true" : "false"}`
  );
}

function renderHygieneCondition(model: ReturnType<typeof buildRenderModel>): string {
  const hygiene = model.hygiene;
  const manualJobs = hygieneManualJobIds(model);
  const manual = manualJobs.length === 1
    ? `github.event_name == 'workflow_dispatch' && github.event.inputs.job == '${escapeExpressionString(manualJobs[0] ?? hygiene.job)}'`
    : `github.event_name == 'workflow_dispatch' && (${manualJobs.map((jobId) => `github.event.inputs.job == '${escapeExpressionString(jobId)}'`).join(" || ")})`;
  const release = "github.event_name == 'release' && github.event.action == 'published'";
  if (hygiene.mode === "release") {
    return `(${release}) || (${manual})`;
  }
  const pullRequest = "github.event_name == 'pull_request' && github.event.pull_request.draft == false";
  if (hygiene.releaseGate) {
    return `(${pullRequest}) || (${release}) || (${manual})`;
  }
  return `(${pullRequest}) || (${manual})`;
}

function hygieneTriggers(hygiene: NormalizedGitHubHygieneConfig): string[] {
  const triggers = new Set<string>(["workflow_dispatch"]);
  if (hygiene.mode !== "release") triggers.add("pull_request");
  if (hygiene.mode === "release" || hygiene.releaseGate) triggers.add("release");
  return [...triggers].sort((left, right) => left.localeCompare(right));
}

function hygieneManualJobIds(model: ReturnType<typeof buildRenderModel>): string[] {
  const ids = new Set<string>([model.hygiene.job]);
  if (hygieneReleaseGateEnabled(model.hygiene)) {
    for (const job of model.jobs) {
      if (jobRunsOnRelease(job)) ids.add(job.id);
    }
  }
  return [...ids].sort((left, right) => left.localeCompare(right));
}

function releaseGateNeeds(model: ReturnType<typeof buildRenderModel>, job: ReturnType<typeof buildRenderModel>["jobs"][number]): string[] {
  if (!model.hygiene.enabled || !hygieneReleaseGateEnabled(model.hygiene) || !jobRunsOnRelease(job)) return [];
  return [model.hygiene.job];
}

function hygieneReleaseGateEnabled(hygiene: NormalizedGitHubHygieneConfig): boolean {
  return hygiene.releaseGate || hygiene.mode === "release";
}

function jobRunsOnRelease(job: ReturnType<typeof buildRenderModel>["jobs"][number]): boolean {
  return Boolean(job.if?.includes("github.event_name == 'release'"));
}

function renderEvidenceFanInJob(lines: string[], model: ReturnType<typeof buildRenderModel>): void {
  const needs = evidenceProducerJobIds(model);
  if (needs.length === 0) return;
  const evidence = model.evidence;
  lines.push(
    `  ${yamlKey(evidence.job)}:`,
    `    name: ${evidence.job}`,
    `    needs: ${JSON.stringify(needs)}`,
    "    if: always()",
    "    runs-on: ubuntu-latest",
    "    permissions:",
    "      contents: read",
    "    steps:",
    "      - name: Merge evidence manifests",
    `        uses: ${ASYNC_EVIDENCE_ACTION}`,
    "        with:",
    "          mode: merge",
    `          artifact-pattern: ${evidence.artifactNamePrefix}-*`,
    "          manifest-path: .async/evidence/index.json",
    "          summary-path: .async/evidence/index.md",
    `          artifact-name: ${evidence.artifactNamePrefix}-index`,
    `          retention-days: ${evidence.retentionDays}`,
    `          if-no-files-found: ${evidence.ifNoFilesFound}`,
    `          include-summary: ${evidence.includeSummary ? "true" : "false"}`,
    ""
  );
}

function evidenceProducerJobIds(model: ReturnType<typeof buildRenderModel>): string[] {
  const ids = new Set(model.jobs.map((job) => job.id));
  for (const sourceJob of model.sourceImpactJobs) {
    ids.add(sourceJob.planJob);
    ids.add(sourceJob.matrixJob);
  }
  if (model.pages.enabled) ids.add(model.pages.job);
  if (model.packagePreviews.enabled) ids.add("package-preview");
  if (model.bridge.actionsJob.enabled) ids.add(model.bridge.job);
  if (model.contract.enabled) ids.add(model.contract.job);
  if (model.hygiene.enabled) ids.add(model.hygiene.job);
  ids.delete(model.evidence.job);
  return [...ids].sort((left, right) => left.localeCompare(right));
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
