import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import {
  DEFAULT_PIPELINE_CONFIG_FILES,
  composePipelines,
  parseTaskRef,
  pipelineError,
  sourceUsesDefaultPipelineConfig,
  tasksForJob,
  type CandidateContext,
  type ExecutionSourceRecord,
  type JobId,
  type NormalizedPipeline,
  type NormalizedSource,
  type ShellCommand,
  type SourceId,
  type TaskSourceContext
} from "@async/pipeline-core";
import { loadPipeline } from "./loader.js";
import { computeCandidateContext, type PipelineStore } from "./store.js";

export interface ResolvedSource {
  id: SourceId;
  definition: NormalizedSource;
  dir: string;
  pipelinePath: string;
  record: ExecutionSourceRecord;
  pipeline?: NormalizedPipeline;
}

export interface SourceResolveOptions {
  /** Fetch refs and force-checkout the declared ref, discarding local edits in the checkout. */
  sync?: boolean;
  /** Clone missing checkouts and resolve the declared ref, but reuse existing checkouts without fetching. */
  ensure?: boolean;
  loadPipelines?: boolean;
  requirePrepareWritable?: boolean;
}

type GitResolveMode = "skip" | "ensure" | "sync";

export interface PipelineRunPlan {
  rootPipeline: NormalizedPipeline;
  pipeline: NormalizedPipeline;
  candidate: CandidateContext;
  sources: Record<SourceId, ResolvedSource>;
}

export interface MatrixRow {
  task: string;
  source: string;
  taskId: string;
  type: "git" | "path";
  url?: string;
  path?: string;
  ref?: string;
}

export interface SourceImpactPlanSource {
  id: SourceId;
  type: "git" | "path";
  path: string;
  pipeline: string;
  url?: string;
  ref?: string;
  writable?: boolean;
  prepare: string[];
  prepareSkippedReason?: string;
}

export interface SourceImpactMatrixRow extends MatrixRow {
  path: string;
}

export interface SourceImpactPlan {
  version: 1;
  generatedBy: "@async/pipeline";
  job: JobId;
  sources: Record<SourceId, SourceImpactPlanSource>;
  matrix: {
    include: SourceImpactMatrixRow[];
  };
}

export async function createRunPlan(rootPipeline: NormalizedPipeline, cwd: string, store: PipelineStore): Promise<PipelineRunPlan> {
  const candidate = await computeCandidateContext(rootPipeline, cwd);
  const sources = await resolveSources(rootPipeline, cwd, store, {
    ensure: true,
    loadPipelines: true,
    requirePrepareWritable: true
  });
  const composedSources: Parameters<typeof composePipelines>[1] = {};
  for (const [sourceId, resolved] of Object.entries(sources)) {
    if (!resolved.pipeline) continue;
    composedSources[sourceId] = {
      pipeline: resolved.pipeline,
      context: sourceContext(resolved)
    };
  }

  return {
    rootPipeline,
    pipeline: composePipelines(rootPipeline, composedSources),
    candidate,
    sources
  };
}

export async function resolveSources(
  pipeline: NormalizedPipeline,
  cwd: string,
  store: PipelineStore,
  options: SourceResolveOptions = {}
): Promise<Record<SourceId, ResolvedSource>> {
  const resolved: Record<SourceId, ResolvedSource> = {};
  for (const sourceDefinition of Object.values(pipeline.sources)) {
    if (sourceDefinition.type === "path" && sourceDefinition.prepare.length > 0 && options.requirePrepareWritable && !sourceDefinition.writable) {
      throw new Error(`Path source "${sourceDefinition.id}" has prepare steps. Set writable: true or use source.git for a scratch checkout.`);
    }

    const dir = sourceDefinition.type === "git"
      ? await resolveGitSource(sourceDefinition, store, options.sync ? "sync" : options.ensure ? "ensure" : "skip")
      : resolve(cwd, sourceDefinition.path);
    const pipelineFile = sourceUsesDefaultPipelineConfig(sourceDefinition)
      ? findPipelineConfigFile(dir) ?? sourceDefinition.pipeline
      : sourceDefinition.pipeline;
    const pipelinePath = join(dir, pipelineFile);
    const commit = existsSync(dir) ? await gitOutput(["rev-parse", "HEAD"], dir).catch(() => undefined) : undefined;
    const dirty = existsSync(dir) ? (await gitOutput(["status", "--porcelain"], dir).catch(() => "")).trim().length > 0 : undefined;

    const record: ExecutionSourceRecord = {
      id: sourceDefinition.id,
      type: sourceDefinition.type,
      dir,
      pipeline: pipelineFile,
      url: sourceDefinition.type === "git" ? sourceDefinition.url : undefined,
      path: sourceDefinition.type === "path" ? sourceDefinition.path : undefined,
      ref: sourceDefinition.type === "git" ? sourceDefinition.ref : undefined,
      commit,
      dirty,
      prepare: sourceDefinition.prepare.map((step) => typeof step === "function" ? "[function]" : step.kind === "deferred-shell" ? "[deferred-shell]" : step.kind === "agent" ? "[agent]" : step.command)
    };

    resolved[sourceDefinition.id] = {
      id: sourceDefinition.id,
      definition: sourceDefinition,
      dir,
      pipelinePath,
      record,
      pipeline: options.loadPipelines && existsSync(pipelinePath) ? await loadPipeline(pipelinePath) : undefined
    };
  }
  return resolved;
}

function findPipelineConfigFile(dir: string): string | undefined {
  for (const fileName of DEFAULT_PIPELINE_CONFIG_FILES) {
    if (existsSync(join(dir, fileName))) return fileName;
  }
  return undefined;
}

export async function readPipelineMetadata(
  configPath: string,
  options: { includeSources?: boolean; cwd?: string; store?: PipelineStore } = {}
): Promise<unknown> {
  const rootPipeline = await loadPipeline(configPath);
  if (!options.includeSources) return rootPipeline;

  const cwd = options.cwd ?? dirname(configPath);
  const store = options.store ?? {
    root: cwd,
    asyncDir: join(cwd, ".async"),
    runsDir: join(cwd, ".async", "runs"),
    cacheDir: join(cwd, ".async", "cache", "tasks"),
    sourcesDir: join(cwd, ".async", "sources")
  };
  const sources = await resolveSources(rootPipeline, cwd, store, { sync: false, loadPipelines: true });
  const sourceMetadata: Record<string, unknown> = {};
  for (const [sourceId, resolved] of Object.entries(sources)) {
    sourceMetadata[sourceId] = {
      record: resolved.record,
      pipeline: resolved.pipeline
    };
  }
  return {
    ...rootPipeline,
    sourceMetadata
  };
}

export function matrixForJob(pipeline: NormalizedPipeline, jobId: string): { include: MatrixRow[] } {
  const graph = tasksForJob(pipeline, jobId);
  const include: MatrixRow[] = [];
  for (const taskRef of graph.executionOrder) {
    const parsed = parseTaskRef(taskRef);
    if (!parsed.source) continue;
    const sourceDefinition = pipeline.sources[parsed.source];
    if (!sourceDefinition) continue;
    include.push({
      task: taskRef,
      source: parsed.source,
      taskId: parsed.taskId,
      type: sourceDefinition.type,
      url: sourceDefinition.type === "git" ? sourceDefinition.url : undefined,
      path: sourceDefinition.type === "path" ? sourceDefinition.path : undefined,
      ref: sourceDefinition.type === "git" ? sourceDefinition.ref : undefined
    });
  }
  return { include };
}

export function sourceImpactPlanForJob(pipeline: NormalizedPipeline, cwd: string, jobId: JobId): SourceImpactPlan {
  const matrix = matrixForJob(pipeline, jobId);
  const store: PipelineStore = {
    root: cwd,
    asyncDir: join(cwd, ".async"),
    runsDir: join(cwd, ".async", "runs"),
    cacheDir: join(cwd, ".async", "cache", "tasks"),
    sourcesDir: join(cwd, ".async", "sources")
  };
  const sources: Record<SourceId, SourceImpactPlanSource> = {};
  const include: SourceImpactMatrixRow[] = [];

  for (const row of matrix.include) {
    const sourceDefinition = pipeline.sources[row.source];
    if (!sourceDefinition) continue;
    if (!sources[row.source]) {
      const prepare = serializePrepare(sourceDefinition);
      const sourcePath = sourceDefinition.type === "git"
        ? repoRelativePath(cwd, sourceCheckoutDir(store, sourceDefinition), `source "${sourceDefinition.id}" checkout path`)
        : repoRelativePath(cwd, resolve(cwd, sourceDefinition.path), `source "${sourceDefinition.id}" path`);
      sources[row.source] = {
        id: sourceDefinition.id,
        type: sourceDefinition.type,
        path: sourcePath,
        pipeline: sourceDefinition.pipeline,
        ...(sourceDefinition.type === "git" ? { url: sourceDefinition.url, ref: sourceDefinition.ref } : {}),
        ...(sourceDefinition.type === "path" ? { writable: sourceDefinition.writable } : {}),
        prepare: prepare.commands,
        ...(prepare.skippedReason ? { prepareSkippedReason: prepare.skippedReason } : {})
      };
    }
    const source = sources[row.source];
    if (!source) continue;
    include.push({
      ...row,
      path: source.path
    });
  }

  return {
    version: 1,
    generatedBy: "@async/pipeline",
    job: jobId,
    sources,
    matrix: { include }
  };
}

export function sourceContext(source: ResolvedSource): TaskSourceContext {
  return {
    name: source.id,
    dir: source.dir,
    type: source.definition.type,
    ref: source.definition.type === "git" ? source.definition.ref : undefined,
    commit: source.record.commit
  };
}

export function sourceCheckoutDir(store: PipelineStore, sourceDefinition: NormalizedSource): string {
  const hash = createHash("sha256")
    .update(JSON.stringify(sourceDefinition.type === "git"
      ? { url: sourceDefinition.url, ref: sourceDefinition.ref }
      : { path: sourceDefinition.path }))
    .digest("hex")
    .slice(0, 16);
  return join(store.sourcesDir, sourceDefinition.id, hash);
}

function serializePrepare(sourceDefinition: NormalizedSource): { commands: string[]; skippedReason?: string } {
  const commands: string[] = [];
  for (const step of sourceDefinition.prepare) {
    if (typeof step === "object" && step !== null && "kind" in step && step.kind === "shell") {
      commands.push(step.command);
      continue;
    }
    return {
      commands: [],
      skippedReason: "prepare includes deferred or non-shell steps"
    };
  }
  return { commands };
}

function repoRelativePath(cwd: string, target: string, label: string): string {
  const relativePath = relative(cwd, target);
  if (!relativePath) return ".";
  if (relativePath === ".." || relativePath.startsWith("../") || relativePath.startsWith("..\\")) {
    throw pipelineError(
      "ASYNC_PIPELINE_GITHUB_SOURCE_IMPACT_INVALID",
      `${label} must resolve inside the repository when sync.github.sourceImpact is enabled.`
    );
  }
  return relativePath.split("\\").join("/");
}

export function shellCommandsFromSteps(steps: readonly ShellCommand[]): string[] {
  return steps.map((step) => step.command);
}

async function resolveGitSource(sourceDefinition: NormalizedSource & { type: "git" }, store: PipelineStore, mode: GitResolveMode): Promise<string> {
  const dir = sourceCheckoutDir(store, sourceDefinition);
  if (mode === "skip") return dir;

  await mkdir(dirname(dir), { recursive: true });
  if (!existsSync(join(dir, ".git"))) {
    await runGit(["clone", "--no-checkout", sourceDefinition.url, dir], store.root);
  }

  const shouldFetch = mode === "sync"
    ? !isFullCommit(sourceDefinition.ref)
    : !await refResolvable(sourceDefinition.ref, dir);
  if (shouldFetch) {
    await runGit(["fetch", "--tags", "origin"], dir);
  }

  if (mode === "sync") {
    await runGit(["checkout", "--force", sourceDefinition.ref], dir);
    return dir;
  }

  const target = await gitOutput(["rev-parse", "--verify", `${sourceDefinition.ref}^{commit}`], dir).catch(() => undefined);
  if (!target) {
    throw new Error(`Source "${sourceDefinition.id}" ref "${sourceDefinition.ref}" cannot be resolved in ${dir}. Run async-pipeline sources sync.`);
  }
  const head = await gitOutput(["rev-parse", "HEAD"], dir).catch(() => undefined);
  if (head !== target) {
    await runGit(["checkout", "--force", sourceDefinition.ref], dir);
  }
  return dir;
}

async function refResolvable(ref: string, dir: string): Promise<boolean> {
  return gitOutput(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], dir).then(() => true, () => false);
}

function isFullCommit(ref: string): boolean {
  return /^[a-f0-9]{40}$/i.test(ref);
}

async function runGit(args: string[], cwd: string): Promise<void> {
  const result = await runProcess("git", args, cwd);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
}

async function gitOutput(args: string[], cwd: string): Promise<string> {
  const result = await runProcess("git", args, cwd);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function runProcess(command: string, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("close", (code) => {
      resolveResult({ code: code ?? 1, stdout, stderr });
    });
  });
}
