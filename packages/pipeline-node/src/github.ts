import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type { EnvValue, ExecutionProfileId, GitHubJobConfig, GitHubPagesConfig, JobEnvironment, JobRequirements, JobId, NormalizedJob, NormalizedPipeline, TriggerDefinition, TriggerId } from "@async/pipeline-core";
import { githubConfigForJob, pipelineError } from "@async/pipeline-core";

export const GITHUB_WORKFLOW_PATH = ".github/workflows/async-pipeline.yml";
export const GITHUB_LOCK_PATH = ".github/async-pipeline.lock.json";
const GENERATOR_VERSION = 3;
const DEFAULT_NODE_VERSION = "24";

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
  triggers: Record<string, unknown>;
  jobs: Array<{ id: string; target: string[]; trigger: string[]; env: Record<string, EnvValue>; environment?: JobEnvironment; requires?: JobRequirements; execution?: ExecutionProfileId; github?: GitHubJobConfig; if?: string }>;
  packageManager: string;
  buildCommand?: string;
  nodeVersion: string;
  taskCache: boolean;
  manualDispatchJobs?: string[];
}

export interface GitHubRenderResult {
  workflowPath: string;
  lockPath: string;
  workflow: string;
  lock: GitHubLock;
}

export interface GitHubEventContext {
  eventName: string;
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
    configPath: relativePath(options.cwd, options.configPath),
    workflowPath,
    packageManager: packageInfo.packageManager,
    buildCommand: packageInfo.buildCommand
  });
  const workflow = renderWorkflow(renderModel);
  const hash = hashJson({
    version: GENERATOR_VERSION,
    config: renderModel.configPath,
    workflow: renderModel.workflowPath,
    triggers: renderModel.triggers,
    jobs: renderModel.jobs,
    packageManager: renderModel.packageManager,
    buildCommand: renderModel.buildCommand,
    nodeVersion: renderModel.nodeVersion,
    taskCache: renderModel.taskCache,
    manualDispatchJobs: renderModel.manualDispatchJobs
  });
  const lock: GitHubLock = {
    version: GENERATOR_VERSION,
    generator: "@async/pipeline",
    config: renderModel.configPath,
    workflow: renderModel.workflowPath,
    hash,
    generatedAt: new Date().toISOString(),
    triggers: renderModel.triggers,
    jobs: renderModel.jobs,
    packageManager: renderModel.packageManager,
    buildCommand: renderModel.buildCommand,
    nodeVersion: renderModel.nodeVersion,
    taskCache: renderModel.taskCache,
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

  if (!existsSync(workflowFile)) {
    issues.push(`Missing generated workflow ${result.workflowPath}. Run async-pipeline github generate.`);
  } else {
    const existingWorkflow = await readFile(workflowFile, "utf8");
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

export async function readGitHubEventContext(env: NodeJS.ProcessEnv): Promise<GitHubEventContext> {
  const eventName = env.ASYNC_PIPELINE_GITHUB_EVENT_NAME ?? env.GITHUB_EVENT_NAME ?? "workflow_dispatch";
  const eventPath = env.GITHUB_EVENT_PATH;
  let payload: unknown;
  if (eventPath && existsSync(eventPath)) {
    payload = JSON.parse(await readFile(eventPath, "utf8"));
  }
  return {
    eventName,
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
  options: { configPath: string; workflowPath: string; packageManager: string; buildCommand?: string }
) {
  const usedTriggerIds = new Set<TriggerId>(Object.values(pipeline.jobs).flatMap((job) => job.trigger));
  const usedTriggers = Object.fromEntries([...usedTriggerIds].sort().map((triggerId) => [triggerId, pipeline.triggers[triggerId]]));
  const manualDispatchJobs = Object.values(pipeline.jobs)
    .filter((job) => job.trigger.some((triggerId) => pipeline.triggers[triggerId]?.type === "manual"))
    .map((job) => job.id)
    .sort((left, right) => left.localeCompare(right));
  return {
    name: "Async Pipeline",
    configPath: options.configPath,
    workflowPath: options.workflowPath,
    triggers: normalizeGitHubTriggers(usedTriggers),
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
    packageManager: options.packageManager,
    buildCommand: options.buildCommand,
    nodeVersion: pipeline.sync.github.nodeVersion ?? DEFAULT_NODE_VERSION,
    taskCache: pipeline.sync.github.cache ?? true,
    manualDispatchJobs
  };
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
  return `${lines.join("\n")}`;
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
    "        uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2",
    "",
    ...(model.taskCache
      ? [
          "      - name: Restore task cache",
          "        uses: actions/cache@0057852bfaa89a56745cba8c7296529d2fc39830 # v4",
          "        with:",
          "          path: .async/cache",
          "          key: async-pipeline-${{ runner.os }}-${{ github.sha }}",
          "          restore-keys: |",
          "            async-pipeline-${{ runner.os }}-",
          ""
        ]
      : []),
    "      - name: Setup Node",
    "        uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6",
    "        with:",
    `          node-version: ${model.nodeVersion}`,
    "          registry-url: https://registry.npmjs.org/",
    "          package-manager-cache: false",
    "",
    ...(idToken === "write"
      ? [
          "      - name: Use current npm",
          "        run: npm install -g npm@11.16.0",
          ""
        ]
      : []),
    "      - name: Enable pnpm",
    "        run: |",
    "          corepack enable",
    "          corepack prepare pnpm@10.20.0 --activate",
    "",
    "      - name: Install dependencies",
    `        run: ${model.packageManager} install --frozen-lockfile`
  );
  if (model.buildCommand) {
    lines.push(
      "",
      "      - name: Build pipeline CLI",
      `        run: ${model.buildCommand}`
    );
  }
  lines.push(
    "",
    "      - name: Check generated workflow",
    `        run: ${model.packageManager} async-pipeline github check`,
    "",
    "      - name: Run pipeline job",
    `        run: ${model.packageManager} async-pipeline run ${shellWord(job.id)}${job.execution ? ` --execution ${shellWord(job.execution)}` : ""}`,
    "        env:",
    "          CI: true"
  );
  for (const [name, value] of Object.entries(job.env).sort(([left], [right]) => left.localeCompare(right))) {
    const rendered = renderGitHubEnvValue(value);
    if (rendered !== undefined) {
      lines.push(`          ${name}: ${rendered}`);
    }
  }
  if (job.github?.pages) {
    lines.push("");
    renderPagesBuildSteps(lines, job.github.pages);
  }
  lines.push("");
  renderRunEvidenceSteps(lines, model.packageManager);
  lines.push("");
}

function renderRunEvidenceSteps(lines: string[], packageManager: string): void {
  lines.push(
    "      - name: Explain async-pipeline run",
    "        if: failure()",
    `        run: ${packageManager} async-pipeline explain --run latest || true`,
    "",
    "      - name: Upload async-pipeline run evidence",
    "        if: always()",
    "        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4",
    "        with:",
    "          name: async-pipeline-${{ github.job }}-runs",
    "          path: .async/runs",
    "          if-no-files-found: ignore"
  );
}

function renderPagesBuildSteps(lines: string[], pages: GitHubPagesConfig): void {
  lines.push(
    "      - name: Configure Pages",
    "        uses: actions/configure-pages@v5",
    ""
  );
  if (pages.build.kind === "jekyll") {
    lines.push(
      "      - name: Build with Jekyll",
      "        uses: actions/jekyll-build-pages@v1",
      "        with:",
      `          source: ${JSON.stringify(pages.build.source)}`,
      `          destination: ${JSON.stringify(pages.build.destination ?? "./_site")}`,
      ""
    );
  }
  const artifactPath = pages.build.kind === "jekyll" ? pages.build.destination ?? "./_site" : pages.build.path;
  lines.push(
    "      - name: Upload Pages artifact",
    "        uses: actions/upload-pages-artifact@v4",
    "        with:",
    `          path: ${JSON.stringify(artifactPath)}`
  );
  if (pages.artifactName) {
    lines.push(`          name: ${JSON.stringify(pages.artifactName)}`);
  }
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
    "        uses: actions/deploy-pages@v4"
  );
  if (pages.artifactName) {
    lines.push(
      "        with:",
      `          artifact_name: ${JSON.stringify(pages.artifactName)}`
    );
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
  for (const key of ["branches", "paths", "tags"] as const) {
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

async function readPackageInfo(cwd: string): Promise<{ packageManager: string; buildCommand?: string }> {
  const packagePath = join(cwd, "package.json");
  if (!existsSync(packagePath)) return { packageManager: "pnpm" };
  const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as {
    packageManager?: string;
    scripts?: Record<string, string>;
  };
  const packageManager = packageJson.packageManager?.startsWith("npm@") ? "npm" : packageJson.packageManager?.startsWith("yarn@") ? "yarn" : "pnpm";
  const asyncPipelineScript = packageJson.scripts?.["async-pipeline"] ?? "";
  const buildCommand = asyncPipelineScript.includes("dist/cli.js") && packageJson.scripts?.build ? `${packageManager} build` : undefined;
  return { packageManager, buildCommand };
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
