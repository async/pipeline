import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import type {
  DeployDefinition,
  CloudflareRunnerCommandPlan,
  NormalizedCloudflareSyncConfig,
  NormalizedJob,
  NormalizedPipeline,
  PipelineCloudflareEvent,
  PipelineCloudflareResult,
  PipelineEventEnvelope,
  PipelineWorkflowEventName,
  PipelineWorkflowEventSource,
  PipelineWorkflowJobPlan,
  PipelineWorkflowLifecycleStepKind,
  PipelineWorkflowPlan,
  PipelineWorkflowTrustPolicy,
  ReportDefinition
} from "@async/pipeline-core";
import { pipelineError } from "@async/pipeline-core";
import { jobsForGitHubEvent, type GitHubEventContext } from "./github.js";

const CLOUDFLARE_SYNC_GENERATOR_VERSION = 1;

export interface CloudflareSyncOptions {
  cwd: string;
  configPath: string;
}

export interface CloudflareRenderedFile {
  path: string;
  contents: string;
}

export interface CloudflareSyncJob {
  id: string;
  target: string[];
  trigger: string[];
  execution: string;
  runner: CloudflareRunnerCommandPlan;
  deploy?: DeployDefinition;
  report?: ReportDefinition;
}

export interface CloudflareSyncPlan {
  version: 1;
  generatedBy: "@async/pipeline";
  config: string;
  lifecycle: PipelineWorkflowLifecycleStepKind[];
  worker: string;
  queue: string;
  workflow: string;
  outputDir: string;
  capabilities: NormalizedCloudflareSyncConfig["capabilities"];
  runner: NormalizedCloudflareSyncConfig["runner"];
  cache: NormalizedCloudflareSyncConfig["cache"];
  bridge: NormalizedCloudflareSyncConfig["bridge"];
  apply: {
    mode: "external";
    command: string;
    wranglerConfig: string;
    requiresHostCredentials: true;
  };
  capabilityManifest: {
    version: 1;
    runner: NormalizedCloudflareSyncConfig["runner"];
    cache: NormalizedCloudflareSyncConfig["cache"];
    available: NormalizedCloudflareSyncConfig["capabilities"];
    jobs: CloudflareRunnerCommandPlan[];
  };
  jobs: CloudflareSyncJob[];
}

export interface CloudflareSyncLock {
  version: number;
  generator: string;
  config: string;
  files: string[];
  hash: string;
  generatedAt: string;
  plan: CloudflareSyncPlan;
}

export interface CloudflareSyncRenderResult {
  enabled: boolean;
  lockPath: string;
  plan: CloudflareSyncPlan;
  lock: CloudflareSyncLock;
  files: CloudflareRenderedFile[];
}

export type CloudflareWorkflowMockMode = "mock";

export interface CloudflareWorkflowPlanOptions extends CloudflareSyncOptions {
  job?: string;
  event?: PipelineWorkflowEventName | "workflow_dispatch" | "pull_request_target";
  source?: PipelineWorkflowEventSource;
  action?: string;
  ref?: string;
  branch?: string;
  sha?: string;
  repository?: string;
  owner?: string;
  repo?: string;
  installationId?: number;
  pullRequestNumber?: number;
  pullRequestHeadSha?: string;
  pullRequestHeadRepo?: string;
  sameRepository?: boolean;
  releaseTag?: string;
  releaseAction?: string;
  requestedJob?: string;
}

export interface CloudflareWorkflowPlanResult extends PipelineWorkflowPlan {
  host: "cloudflare";
  sync: CloudflareSyncPlan;
  bridge: CloudflareBridgePlan;
}

export interface CloudflareBridgeReportPlan {
  job: string;
  idempotencyKey: string;
  result: PipelineCloudflareResult;
  writeAllowed: boolean;
  github: {
    check: {
      name: string;
      sha: string;
      status: PipelineCloudflareResult["status"];
      conclusion: "success" | "failure" | "cancelled" | "neutral" | null;
      externalId: string;
    };
    deployment?: {
      environment: string;
      kind: "pages" | "worker";
      sourcePath: string;
      urlAlias?: string;
      sha: string;
      ref: string;
      transientEnvironment: boolean;
      externalId: string;
    };
    prComment?: {
      number: number;
      marker: string;
      mode: "upsert";
      externalId: string;
    };
  };
}

export interface CloudflareBridgePlan {
  enabled: boolean;
  mode: NormalizedCloudflareSyncConfig["bridge"]["mode"];
  queueMessage: PipelineCloudflareEvent | null;
  reports: CloudflareBridgeReportPlan[];
}

export type CloudflareWorkflowEffectStatus = "mocked" | "skipped_untrusted";

export interface CloudflareWorkflowEffectReceipt {
  kind: "deploy" | "report";
  host: "cloudflare" | "github";
  status: CloudflareWorkflowEffectStatus;
  idempotencyKey: string;
  receiptPath: string;
  network: "mock";
  effect: DeployDefinition | ReportDefinition;
  sourcePath?: string;
  sourceExists?: boolean;
  preview?: PipelineCloudflareResult["preview"];
}

export interface CloudflareWorkflowRunReceipt {
  job: string;
  status: "passed" | "planned";
  dryRun: boolean;
  mode: CloudflareWorkflowMockMode;
  idempotencyKey: string;
  stateDirectory: string;
  receiptPath?: string;
  lifecycle: PipelineWorkflowLifecycleStepKind[];
  trust: PipelineWorkflowTrustPolicy;
  effects: CloudflareWorkflowEffectReceipt[];
  issues: string[];
}

export interface CloudflareWorkflowRunResult {
  status: "passed" | "planned" | "skipped";
  plan: CloudflareWorkflowPlanResult;
  bridge?: {
    eventPath?: string;
    reports: Array<{
      job: string;
      resultPath?: string;
      reportPath?: string;
    }>;
  };
  runner?: {
    plans: Array<{
      job: string;
      path: string;
    }>;
  };
  receipts: CloudflareWorkflowRunReceipt[];
}

export async function renderCloudflareSync(pipeline: NormalizedPipeline, options: CloudflareSyncOptions): Promise<CloudflareSyncRenderResult> {
  const config = pipeline.sync.cloudflare;
  const configPath = relativePath(options.cwd, options.configPath);
  const plan = buildCloudflarePlan(pipeline, config, configPath);
  const files = config.enabled ? renderCloudflareFiles(plan) : [];
  const lockInput = {
    version: CLOUDFLARE_SYNC_GENERATOR_VERSION,
    config: configPath,
    files: files.map((file) => ({ path: file.path, hash: hashText(file.contents) })),
    plan
  };
  const lock: CloudflareSyncLock = {
    version: CLOUDFLARE_SYNC_GENERATOR_VERSION,
    generator: "@async/pipeline",
    config: configPath,
    files: files.map((file) => file.path),
    hash: hashJson(lockInput),
    generatedAt: new Date().toISOString(),
    plan
  };
  return {
    enabled: config.enabled,
    lockPath: config.lock,
    plan,
    lock,
    files
  };
}

export async function writeCloudflareSync(result: CloudflareSyncRenderResult, cwd: string): Promise<void> {
  if (!result.enabled) {
    throw pipelineError("ASYNC_PIPELINE_SYNC_NOT_CONFIGURED", "Cloudflare sync is not configured.");
  }
  for (const file of result.files) {
    const target = resolve(cwd, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.contents, "utf8");
  }
  const lockFile = resolve(cwd, result.lockPath);
  await mkdir(dirname(lockFile), { recursive: true });
  await writeFile(lockFile, `${JSON.stringify(result.lock, null, 2)}\n`, "utf8");
}

export async function checkCloudflareSync(
  result: CloudflareSyncRenderResult,
  cwd: string,
  options: { requireConfigured?: boolean } = {}
): Promise<string[]> {
  if (!result.enabled) {
    return options.requireConfigured ? ["Cloudflare sync is not configured. Add sync.cloudflare to pipeline.ts."] : [];
  }

  const issues: string[] = [];
  for (const file of result.files) {
    const target = resolve(cwd, file.path);
    if (!existsSync(target)) {
      issues.push(`Missing Cloudflare sync file ${file.path}. Run async-pipeline sync cloudflare generate.`);
      continue;
    }
    const existing = await readFile(target, "utf8");
    if (normalizeLineEndings(existing) !== normalizeLineEndings(file.contents)) {
      issues.push(`Cloudflare sync file ${file.path} is stale. Run async-pipeline sync cloudflare generate.`);
    }
  }

  const lockFile = resolve(cwd, result.lockPath);
  if (!existsSync(lockFile)) {
    issues.push(`Missing Cloudflare sync lock ${result.lockPath}. Run async-pipeline sync cloudflare generate.`);
  } else {
    const existingLock = JSON.parse(await readFile(lockFile, "utf8")) as CloudflareSyncLock;
    if (existingLock.hash !== result.lock.hash || existingLock.config !== result.lock.config) {
      issues.push(`Cloudflare sync lock ${result.lockPath} is stale. Run async-pipeline sync cloudflare generate.`);
    }
  }

  return issues;
}

export function describeCloudflareSync(result: CloudflareSyncRenderResult): string[] {
  if (!result.enabled) return ["Cloudflare sync is not configured."];
  return [
    `Cloudflare lock: ${result.lockPath}`,
    `Cloudflare worker: ${result.plan.worker}`,
    `Cloudflare queue: ${result.plan.queue}`,
    `Cloudflare workflow: ${result.plan.workflow}`,
    `Cloudflare files: ${result.files.map((file) => file.path).join(", ")}`,
    `Cloudflare jobs: ${result.plan.jobs.map((job) => job.id).join(", ") || "none"}`
  ];
}

export async function planCloudflareWorkflow(
  pipeline: NormalizedPipeline,
  options: CloudflareWorkflowPlanOptions
): Promise<CloudflareWorkflowPlanResult> {
  const rendered = await renderCloudflareSync(pipeline, options);
  if (!rendered.enabled) {
    throw pipelineError("ASYNC_PIPELINE_SYNC_NOT_CONFIGURED", "Cloudflare sync is not configured. Add sync.cloudflare to pipeline.ts.");
  }

  const event = eventEnvelopeFromOptions(options);
  const eventSelectedJobs = new Set(jobsForGitHubEvent(pipeline, eventContextFromEnvelope(event)).map((job) => job.id));
  const candidates = cloudflareJobs(pipeline).map((job) => {
    const selected = eventSelectedJobs.has(job.id);
    return {
      job,
      selected,
      reason: selected ? "" : skipReasonForCloudflareJob(event, job.trigger)
    };
  });
  const selected = options.job
    ? candidates.filter((candidate) => candidate.job.id === options.job)
    : candidates.filter((candidate) => candidate.selected);
  if (options.job && selected.length === 0) {
    const knownJob = pipeline.jobs[options.job];
    const knownProfile = knownJob?.execution ? pipeline.execution[knownJob.execution] : undefined;
    const reason = knownJob && knownProfile?.kind !== "cloudflare"
      ? `Job "${options.job}" does not use a Cloudflare execution profile.`
      : `Unknown Cloudflare job "${options.job}".`;
    throw pipelineError("ASYNC_PIPELINE_CLOUDFLARE_PLAN_UNKNOWN_JOB", reason);
  }

  const selectedIds = new Set(selected.map((candidate) => candidate.job.id));
  const workflowJobs = selected.map((candidate) => workflowJobPlan(pipeline, candidate.job, event));
  return {
    version: 1,
    generatedBy: "@async/pipeline",
    host: "cloudflare",
    pipeline: pipeline.name,
    sync: rendered.plan,
    event,
    lifecycle: rendered.plan.lifecycle,
    jobs: workflowJobs,
    skippedJobs: candidates
      .filter((candidate) => !selectedIds.has(candidate.job.id))
      .map((candidate) => ({
        id: candidate.job.id,
        reason: candidate.reason || (options.job ? "job_filter" : "event_filter"),
        trigger: candidate.job.trigger
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    bridge: buildBridgePlan(rendered.plan, event, workflowJobs, options)
  };
}

export async function runCloudflareWorkflowMock(
  pipeline: NormalizedPipeline,
  options: CloudflareWorkflowPlanOptions & { dryRun?: boolean; mode?: CloudflareWorkflowMockMode }
): Promise<CloudflareWorkflowRunResult> {
  const mode = options.mode ?? "mock";
  if (mode !== "mock") {
    throw pipelineError("ASYNC_PIPELINE_CLOUDFLARE_RUN_UNSUPPORTED", "Cloudflare workflow run currently supports --mode mock only.");
  }
  const plan = await planCloudflareWorkflow(pipeline, options);
  if (plan.jobs.length === 0) return { status: "skipped", plan, receipts: [] };

  const dryRun = options.dryRun ?? false;
  const receipts: CloudflareWorkflowRunReceipt[] = [];
  for (const job of plan.jobs) {
    receipts.push(await runCloudflareMockJob(job, options.cwd, { dryRun, event: plan.event }));
  }
  const bridge = options.dryRun ? undefined : await writeCloudflareBridgeReceipts(plan, options.cwd);
  const runner = options.dryRun ? undefined : await writeCloudflareRunnerPlans(plan, options.cwd);
  return {
    status: dryRun ? "planned" : "passed",
    plan,
    ...(bridge ? { bridge } : {}),
    ...(runner ? { runner } : {}),
    receipts
  };
}

function buildCloudflarePlan(
  pipeline: NormalizedPipeline,
  config: NormalizedCloudflareSyncConfig,
  configPath: string
): CloudflareSyncPlan {
  const jobs = cloudflareJobs(pipeline, config);
  const wranglerConfig = joinPath(config.outputDir.replace(/\/+$/u, ""), "wrangler.jsonc");
  return {
    version: 1,
    generatedBy: "@async/pipeline",
    config: configPath,
    lifecycle: ["plan", "render", "check", "run", "deploy", "report", "record"],
    worker: config.worker,
    queue: config.queue,
    workflow: config.workflow,
    outputDir: config.outputDir,
    capabilities: { ...config.capabilities },
    runner: { ...config.runner },
    cache: { ...config.cache },
    bridge: { ...config.bridge },
    apply: {
      mode: "external",
      command: `wrangler deploy --config ${shellWord(wranglerConfig)}`,
      wranglerConfig,
      requiresHostCredentials: true
    },
    capabilityManifest: {
      version: 1,
      runner: { ...config.runner },
      cache: { ...config.cache },
      available: { ...config.capabilities },
      jobs: jobs.map((job) => job.runner)
    },
    jobs
  };
}

function cloudflareJobs(pipeline: NormalizedPipeline, config?: NormalizedCloudflareSyncConfig): CloudflareSyncJob[] {
  const jobs: CloudflareSyncJob[] = [];
  const syncConfig = config ?? pipeline.sync.cloudflare;
  for (const job of Object.values(pipeline.jobs).sort((left, right) => left.id.localeCompare(right.id))) {
    const profile = job.execution ? pipeline.execution[job.execution] : undefined;
    if (profile?.kind !== "cloudflare") continue;
    jobs.push(renderPlanJob(pipeline, syncConfig, job));
  }
  return jobs;
}

function renderPlanJob(
  pipeline: NormalizedPipeline,
  config: NormalizedCloudflareSyncConfig,
  job: NormalizedJob
): CloudflareSyncJob {
  return {
    id: job.id,
    target: [...job.target],
    trigger: [...job.trigger],
    execution: job.execution ?? "cloudflare",
    runner: runnerCommandPlan(pipeline, config, job),
    ...(job.deploy === undefined ? {} : { deploy: job.deploy }),
    ...(job.report === undefined ? {} : { report: job.report })
  };
}

function runnerCommandPlan(
  pipeline: NormalizedPipeline,
  config: NormalizedCloudflareSyncConfig,
  job: NormalizedJob
): CloudflareRunnerCommandPlan {
  const stateDirectory = `.async/cloudflare-local/jobs/${safePathPart(job.id)}`;
  const capabilities = {
    github: {
      required: Boolean(job.report?.kind.startsWith("github.") || config.bridge.enabled),
      enabled: config.capabilities.github
    },
    cloudflare: {
      required: Boolean(job.deploy?.kind.startsWith("cloudflare.")),
      enabled: config.capabilities.cloudflare
    },
    artifacts: {
      required: true,
      enabled: config.capabilities.artifacts
    }
  };
  return {
    job: job.id,
    execution: job.execution ?? "cloudflare",
    command: `${shellWord(pipeline.sync.command)} run ${shellWord(job.id)} --execution ${shellWord(job.execution ?? "cloudflare")}`,
    cwd: ".",
    runner: { ...config.runner },
    cache: { ...config.cache },
    capabilities,
    permissions: runnerPermissions(capabilities),
    evidence: {
      runPath: `${stateDirectory}/receipt.json`,
      resultPath: `${stateDirectory}/result.json`,
      cacheNamespace: config.cache.namespace
    },
    mockAvailable: true
  };
}

function runnerPermissions(capabilities: CloudflareRunnerCommandPlan["capabilities"]): string[] {
  const permissions = ["runner.exec"];
  if (capabilities.github.required) permissions.push("github.report");
  if (capabilities.cloudflare.required) permissions.push("cloudflare.deploy");
  if (capabilities.artifacts.required) permissions.push("artifacts.readWrite");
  return permissions;
}

function shellWord(value: string): string {
  if (/^[A-Za-z0-9_./:@=-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function eventEnvelopeFromOptions(options: CloudflareWorkflowPlanOptions): PipelineEventEnvelope {
  const event = normalizeWorkflowEvent(options.event ?? "manual");
  const source = options.source ?? "github";
  if (source !== "github" && source !== "cloudflare") {
    throw pipelineError("ASYNC_PIPELINE_CLOUDFLARE_EVENT_INVALID", `Cloudflare workflow event source must be "github" or "cloudflare". Found: ${String(source)}.`);
  }
  return {
    source,
    event,
    ...(options.ref ? { ref: options.ref } : {}),
    ...(options.branch ? { branch: options.branch } : {}),
    ...(options.sha ? { sha: options.sha } : {}),
    ...(options.pullRequestNumber !== undefined || options.pullRequestHeadSha !== undefined || options.sameRepository !== undefined
      ? {
          pullRequest: {
            number: options.pullRequestNumber ?? 0,
            headSha: options.pullRequestHeadSha ?? options.sha ?? "",
            sameRepository: options.sameRepository ?? false
          }
        }
      : {}),
    ...(options.releaseTag !== undefined || options.releaseAction !== undefined
      ? {
          release: {
            tagName: options.releaseTag ?? "",
            action: options.releaseAction ?? options.action ?? ""
          }
        }
      : {}),
    ...(options.requestedJob ?? options.job ? { requestedJob: options.requestedJob ?? options.job } : {})
  };
}

function normalizeWorkflowEvent(event: CloudflareWorkflowPlanOptions["event"]): PipelineWorkflowEventName {
  if (event === "workflow_dispatch") return "manual";
  if (event === "pull_request_target") return "pull_request";
  if (event === "push" || event === "pull_request" || event === "release" || event === "schedule" || event === "manual") return event;
  throw pipelineError("ASYNC_PIPELINE_CLOUDFLARE_EVENT_INVALID", `Unsupported Cloudflare workflow event "${String(event)}".`);
}

function eventContextFromEnvelope(event: PipelineEventEnvelope): GitHubEventContext {
  return {
    eventName: githubEventName(event),
    action: event.release?.action,
    ref: event.ref ?? (event.branch ? `refs/heads/${event.branch}` : undefined),
    baseRef: event.branch,
    schedule: event.event === "schedule" ? event.ref : undefined,
    selectedJob: event.requestedJob,
    payload: {
      source: event.source,
      event: event.event,
      ref: event.ref,
      branch: event.branch,
      sha: event.sha,
      pullRequest: event.pullRequest,
      release: event.release,
      requestedJob: event.requestedJob
    }
  };
}

function githubEventName(event: PipelineEventEnvelope): string {
  if (event.event === "manual") return "workflow_dispatch";
  return event.event;
}

function skipReasonForCloudflareJob(event: PipelineEventEnvelope, trigger: string[]): string {
  if (event.requestedJob) return "job_filter";
  if (trigger.length === 0) return "no_trigger";
  return "event_filter";
}

function workflowJobPlan(
  pipeline: NormalizedPipeline,
  job: CloudflareSyncJob,
  event: PipelineEventEnvelope
): PipelineWorkflowJobPlan {
  const stateDirectory = `.async/cloudflare-local/jobs/${safePathPart(job.id)}`;
  const idempotencyKey = workflowId(pipeline.name, job.id, event);
  const effects = workflowEffects(job, idempotencyKey, stateDirectory);
  return {
    id: job.id,
    target: [...job.target],
    trigger: [...job.trigger],
    execution: job.execution,
    lifecycle: [
      "plan",
      "run",
      ...(job.deploy ? ["deploy" as const] : []),
      ...(job.report ? ["report" as const] : []),
      "record"
    ],
    idempotencyKey,
    trust: trustPolicyForEvent(event),
    effects,
    receipts: {
      run: `${stateDirectory}/receipt.json`,
      ...(job.deploy ? { deploy: `${stateDirectory}/deploy.json` } : {}),
      ...(job.report ? { report: `${stateDirectory}/report.json` } : {})
    }
  };
}

function workflowEffects(job: CloudflareSyncJob, idempotencyKey: string, stateDirectory: string): PipelineWorkflowJobPlan["effects"] {
  const effects: PipelineWorkflowJobPlan["effects"] = [];
  if (job.deploy) {
    effects.push({
      kind: "deploy",
      host: "cloudflare",
      effect: job.deploy,
      idempotencyKey,
      receiptPath: `${stateDirectory}/deploy.json`,
      network: "mock"
    });
  }
  if (job.report) {
    effects.push({
      kind: "report",
      host: "github",
      effect: job.report,
      idempotencyKey,
      receiptPath: `${stateDirectory}/report.json`,
      network: "mock"
    });
  }
  return effects;
}

function buildBridgePlan(
  sync: CloudflareSyncPlan,
  event: PipelineEventEnvelope,
  jobs: PipelineWorkflowJobPlan[],
  options: CloudflareWorkflowPlanOptions
): CloudflareBridgePlan {
  const queueMessage = sync.bridge.enabled && event.source === "github"
    ? cloudflareQueueEvent(event, options)
    : null;
  return {
    enabled: sync.bridge.enabled,
    mode: sync.bridge.mode,
    queueMessage,
    reports: queueMessage ? jobs.map((job) => bridgeReportPlan(job, queueMessage, event)) : []
  };
}

function cloudflareQueueEvent(event: PipelineEventEnvelope, options: CloudflareWorkflowPlanOptions): PipelineCloudflareEvent {
  const repository = repositoryParts(options);
  const sha = event.pullRequest?.headSha || event.sha || "";
  return {
    source: "github",
    event: bridgeEventName(event),
    owner: repository.owner,
    repo: repository.repo,
    sha,
    ref: event.ref ?? (event.branch ? `refs/heads/${event.branch}` : event.release?.tagName ? `refs/tags/${event.release.tagName}` : ""),
    ...(event.branch ? { branch: event.branch } : {}),
    ...(event.pullRequest
      ? {
          pullRequest: {
            number: event.pullRequest.number,
            headSha: event.pullRequest.headSha,
            headRepoFullName: options.pullRequestHeadRepo ?? options.repository ?? `${repository.owner}/${repository.repo}`,
            sameRepository: event.pullRequest.sameRepository
          }
        }
      : {}),
    ...(event.release ? { release: { ...event.release } } : {}),
    ...(options.installationId === undefined ? {} : { installationId: options.installationId }),
    ...(event.requestedJob ? { requestedJob: event.requestedJob } : {})
  };
}

function bridgeEventName(event: PipelineEventEnvelope): PipelineCloudflareEvent["event"] {
  if (event.event === "manual" || event.event === "schedule") return "workflow_dispatch";
  return event.event;
}

function repositoryParts(options: CloudflareWorkflowPlanOptions): { owner: string; repo: string } {
  if (options.owner && options.repo) return { owner: options.owner, repo: options.repo };
  const repository = options.repository;
  if (repository) {
    const [owner, repo] = repository.split("/");
    if (owner && repo) return { owner, repo };
  }
  return { owner: "unknown", repo: "unknown" };
}

function bridgeReportPlan(
  job: PipelineWorkflowJobPlan,
  queueMessage: PipelineCloudflareEvent,
  event: PipelineEventEnvelope
): CloudflareBridgeReportPlan {
  const result = cloudflareResultEnvelope(job, queueMessage, event);
  const deployEffect = job.effects.find((effect) => effect.kind === "deploy");
  const reportEffect = job.effects.find((effect) => effect.kind === "report");
  const deploy = deployEffect?.effect as DeployDefinition | undefined;
  const report = reportEffect?.effect as ReportDefinition | undefined;
  const preview = deploy ? previewResult(deploy, event) : undefined;
  return {
    job: job.id,
    idempotencyKey: job.idempotencyKey,
    result,
    writeAllowed: job.trust.writeCredentials,
    github: {
      check: {
        name: `async/pipeline:${job.id}`,
        sha: result.sha,
        status: result.status,
        conclusion: null,
        externalId: `${job.idempotencyKey}/check`
      },
      ...(deployEffect
        ? {
            deployment: {
              environment: deploymentEnvironment(deploy as DeployDefinition, report, event),
              kind: preview?.kind ?? "pages",
              sourcePath: deploySourcePath(deploy as DeployDefinition),
              ...(preview?.urlAlias ? { urlAlias: preview.urlAlias } : {}),
              sha: result.sha,
              ref: queueMessage.ref,
              transientEnvironment: preview?.environment === "preview",
              externalId: `${job.idempotencyKey}/deployment`
            }
          }
        : {}),
      ...(shouldPlanPrComment(report, queueMessage)
        ? {
            prComment: {
              number: queueMessage.pullRequest.number,
              marker: `async-pipeline-preview:${job.id}`,
              mode: "upsert" as const,
              externalId: `${job.idempotencyKey}/comment`
            }
          }
        : {})
    }
  };
}

function cloudflareResultEnvelope(
  job: PipelineWorkflowJobPlan,
  queueMessage: PipelineCloudflareEvent,
  event: PipelineEventEnvelope
): PipelineCloudflareResult {
  const deployEffect = job.effects.find((effect) => effect.kind === "deploy");
  return {
    job: job.id,
    status: "queued",
    sha: queueMessage.sha,
    evidence: {
      manifestPath: job.receipts.run,
      summaryPath: `${dirname(job.receipts.run)}/summary.md`
    },
    ...(deployEffect ? { preview: previewResult(deployEffect.effect as DeployDefinition, event) } : {})
  };
}

function previewResult(deploy: DeployDefinition, event: PipelineEventEnvelope): PipelineCloudflareResult["preview"] {
  const environment = previewEnvironment(deploy, event);
  if (deploy.kind === "cloudflare.pages") {
    return {
      kind: "pages",
      environment,
      urlAlias: deploy.project
    };
  }
  return {
    kind: "worker",
    environment,
    urlAlias: deploy.alias
  };
}

function previewEnvironment(deploy: DeployDefinition, event: PipelineEventEnvelope): "preview" | "production" {
  const productionBranch = deploy.productionBranch;
  if (event.event !== "pull_request" && productionBranch && event.branch === productionBranch) return "production";
  return "preview";
}

function deploymentEnvironment(
  deploy: DeployDefinition,
  report: ReportDefinition | undefined,
  event: PipelineEventEnvelope
): string {
  if (report?.kind === "github.deployment" && report.environment) return report.environment;
  return previewEnvironment(deploy, event);
}

function shouldPlanPrComment(
  report: ReportDefinition | undefined,
  queueMessage: PipelineCloudflareEvent
): queueMessage is PipelineCloudflareEvent & { pullRequest: NonNullable<PipelineCloudflareEvent["pullRequest"]> } {
  return report?.kind === "github.prPreview" && report.comment !== false && queueMessage.pullRequest !== undefined;
}

function deploySourcePath(deploy: DeployDefinition): string {
  return deploy.kind === "cloudflare.pages" ? deploy.directory : deploy.script;
}

async function writeCloudflareBridgeReceipts(
  plan: CloudflareWorkflowPlanResult,
  cwd: string
): Promise<NonNullable<CloudflareWorkflowRunResult["bridge"]>> {
  const bridgeDir = ".async/cloudflare-local/bridge";
  const eventPath = plan.bridge.queueMessage ? `${bridgeDir}/event.json` : undefined;
  if (plan.bridge.queueMessage && eventPath) {
    const eventFile = resolve(cwd, eventPath);
    await mkdir(dirname(eventFile), { recursive: true });
    await writeFile(eventFile, `${JSON.stringify(plan.bridge.queueMessage, null, 2)}\n`, "utf8");
  }
  const reports: NonNullable<CloudflareWorkflowRunResult["bridge"]>["reports"] = [];
  for (const report of plan.bridge.reports) {
    const job = plan.jobs.find((entry) => entry.id === report.job);
    if (!job) continue;
    const stateDir = dirname(job.receipts.run);
    const resultPath = `${stateDir}/result.json`;
    const reportPath = `${stateDir}/github-report.json`;
    await writeFile(resolve(cwd, resultPath), `${JSON.stringify(report.result, null, 2)}\n`, "utf8");
    await writeFile(resolve(cwd, reportPath), `${JSON.stringify({
      idempotencyKey: report.idempotencyKey,
      writeAllowed: report.writeAllowed,
      github: report.github
    }, null, 2)}\n`, "utf8");
    reports.push({ job: report.job, resultPath, reportPath });
  }
  return {
    ...(eventPath ? { eventPath } : {}),
    reports
  };
}

async function writeCloudflareRunnerPlans(
  plan: CloudflareWorkflowPlanResult,
  cwd: string
): Promise<NonNullable<CloudflareWorkflowRunResult["runner"]>> {
  const plans: NonNullable<CloudflareWorkflowRunResult["runner"]>["plans"] = [];
  for (const job of plan.sync.jobs) {
    const stateDir = `.async/cloudflare-local/jobs/${safePathPart(job.id)}`;
    const path = `${stateDir}/runner.json`;
    const target = resolve(cwd, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(job.runner, null, 2)}\n`, "utf8");
    plans.push({ job: job.id, path });
  }
  return { plans };
}

function trustPolicyForEvent(event: PipelineEventEnvelope): PipelineWorkflowTrustPolicy {
  if (event.event === "pull_request") {
    const sameRepository = event.pullRequest?.sameRepository ?? false;
    return {
      event: event.event,
      sameRepository,
      writeCredentials: sameRepository,
      cacheSave: false,
      reason: sameRepository
        ? "same_repository_pull_request"
        : "fork_pull_request_read_only"
    };
  }
  if (event.event === "release") {
    return {
      event: event.event,
      sameRepository: null,
      writeCredentials: true,
      cacheSave: true,
      reason: "release_event"
    };
  }
  if (event.event === "manual") {
    return {
      event: event.event,
      sameRepository: null,
      writeCredentials: false,
      cacheSave: false,
      reason: "manual_mock_read_only"
    };
  }
  return {
    event: event.event,
    sameRepository: null,
    writeCredentials: true,
    cacheSave: true,
    reason: `${event.event}_event`
  };
}

function workflowId(pipelineName: string, jobId: string, event: PipelineEventEnvelope): string {
  const ref = event.pullRequest?.headSha || event.sha || event.ref || event.branch || event.release?.tagName || event.requestedJob || "manual";
  return [pipelineName, jobId, event.event, ref].map(safeKeyPart).join("/");
}

async function runCloudflareMockJob(
  job: PipelineWorkflowJobPlan,
  cwd: string,
  options: { dryRun: boolean; event: PipelineEventEnvelope }
): Promise<CloudflareWorkflowRunReceipt> {
  const effectReceipts = job.effects.map((effect): CloudflareWorkflowEffectReceipt => {
    const trusted = job.trust.writeCredentials;
    const deploy = effect.kind === "deploy" ? effect.effect as DeployDefinition : undefined;
    const sourceExists = deploy ? deploySourceExists(cwd, deploy) : undefined;
    return {
      kind: effect.kind,
      host: effect.host,
      status: trusted ? "mocked" : "skipped_untrusted",
      idempotencyKey: effect.idempotencyKey,
      receiptPath: effect.receiptPath,
      network: "mock",
      effect: effect.effect,
      ...(deploy ? { sourcePath: deploySourcePath(deploy) } : {}),
      ...(sourceExists === undefined ? {} : { sourceExists }),
      ...(deploy ? { preview: previewResult(deploy, options.event) } : {})
    };
  });
  const receipt: CloudflareWorkflowRunReceipt = {
    job: job.id,
    status: options.dryRun ? "planned" : "passed",
    dryRun: options.dryRun,
    mode: "mock",
    idempotencyKey: job.idempotencyKey,
    stateDirectory: dirname(job.receipts.run),
    lifecycle: [...job.lifecycle],
    trust: job.trust,
    effects: effectReceipts,
    issues: []
  };

  if (!options.dryRun) {
    const stateDir = resolve(cwd, receipt.stateDirectory);
    await mkdir(stateDir, { recursive: true });
    await writeFile(resolve(stateDir, "plan.json"), `${JSON.stringify(job, null, 2)}\n`, "utf8");
    for (const effect of effectReceipts) {
      await writeFile(resolve(cwd, effect.receiptPath), `${JSON.stringify(effect, null, 2)}\n`, "utf8");
    }
    await writeFile(resolve(cwd, job.receipts.run), `${JSON.stringify({ ...receipt, receiptPath: job.receipts.run }, null, 2)}\n`, "utf8");
    receipt.receiptPath = job.receipts.run;
  }

  return receipt;
}

function deploySourceExists(cwd: string, deploy: DeployDefinition): boolean {
  return existsSync(resolve(cwd, deploySourcePath(deploy)));
}

function safePathPart(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]/g, "_") || "job";
}

function safeKeyPart(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._:-]/g, "_") || "unknown";
}

function renderCloudflareFiles(plan: CloudflareSyncPlan): CloudflareRenderedFile[] {
  const outputDir = plan.outputDir.replace(/\/+$/u, "");
  return [
    {
      path: joinPath(outputDir, "worker.ts"),
      contents: renderWorker(plan)
    },
    {
      path: joinPath(outputDir, "workflow.ts"),
      contents: renderWorkflow(plan)
    },
    {
      path: joinPath(outputDir, "queue.ts"),
      contents: renderQueue(plan)
    },
    {
      path: joinPath(outputDir, "wrangler.jsonc"),
      contents: renderWrangler(plan)
    }
  ];
}

function renderWorker(plan: CloudflareSyncPlan): string {
  return `// @async/pipeline cloudflare worker surface\n` +
    `import { startPipelineWorkflow } from "./workflow";\n\n` +
    `export interface Env {\n` +
    `  ${envIdentifier(plan.workflow)}: Workflow;\n` +
    `}\n\n` +
    `export default {\n` +
    `  async queue(batch: MessageBatch, env: Env): Promise<void> {\n` +
    `    for (const message of batch.messages) {\n` +
    `      await startPipelineWorkflow(env, message.body);\n` +
    `      message.ack();\n` +
    `    }\n` +
    `  }\n` +
    `};\n`;
}

function renderWorkflow(plan: CloudflareSyncPlan): string {
  return `// @async/pipeline cloudflare workflow surface\n` +
    `export const pipelineCloudflarePlan = ${JSON.stringify(plan, null, 2)} as const;\n\n` +
    `type PipelineQueueEvent = {\n` +
    `  owner?: string;\n` +
    `  repo?: string;\n` +
    `  event?: string;\n` +
    `  sha?: string;\n` +
    `  requestedJob?: string;\n` +
    `};\n\n` +
    `type PipelineJobPlan = (typeof pipelineCloudflarePlan.jobs)[number];\n\n` +
    `interface WorkflowEvent<Payload> {\n` +
    `  payload: Payload;\n` +
    `}\n\n` +
    `interface WorkflowStep {\n` +
    `  do<T>(name: string, callback: () => Promise<T> | T): Promise<T>;\n` +
    `}\n\n` +
    `declare abstract class WorkflowEntrypoint<Env, Payload> {\n` +
    `  protected readonly env: Env;\n` +
    `  abstract run(event: WorkflowEvent<Payload>, step: WorkflowStep): Promise<unknown>;\n` +
    `}\n\n` +
    `interface PipelineRunnerBinding {\n` +
    `  exec(command: string, options: Record<string, unknown>): Promise<unknown>;\n` +
    `}\n\n` +
    `interface CloudflareDeployBinding {\n` +
    `  deploy(input: Record<string, unknown>): Promise<unknown>;\n` +
    `}\n\n` +
    `interface GitHubReportBinding {\n` +
    `  report(input: Record<string, unknown>): Promise<unknown>;\n` +
    `}\n\n` +
    `interface EvidenceBinding {\n` +
    `  write(input: Record<string, unknown>): Promise<unknown>;\n` +
    `}\n\n` +
    `export interface PipelineWorkflowEnv {\n` +
    `  PIPELINE_RUNNER?: PipelineRunnerBinding;\n` +
    `  PIPELINE_CLOUDFLARE?: CloudflareDeployBinding;\n` +
    `  PIPELINE_GITHUB?: GitHubReportBinding;\n` +
    `  PIPELINE_EVIDENCE?: EvidenceBinding;\n` +
    `}\n\n` +
    `export class PipelineWorkflow extends WorkflowEntrypoint<PipelineWorkflowEnv, PipelineQueueEvent> {\n` +
    `  async run(event: WorkflowEvent<PipelineQueueEvent>, step: WorkflowStep): Promise<void> {\n` +
    `    const payload = event.payload;\n` +
    `    const jobs = selectPipelineJobs(payload);\n` +
    `    await step.do("plan", () => ({ event: payload, jobs: jobs.map((job) => job.id), cache: pipelineCloudflarePlan.cache, apply: pipelineCloudflarePlan.apply }));\n` +
    `    for (const job of jobs) {\n` +
    `      const runResult = await step.do(\`run:\${job.id}\`, () => runPipelineJob(this.env, job));\n` +
    `      if (job.deploy) await step.do(\`deploy:\${job.id}\`, () => deployPipelineJob(this.env, job, runResult));\n` +
    `      if (job.report) await step.do(\`report:\${job.id}\`, () => reportPipelineJob(this.env, job, runResult));\n` +
    `      await step.do(\`record:\${job.id}\`, () => recordPipelineEvidence(this.env, job, runResult));\n` +
    `    }\n` +
    `  }\n` +
    `}\n\n` +
    `export async function startPipelineWorkflow(env: Record<string, unknown>, event: unknown): Promise<void> {\n` +
    `  const workflow = env[${JSON.stringify(envIdentifier(plan.workflow))}] as { create?: (options: { id: string; params: unknown }) => Promise<unknown> } | undefined;\n` +
    `  if (!workflow?.create) throw new Error("Cloudflare Workflow binding is not available.");\n` +
    `  await workflow.create({ id: pipelineWorkflowId(event), params: event });\n` +
    `}\n\n` +
    `function pipelineWorkflowId(event: unknown): string {\n` +
    `  const value = event && typeof event === "object" ? event as Record<string, unknown> : {};\n` +
    `  const id = [value.owner, value.repo, value.event, value.sha, value.requestedJob].filter(Boolean).join("/") || "manual";\n` +
    `  return id.length > 100 ? id.slice(0, 100) : id;\n` +
    `}\n\n` +
    `function selectPipelineJobs(event: PipelineQueueEvent): PipelineJobPlan[] {\n` +
    `  if (event.requestedJob) return pipelineCloudflarePlan.jobs.filter((job) => job.id === event.requestedJob);\n` +
    `  return [...pipelineCloudflarePlan.jobs];\n` +
    `}\n\n` +
    `async function runPipelineJob(env: PipelineWorkflowEnv, job: PipelineJobPlan): Promise<unknown> {\n` +
    `  if (!env.PIPELINE_RUNNER?.exec) throw new Error("PIPELINE_RUNNER binding is not available.");\n` +
    `  return env.PIPELINE_RUNNER.exec(job.runner.command, { cwd: job.runner.cwd, runner: job.runner.runner, cache: job.runner.cache, evidence: job.runner.evidence });\n` +
    `}\n\n` +
    `async function deployPipelineJob(env: PipelineWorkflowEnv, job: PipelineJobPlan, runResult: unknown): Promise<unknown> {\n` +
    `  if (!env.PIPELINE_CLOUDFLARE?.deploy) throw new Error("PIPELINE_CLOUDFLARE binding is not available.");\n` +
    `  return env.PIPELINE_CLOUDFLARE.deploy({ job: job.id, deploy: job.deploy, runResult });\n` +
    `}\n\n` +
    `async function reportPipelineJob(env: PipelineWorkflowEnv, job: PipelineJobPlan, runResult: unknown): Promise<unknown> {\n` +
    `  if (!env.PIPELINE_GITHUB?.report) throw new Error("PIPELINE_GITHUB binding is not available.");\n` +
    `  return env.PIPELINE_GITHUB.report({ job: job.id, report: job.report, runResult });\n` +
    `}\n\n` +
    `async function recordPipelineEvidence(env: PipelineWorkflowEnv, job: PipelineJobPlan, runResult: unknown): Promise<unknown> {\n` +
    `  const evidence = { job: job.id, runResult, paths: job.runner.evidence };\n` +
    `  if (!env.PIPELINE_EVIDENCE?.write) return evidence;\n` +
    `  return env.PIPELINE_EVIDENCE.write(evidence);\n` +
    `}\n`;
}

function renderQueue(plan: CloudflareSyncPlan): string {
  return `// @async/pipeline cloudflare queue surface\n` +
    `export const pipelineQueue = ${JSON.stringify({ queue: plan.queue, worker: plan.worker, bridge: plan.bridge }, null, 2)} as const;\n`;
}

function renderWrangler(plan: CloudflareSyncPlan): string {
  return `${JSON.stringify({
    $schema: "./node_modules/wrangler/config-schema.json",
    name: plan.worker,
    main: "worker.ts",
    compatibility_date: "2026-06-21",
    queues: {
      consumers: [{ queue: plan.queue }]
    },
    workflows: [{
      name: plan.workflow,
      binding: envIdentifier(plan.workflow),
      class_name: "PipelineWorkflow"
    }]
  }, null, 2)}\n`;
}

function envIdentifier(value: string): string {
  return value.toUpperCase().replaceAll(/[^A-Z0-9_]/g, "_");
}

function joinPath(...parts: string[]): string {
  return parts.join("/").replaceAll(/\/+/g, "/");
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/gu, "\n");
}

function hashText(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function hashJson(value: unknown): string {
  return hashText(JSON.stringify(value));
}

function relativePath(cwd: string, path: string): string {
  const relativeFile = relative(cwd, resolve(path));
  if (relativeFile === "") return ".";
  if (relativeFile === ".." || relativeFile.startsWith(`..${sep}`)) {
    throw pipelineError("ASYNC_PIPELINE_SYNC_TARGET_OUTSIDE_ROOT", `Sync path "${path}" must be inside ${cwd}.`);
  }
  return relativeFile;
}
