import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type { EnvValue, ExecutionProfileId, GitHubJobConfig, GitHubPagesConfig, GitHubRuntimeName, JobEnvironment, JobRequirements, JobId, NormalizedJob, NormalizedPackagePreviewsConfig, NormalizedPipeline, TriggerDefinition, TriggerId } from "@async/pipeline-core";
import { githubConfigForJob, pipelineError } from "@async/pipeline-core";

export const GITHUB_WORKFLOW_PATH = ".github/workflows/async-pipeline.yml";
export const GITHUB_LOCK_PATH = ".github/async-pipeline.lock.json";
const GENERATOR_VERSION = 10;
const DEFAULT_NODE_VERSION = "24";
const DEFAULT_DENO_VERSION = "2";
const PNPM_SETUP_ACTION = "pnpm/setup@cf03a9b516e09bc5a90f041fc26fc930c9dc631b # v1.0.0";
const DENO_SETUP_ACTION = "denoland/setup-deno@667a34cdef165d8d2b2e98dde39547c9daac7282 # v2.0.4";
const SETUP_NODE_ACTION = "actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6";
const DEFAULT_PNPM_VERSION = "11.1.0";
const DEFAULT_DENO_PIPELINE_COMMAND = "deno run -A npm:@async/pipeline/cli";

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
  const manualDispatchJobs = Object.values(pipeline.jobs)
    .filter((job) => job.trigger.some((triggerId) => pipeline.triggers[triggerId]?.type === "manual"))
    .map((job) => job.id)
    .sort((left, right) => left.localeCompare(right));
  const setup = resolveGitHubSetup(pipeline.sync.github.setup);
  const nodeVersion = pipeline.sync.github.nodeVersion ?? DEFAULT_NODE_VERSION;
  const runtime = resolveRuntimeSpecs(pipeline.sync.github.runtime, options.projectKind, nodeVersion);
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
    manualDispatchJobs
  };
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
  if (model.dependabotAutoMerge.enabled) {
    renderDependabotAutoMergeJob(lines, model.dependabotAutoMerge.ecosystems);
  }
  if (model.packagePreviews.enabled) {
    renderPackagePreviewJob(lines, model);
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
  lines.push(
    "",
    "      - name: Check generated workflow",
    `        run: ${model.command} github check`,
    "",
    "      - name: Run pipeline job",
    `        run: ${model.command} run ${shellWord(job.id)}${job.execution ? ` --execution ${shellWord(job.execution)}` : ""}`,
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
  renderRunEvidenceSteps(lines, model.command);
  lines.push("");
}

function renderDependencyInstallSteps(model: ReturnType<typeof buildRenderModel>): string[] {
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

function renderRunEvidenceSteps(lines: string[], command: string): void {
  lines.push(
    "      - name: Explain async-pipeline run",
    "        if: failure()",
    `        run: ${command} explain --run latest || true`,
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

function renderPackagePreviewJob(lines: string[], model: ReturnType<typeof buildRenderModel>): void {
  const preview = model.packagePreviews;
  if (!preview.package || !preview.target) return;
  const publishCommand = [
    `${model.command} publish github pr`,
    `--package ${shellWord(preview.package)}`,
    `--registry ${shellWord(preview.registry)}`,
    ...(preview.namespace ? [`--namespace ${shellWord(preview.namespace)}`] : []),
    ...(preview.comment ? [] : ["--no-comment"])
  ].join(" ");
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
    "        uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2",
    "        with:",
    "          persist-credentials: false",
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
  lines.push(
    "",
    "      - name: Check generated workflow",
    `        run: ${model.command} github check`,
    "",
    "      - name: Run package preview target",
    `        run: ${model.command} run-task ${shellWord(preview.target)}`,
    "        env:",
    "          CI: true",
    "",
    "      - name: Publish package preview",
    `        run: ${publishCommand}`,
    "        env:",
    "          CI: true",
    `          GITHUB_TOKEN: \${{ secrets.${preview.tokenEnv} }}`,
    ""
  );
  renderRunEvidenceSteps(lines, model.command);
  lines.push("");
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
    "        uses: dependabot/fetch-metadata@25dd0e34f4fe68f24cc83900b1fe3fe149efef98 # v3.1.0",
    "        with:",
    "          github-token: ${{ secrets.GITHUB_TOKEN }}",
    "",
    "      - name: Verify dependency update scope",
    "        env:",
    "          PACKAGE_ECOSYSTEM: ${{ steps.dependabot-metadata.outputs.package-ecosystem }}",
    "          DEPENDENCY_NAMES: ${{ steps.dependabot-metadata.outputs.dependency-names }}",
    "          UPDATED_DEPENDENCIES_JSON: ${{ steps.dependabot-metadata.outputs.updated-dependencies-json }}",
    "        run: |",
    "          set -euo pipefail",
    "",
    "          case \"$PACKAGE_ECOSYSTEM\" in",
    `            ${ecosystems.map((ecosystem) => shellCasePattern(ecosystem)).join("|")}) ;;`,
    "            *)",
    "              echo \"::error::Unsupported Dependabot ecosystem: $PACKAGE_ECOSYSTEM\"",
    "              exit 1",
    "              ;;",
    "          esac",
    "",
    "          if [ -z \"$DEPENDENCY_NAMES\" ]; then",
    "            echo \"::error::Dependabot metadata did not include dependency names.\"",
    "            exit 1",
    "          fi",
    "",
    "          dependency_count=\"$(jq 'length' <<<\"$UPDATED_DEPENDENCIES_JSON\")\"",
    "          if [ \"$dependency_count\" -eq 0 ]; then",
    "            echo \"::error::Dependabot metadata did not include updated dependencies.\"",
    "            exit 1",
    "          fi",
    "",
    "      - name: Approve Dependabot PR",
    "        env:",
    "          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}",
    "          PR_URL: ${{ github.event.pull_request.html_url }}",
    "        run: |",
    "          set -euo pipefail",
    "",
    "          review_decision=\"$(gh pr view \"$PR_URL\" --json reviewDecision -q .reviewDecision)\"",
    "          if [ \"$review_decision\" = \"APPROVED\" ]; then",
    "            echo \"PR is already approved.\"",
    "          else",
    "            gh pr review --approve \"$PR_URL\"",
    "          fi",
    "",
    "      - name: Wait for checks",
    "        env:",
    "          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}",
    "          PR_URL: ${{ github.event.pull_request.html_url }}",
    "        run: |",
    "          set -euo pipefail",
    "",
    "          deadline=$((SECONDS + 1800))",
    "          empty_since=\"\"",
    "",
    "          while [ \"$SECONDS\" -lt \"$deadline\" ]; do",
    "            checks_json=\"$(gh pr checks \"$PR_URL\" --json name,bucket,workflow 2>/dev/null || true)\"",
    "            relevant_checks=\"$(jq '[.[] | select(.name != \"dependabot-auto-merge\" and .bucket != \"skipping\")]' <<<\"${checks_json:-[]}\")\"",
    "            check_count=\"$(jq 'length' <<<\"$relevant_checks\")\"",
    "            failing_count=\"$(jq '[.[] | select(.bucket == \"fail\" or .bucket == \"cancel\")] | length' <<<\"$relevant_checks\")\"",
    "            pending_count=\"$(jq '[.[] | select(.bucket == \"pending\")] | length' <<<\"$relevant_checks\")\"",
    "",
    "            if [ \"$failing_count\" -gt 0 ]; then",
    "              echo \"$relevant_checks\"",
    "              echo \"::error::At least one check failed or was cancelled.\"",
    "              exit 1",
    "            fi",
    "",
    "            if [ \"$check_count\" -eq 0 ]; then",
    "              if [ -z \"$empty_since\" ]; then",
    "                empty_since=\"$SECONDS\"",
    "              fi",
    "",
    "              if [ $((SECONDS - empty_since)) -ge 90 ]; then",
    "                echo \"No non-auto-merge checks were reported after 90 seconds.\"",
    "                exit 0",
    "              fi",
    "            elif [ \"$pending_count\" -eq 0 ]; then",
    "              echo \"All reported non-auto-merge checks passed or were skipped.\"",
    "              exit 0",
    "            else",
    "              empty_since=\"\"",
    "            fi",
    "",
    "            sleep 15",
    "          done",
    "",
    "          echo \"::error::Timed out waiting for checks to finish.\"",
    "          exit 1",
    "",
    "      - name: Merge Dependabot PR",
    "        env:",
    "          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}",
    "          PR_URL: ${{ github.event.pull_request.html_url }}",
    "        run: gh pr merge --squash --delete-branch \"$PR_URL\"",
    ""
  );
}

function renderSetupSteps(model: ReturnType<typeof buildRenderModel>): string[] {
  const pnpmVersion = pnpmSetupVersion(model.packageManager, model.packageManagerVersion);
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

function resolveGitHubSetup(setup: string): string {
  return setup;
}

function pnpmSetupVersion(packageManager: string, packageManagerVersion: string | undefined): string {
  return packageManager === "pnpm" && packageManagerVersion ? packageManagerVersion : DEFAULT_PNPM_VERSION;
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
    "      - name: Configure Pages",
    "        uses: actions/configure-pages@983d7736d9b0ae728b81ab479565c72886d7745b # v5",
    ""
  );
  if (pages.build.kind === "jekyll") {
    lines.push(
      "      - name: Build with Jekyll",
      "        uses: actions/jekyll-build-pages@44a6e6beabd48582f863aeeb6cb2151cc1716697 # v1",
      "        with:",
      `          source: ${JSON.stringify(pages.build.source)}`,
      `          destination: ${JSON.stringify(pages.build.destination ?? "./_site")}`,
      ""
    );
  }
  const artifactPath = pages.build.kind === "jekyll" ? pages.build.destination ?? "./_site" : pages.build.path;
  lines.push(
    "      - name: Upload Pages artifact",
    "        uses: actions/upload-pages-artifact@7b1f4a764d45c48632c6b24a0339c27f5614fb0b # v4",
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
    "        uses: actions/deploy-pages@d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e # v4"
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

function shellCasePattern(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : shellWord(value);
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
