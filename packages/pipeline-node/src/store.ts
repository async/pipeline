import { randomBytes, createHash, type Hash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, open, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { CandidateContext, EnvVarRef, ExecutionRecord, NormalizedPipeline, NormalizedTask, TaskCacheOptions, TaskResult, TaskSourceContext, TaskStep } from "@async/pipeline-core";
import { DEFAULT_PIPELINE_CONFIG_FILES, expandInputs } from "@async/pipeline-core";
import type { ExecutionGraphSnapshot } from "@async/pipeline-core/graph";

export interface PipelineStore {
  root: string;
  asyncDir: string;
  runsDir: string;
  cacheDir: string;
  sourcesDir: string;
}

export interface TaskCacheKeyOptions {
  steps?: TaskStep[];
  candidate?: CandidateContext;
  source?: TaskSourceContext;
  prepareCommands?: string[];
  dependencyFingerprints?: Record<string, string | null | undefined>;
}

export interface ResolvedFileOptions {
  exclude?: readonly string[];
  includeMissing?: boolean;
  pruneDefaultDirs?: boolean;
}

export interface CacheOutputManifest {
  version: 1;
  generatedAt: string;
  outputs: string[];
  files: CacheOutputFile[];
}

export interface CacheOutputFile {
  path: string;
  size: number;
  sha256: string;
}

export async function createStore(root: string): Promise<PipelineStore> {
  const asyncDir = join(root, ".async");
  const runsDir = join(asyncDir, "runs");
  const cacheDir = join(asyncDir, "cache", "tasks");
  const sourcesDir = join(asyncDir, "sources");
  await mkdir(runsDir, { recursive: true });
  await mkdir(cacheDir, { recursive: true });
  await mkdir(sourcesDir, { recursive: true });
  return { root, asyncDir, runsDir, cacheDir, sourcesDir };
}

/**
 * Write-fsync-then-rename so readers never observe a truncated file, even if
 * the process or machine dies mid-write. rename(2) is atomic within a
 * filesystem, and the fsync keeps a crash from publishing an empty file.
 */
export async function writeFileAtomic(path: string, data: string): Promise<void> {
  const tempPath = join(dirname(path), `.${randomBytes(6).toString("hex")}.tmp`);
  const handle = await open(tempPath, "w");
  try {
    await handle.writeFile(data, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(tempPath, { force: true });
    throw error;
  }
  await handle.close();
  try {
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

export async function writeExecution(store: PipelineStore, record: ExecutionRecord): Promise<void> {
  const runDir = join(store.runsDir, record.id);
  await mkdir(runDir, { recursive: true });
  await writeFileAtomic(join(runDir, "execution.json"), `${JSON.stringify(record, null, 2)}\n`);
  await writeFileAtomic(join(runDir, "summary.md"), renderSummary(record));
}

export async function writeGraphSnapshot(store: PipelineStore, runId: string, snapshot: ExecutionGraphSnapshot): Promise<void> {
  const runDir = join(store.runsDir, runId);
  await mkdir(runDir, { recursive: true });
  await writeFileAtomic(join(runDir, "graph.json"), `${JSON.stringify(snapshot, null, 2)}\n`);
}

export async function writeTaskLog(store: PipelineStore, runId: string, taskId: string, log: string): Promise<void> {
  const logDir = join(store.runsDir, runId, "logs");
  await mkdir(logDir, { recursive: true });
  await writeFileAtomic(join(logDir, `${safeFileName(taskId)}.log`), log);
}

export async function writeAgentPrompt(store: PipelineStore, runId: string, taskId: string, prompt: string): Promise<string> {
  const agentDir = join(store.runsDir, runId, "agents");
  await mkdir(agentDir, { recursive: true });
  const path = join(agentDir, `${safeFileName(taskId)}.prompt.txt`);
  await writeFileAtomic(path, prompt);
  return path;
}

export async function writeAgentTranscript(store: PipelineStore, runId: string, taskId: string, transcript: string): Promise<void> {
  const agentDir = join(store.runsDir, runId, "agents");
  await mkdir(agentDir, { recursive: true });
  await writeFileAtomic(join(agentDir, `${safeFileName(taskId)}.jsonl`), transcript);
}

export async function readCacheEntry(store: PipelineStore, cacheKey: string): Promise<TaskResult | null> {
  try {
    const cacheFile = join(store.cacheDir, cacheKey, "result.json");
    const result = JSON.parse(await readFile(cacheFile, "utf8")) as TaskResult;
    // Refresh mtime on hits so age-based `gc` pruning keeps hot entries.
    const now = new Date();
    await utimes(cacheFile, now, now).catch(() => {});
    return result;
  } catch {
    return null;
  }
}

export interface RunLock {
  path: string;
  release(): Promise<void>;
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * One run at a time per `.async` store: concurrent runs would race on cache
 * entries, run records, and restored outputs. The lock file records the
 * holder pid; a lock whose holder is no longer alive is reclaimed.
 */
export async function acquireRunLock(store: PipelineStore): Promise<RunLock> {
  const lockPath = join(store.asyncDir, "run.lock");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, "utf8");
      } finally {
        await handle.close();
      }
      return {
        path: lockPath,
        async release(): Promise<void> {
          await rm(lockPath, { force: true });
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let holder: { pid?: number } | null = null;
      try {
        holder = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: number };
      } catch {
        holder = null;
      }
      if (holder && typeof holder.pid === "number" && isPidAlive(holder.pid)) {
        throw storeError(
          "ASYNC_PIPELINE_RUN_ACTIVE",
          `Another async-pipeline run (pid ${holder.pid}) is active in this project. Wait for it to finish, or delete .async/run.lock if it is stale.`
        );
      }
      // Holder crashed or the lock is unreadable: reclaim and retry.
      await rm(lockPath, { force: true });
    }
  }
  throw storeError("ASYNC_PIPELINE_RUN_ACTIVE", "Could not acquire .async/run.lock after repeated attempts.");
}

function storeError(code: string, message: string): Error {
  const error = new Error(message);
  (error as Error & { code: string }).code = code;
  return error;
}

/**
 * Remove task-cache entries whose last use is older than `maxAgeDays`.
 * Cache reads refresh mtime, so hot entries survive. `0` disables pruning.
 */
export async function pruneCacheEntries(cwd: string, maxAgeDays: number): Promise<number> {
  if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) return 0;
  const cacheDir = join(cwd, ".async", "cache", "tasks");
  let entries;
  try {
    entries = await readdir(cacheDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const entryDir = join(cacheDir, entry.name);
    let lastUsedMs = 0; // unreadable/partial entries are always prunable
    try {
      lastUsedMs = (await stat(join(entryDir, "result.json"))).mtimeMs;
    } catch {
      // keep 0
    }
    if (lastUsedMs < cutoff) {
      await rm(entryDir, { recursive: true, force: true });
      removed += 1;
    }
  }
  await pruneOrphanedBaselines(cwd, cacheDir);
  return removed;
}

/** Baseline pointers whose cache entry was pruned are stale: drop them so diffs report a missing baseline instead of dangling. */
async function pruneOrphanedBaselines(cwd: string, cacheDir: string): Promise<void> {
  const baselinesDir = join(cwd, ".async", "cache", "baselines");
  let entries;
  try {
    entries = await readdir(baselinesDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(baselinesDir, entry.name);
    try {
      const baseline = JSON.parse(await readFile(path, "utf8")) as TaskBaseline;
      await stat(join(cacheDir, baseline.cacheKey, "result.json"));
    } catch {
      await rm(path, { force: true });
    }
  }
}

export async function writeCacheEntry(
  store: PipelineStore,
  cacheKey: string,
  result: TaskResult,
  outputOptions?: { cwd: string; outputs: readonly string[] }
): Promise<CacheOutputManifest | null> {
  const cacheEntryDir = join(store.cacheDir, cacheKey);
  await mkdir(cacheEntryDir, { recursive: true });
  await writeFileAtomic(join(cacheEntryDir, "result.json"), `${JSON.stringify({ ...result, schemaVersion: 1 }, null, 2)}\n`);
  if (!outputOptions || outputOptions.outputs.length === 0) return null;
  return writeCacheOutputs(store, cacheKey, outputOptions.cwd, outputOptions.outputs);
}

export async function computeTaskCacheKey(
  pipeline: NormalizedPipeline,
  taskDefinition: NormalizedTask,
  cwd: string,
  options: TaskCacheKeyOptions = {}
): Promise<string> {
  return (await computeTaskCacheKeyDetailed(pipeline, taskDefinition, cwd, options)).cacheKey;
}

export async function writeCacheInputManifest(store: PipelineStore, cacheKey: string, manifest: TaskInputManifest): Promise<void> {
  const cacheEntryDir = join(store.cacheDir, cacheKey);
  await mkdir(cacheEntryDir, { recursive: true });
  await writeFileAtomic(join(cacheEntryDir, "inputs.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

export async function readCacheInputManifest(store: PipelineStore, cacheKey: string): Promise<TaskInputManifest | null> {
  try {
    const parsed = JSON.parse(await readFile(join(store.cacheDir, cacheKey, "inputs.json"), "utf8")) as TaskInputManifest;
    if (parsed?.schemaVersion !== 1 || typeof parsed.files !== "object" || parsed.files === null) return null;
    return parsed;
  } catch {
    return null;
  }
}

export interface TaskBaseline {
  schemaVersion: 1;
  taskId: string;
  cacheKey: string;
  recordedAt: string;
}

function baselinePath(store: PipelineStore, taskId: string): string {
  return join(store.asyncDir, "cache", "baselines", `${safeFileName(taskId)}.json`);
}

/** Points at the task's most recent passing cache entry: the diff baseline. */
export async function writeTaskBaseline(store: PipelineStore, taskId: string, cacheKey: string): Promise<void> {
  const path = baselinePath(store, taskId);
  await mkdir(dirname(path), { recursive: true });
  const baseline: TaskBaseline = { schemaVersion: 1, taskId, cacheKey, recordedAt: new Date().toISOString() };
  await writeFileAtomic(path, `${JSON.stringify(baseline, null, 2)}\n`);
}

export async function readTaskBaseline(store: PipelineStore, taskId: string): Promise<TaskBaseline | null> {
  try {
    const parsed = JSON.parse(await readFile(baselinePath(store, taskId), "utf8")) as TaskBaseline;
    if (parsed?.schemaVersion !== 1 || typeof parsed.cacheKey !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export interface InputDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

export function diffInputManifests(baseline: TaskInputManifest, current: TaskInputManifest): InputDiff {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [path, digest] of Object.entries(current.files)) {
    const before = baseline.files[path];
    if (before === undefined) added.push(path);
    else if (before !== digest) changed.push(path);
  }
  for (const path of Object.keys(baseline.files)) {
    if (current.files[path] === undefined) removed.push(path);
  }
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}

export interface TaskContextPack {
  schemaVersion: 1;
  task: string;
  runId: string;
  status: "failed";
  error: string;
  attempts: number;
  cacheKey?: string;
  reproduce: string;
  /** Redacted tail of the task log, capped well below the log cap. */
  logTail: string;
  inputDiff:
    | ({ baselineCacheKey: string; baselineRecordedAt: string } & InputDiff)
    | { baselineMissing: true };
  /** Claim ids from tests/claims.json whose registered test titles appear in the task log. */
  claims?: string[];
}

export async function writeContextPack(store: PipelineStore, runId: string, taskId: string, pack: TaskContextPack): Promise<void> {
  const contextDir = join(store.runsDir, runId, "context");
  await mkdir(contextDir, { recursive: true });
  await writeFileAtomic(join(contextDir, `${safeFileName(taskId)}.json`), `${JSON.stringify(pack, null, 2)}\n`);
}

export async function readContextPacks(store: PipelineStore, runId: string): Promise<TaskContextPack[]> {
  const contextDir = join(store.runsDir, runId, "context");
  let entries: string[];
  try {
    entries = await readdir(contextDir);
  } catch {
    return [];
  }
  const packs: TaskContextPack[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".json")) continue;
    try {
      packs.push(JSON.parse(await readFile(join(contextDir, entry), "utf8")) as TaskContextPack);
    } catch {
      // Unreadable packs are skipped, not fatal: packs are evidence, not state.
    }
  }
  return packs;
}

export type TaskCacheDecision = "hit" | "miss" | "disabled" | "bypassed" | "unknown";

export interface TaskCacheReceipt {
  schemaVersion: 1;
  task: string;
  runId: string;
  cacheEnabled: boolean;
  decision: TaskCacheDecision;
  dependencyFingerprints: Record<string, string | null>;
  recordedAt: string;
  cacheKey?: string;
  graphNodeFingerprint?: string;
  reason?: string;
  restoredOutputs?: boolean;
  inputManifestRecorded?: boolean;
}

export async function writeTaskCacheReceipt(store: PipelineStore, runId: string, taskId: string, receipt: TaskCacheReceipt): Promise<void> {
  const cacheDir = join(store.runsDir, runId, "cache");
  await mkdir(cacheDir, { recursive: true });
  await writeFileAtomic(join(cacheDir, `${safeFileName(taskId)}.json`), `${JSON.stringify(receipt, null, 2)}\n`);
}

export async function readTaskCacheReceipts(store: PipelineStore, runId: string): Promise<TaskCacheReceipt[]> {
  const cacheDir = join(store.runsDir, runId, "cache");
  let entries: string[];
  try {
    entries = await readdir(cacheDir);
  } catch {
    return [];
  }
  const receipts: TaskCacheReceipt[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".json")) continue;
    try {
      receipts.push(JSON.parse(await readFile(join(cacheDir, entry), "utf8")) as TaskCacheReceipt);
    } catch {
      // Unreadable receipts are skipped, not fatal: receipts are evidence, not state.
    }
  }
  return receipts;
}

export interface TaskInputManifest {
  schemaVersion: 1;
  /** Relative input path -> `sha256:<hex>` content digest, or `[missing]`. */
  files: Record<string, string>;
}

export interface TaskCacheKeyDetails {
  cacheKey: string;
  inputs: TaskInputManifest;
}

/**
 * The cache key plus the per-file digest manifest computed in the same input
 * walk. The walk already streams every input file; capturing per-file digests
 * here is what makes "which inputs changed since this task last passed"
 * answerable later without re-hashing against a baseline that no longer
 * exists (ADR-0003).
 */
export async function computeTaskCacheKeyDetailed(
  pipeline: NormalizedPipeline,
  taskDefinition: NormalizedTask,
  cwd: string,
  options: TaskCacheKeyOptions = {}
): Promise<TaskCacheKeyDetails> {
  const hash = createHash("sha256");
  hash.update(JSON.stringify({
    pipeline: pipeline.name,
    task: taskDefinition.id,
    source: serializeSourceContext(options.source ?? taskDefinition.source),
    candidate: serializeCandidateContext(options.candidate),
    prepareCommands: (options.prepareCommands ?? []).map((command) => normalizeCommandForCacheKey(command, options)),
    dependencyFingerprints: normalizeDependencyFingerprints(options.dependencyFingerprints),
    dependsOn: taskDefinition.dependsOn,
    inputs: taskDefinition.inputs,
    outputs: taskDefinition.outputs,
    cache: serializeCacheOptions(taskDefinition.cache),
    retry: taskDefinition.retry,
    timeout: taskDefinition.timeout,
    timeoutMs: taskDefinition.timeoutMs,
    requires: taskDefinition.requires,
    steps: serializeSteps(options.steps ?? taskDefinition.steps)
  }));

  const expandedInputs = expandInputs(pipeline, taskDefinition.inputs);
  const inputFiles = await resolveInputFiles(cwd, expandedInputs, { exclude: taskDefinition.outputs });

  for (const input of expandedInputs) {
    hash.update(input);
  }

  const files: Record<string, string> = {};
  for (const input of inputFiles) {
    hash.update(input);
    files[input] = await hashFileInto(hash, join(cwd, input));
  }

  return { cacheKey: hash.digest("hex"), inputs: { schemaVersion: 1, files } };
}

/**
 * The digest manifest for a task's current input state, without computing a
 * cache key: no step resolution, no deferred callbacks — file reads only.
 * Powers `explain <task> --diff-inputs`.
 */
export async function computeTaskInputManifest(pipeline: NormalizedPipeline, taskDefinition: NormalizedTask, cwd: string): Promise<TaskInputManifest> {
  const expandedInputs = expandInputs(pipeline, taskDefinition.inputs);
  const inputFiles = await resolveInputFiles(cwd, expandedInputs, { exclude: taskDefinition.outputs });
  const files: Record<string, string> = {};
  const discarded = createHash("sha256");
  for (const input of inputFiles) {
    files[input] = await hashFileInto(discarded, join(cwd, input));
  }
  return { schemaVersion: 1, files };
}

/**
 * Stream file contents into the rolling hash so huge inputs never load fully
 * into memory, and capture the file's own digest from the same pass.
 */
async function hashFileInto(hash: Hash, path: string): Promise<string> {
  const fileHash = createHash("sha256");
  try {
    for await (const chunk of createReadStream(path)) {
      hash.update(chunk as Buffer);
      fileHash.update(chunk as Buffer);
    }
  } catch {
    hash.update("[missing]");
    return "[missing]";
  }
  return `sha256:${fileHash.digest("hex")}`;
}

export async function computeCandidateContext(pipeline: NormalizedPipeline, cwd: string): Promise<CandidateContext> {
  const hash = createHash("sha256");
  const inputs = new Set<string>(DEFAULT_PIPELINE_CONFIG_FILES);
  for (const taskDefinition of Object.values(pipeline.tasks)) {
    for (const input of expandInputs(pipeline, taskDefinition.inputs)) {
      inputs.add(input);
    }
  }

  const inputFiles = await resolveInputFiles(cwd, [...inputs]);
  for (const input of [...inputs].sort()) {
    hash.update(input);
  }
  for (const input of inputFiles) {
    hash.update(input);
    await hashFileInto(hash, join(cwd, input));
  }

  return {
    dir: cwd,
    fingerprint: hash.digest("hex")
  };
}

export function resolveInputFiles(cwd: string, inputs: readonly string[]): Promise<string[]>;
export function resolveInputFiles(cwd: string, inputs: readonly string[], options: ResolvedFileOptions): Promise<string[]>;
export async function resolveInputFiles(cwd: string, inputs: readonly string[], options?: ResolvedFileOptions): Promise<string[]> {
  return resolveFiles(cwd, inputs, {
    includeMissing: options?.includeMissing ?? true,
    pruneDefaultDirs: options?.pruneDefaultDirs ?? true,
    exclude: options?.exclude
  });
}

export async function resolveOutputFiles(cwd: string, outputs: readonly string[]): Promise<string[]> {
  return resolveFiles(cwd, outputs, {
    includeMissing: false,
    pruneDefaultDirs: false
  });
}

export async function restoreCacheOutputs(store: PipelineStore, cacheKey: string, cwd: string, outputs: readonly string[]): Promise<boolean> {
  const manifest = await readCacheOutputManifest(store, cacheKey);
  if (!manifest || !sameStringList(manifest.outputs, [...outputs])) return false;

  const outputDir = cacheOutputFilesDir(store, cacheKey);
  for (const file of manifest.files) {
    if (!isSafeRelativePath(file.path)) return false;
    const cachedPath = join(outputDir, file.path);
    let cachedStat;
    try {
      cachedStat = await stat(cachedPath);
    } catch {
      return false;
    }
    if (!cachedStat.isFile() || cachedStat.size !== file.size) return false;
    if (await sha256File(cachedPath) !== file.sha256) return false;
  }

  for (const file of manifest.files) {
    const destination = join(cwd, file.path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(outputDir, file.path), destination);
  }

  return true;
}

export async function outputFilesExist(cwd: string, files: readonly string[]): Promise<boolean> {
  for (const file of files) {
    if (!isSafeRelativePath(file)) return false;
    try {
      const fileStat = await stat(join(cwd, file));
      if (!fileStat.isFile()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

async function writeCacheOutputs(store: PipelineStore, cacheKey: string, cwd: string, outputs: readonly string[]): Promise<CacheOutputManifest> {
  const outputDir = cacheOutputFilesDir(store, cacheKey);
  await rm(outputDir, { force: true, recursive: true });
  await mkdir(outputDir, { recursive: true });

  const outputFiles = await resolveOutputFiles(cwd, outputs);
  const files: CacheOutputFile[] = [];
  for (const file of outputFiles) {
    if (!isSafeRelativePath(file)) continue;
    const source = join(cwd, file);
    const destination = join(outputDir, file);
    const fileStat = await stat(source);
    if (!fileStat.isFile()) continue;
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
    files.push({
      path: file,
      size: fileStat.size,
      sha256: await sha256File(source)
    });
  }

  const manifest: CacheOutputManifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    outputs: [...outputs],
    files: files.sort((left, right) => left.path.localeCompare(right.path))
  };
  // Manifest goes last and atomically: a reader either sees a complete
  // manifest whose files all exist, or no manifest (treated as a miss).
  await writeFileAtomic(cacheOutputManifestPath(store, cacheKey), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

async function readCacheOutputManifest(store: PipelineStore, cacheKey: string): Promise<CacheOutputManifest | null> {
  try {
    const parsed = JSON.parse(await readFile(cacheOutputManifestPath(store, cacheKey), "utf8")) as CacheOutputManifest;
    if (parsed.version !== 1 || !Array.isArray(parsed.outputs) || !Array.isArray(parsed.files)) return null;
    for (const file of parsed.files) {
      if (typeof file.path !== "string" || typeof file.size !== "number" || typeof file.sha256 !== "string") return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function cacheOutputManifestPath(store: PipelineStore, cacheKey: string): string {
  return join(store.cacheDir, cacheKey, "outputs.json");
}

function cacheOutputFilesDir(store: PipelineStore, cacheKey: string): string {
  return join(store.cacheDir, cacheKey, "outputs");
}

async function resolveFiles(cwd: string, inputs: readonly string[], options: ResolvedFileOptions): Promise<string[]> {
  const includePatterns = inputs.filter((input) => !input.startsWith("!"));
  const excludePatterns = [
    ...inputs.filter((input) => input.startsWith("!")).map((input) => input.slice(1)),
    ...(options.exclude ?? [])
  ];
  const excludeMatchers = excludePatterns
    .filter((input) => input.length > 0)
    .flatMap(expandExcludePattern)
    .map((input) => globToRegExp(input));
  const files = new Set<string>();

  for (const pattern of includePatterns) {
    const normalizedPattern = normalizePath(pattern);
    if (isIgnoredPath(normalizedPattern, options)) continue;

    if (!normalizedPattern.includes("*")) {
      const normalized = normalizePath(normalizedPattern);
      if (isIgnoredPath(normalized, options) || excludeMatchers.some((matcher) => matcher.test(normalized))) continue;
      try {
        const fileStat = await stat(join(cwd, normalized));
        if (fileStat.isFile()) files.add(normalized);
        if (fileStat.isDirectory()) {
          for (const file of await walkFiles(join(cwd, normalized), cwd, options)) {
            files.add(file);
          }
        }
      } catch {
        if (options.includeMissing ?? true) files.add(normalized);
      }
      continue;
    }

    const baseDir = baseDirectoryForGlob(normalizedPattern);
    const matcher = globToRegExp(normalizedPattern);
    for (const file of await walkFiles(join(cwd, baseDir), cwd, options)) {
      if (matcher.test(file)) files.add(file);
    }
  }

  return [...files]
    .filter((file) => !excludeMatchers.some((matcher) => matcher.test(file)))
    .sort((left, right) => left.localeCompare(right));
}

async function walkFiles(dir: string, cwd: string, options: ResolvedFileOptions): Promise<string[]> {
  const relativeDir = normalizePath(relative(cwd, dir));
  if (relativeDir && relativeDir !== "." && isIgnoredPath(relativeDir, options)) return [];

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const absolutePath = join(dir, entry.name);
    const relativePath = normalizePath(relative(cwd, absolutePath));
    if (isIgnoredPath(relativePath, options)) continue;
    if (entry.isDirectory()) {
      files.push(...await walkFiles(absolutePath, cwd, options));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
}

function expandExcludePattern(pattern: string): string[] {
  const normalized = normalizePath(pattern);
  if (normalized.endsWith("/**")) return [normalized];
  if (normalized.endsWith("/")) return [`${normalized}**`];
  if (normalized.includes("*")) return [normalized];
  return [normalized, `${normalized}/**`];
}

const PRUNED_DIR_NAMES = new Set([".git", ".async", "node_modules"]);

function isIgnoredPath(path: string, options: ResolvedFileOptions): boolean {
  if (options.pruneDefaultDirs === false) return false;
  const normalized = normalizePath(path);
  if (!normalized || normalized === ".") return false;
  return normalized.split("/").some((segment) => PRUNED_DIR_NAMES.has(segment));
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isSafeRelativePath(path: string): boolean {
  const normalized = normalizePath(path);
  return Boolean(normalized)
    && !isAbsolute(normalized)
    && normalized !== ".."
    && !normalized.startsWith("../")
    && !normalized.includes("/../");
}

function serializeCandidateContext(candidate: CandidateContext | undefined): unknown {
  if (!candidate) return undefined;
  return {
    commit: candidate.commit,
    ref: candidate.ref,
    dirty: candidate.dirty
  };
}

function serializeSourceContext(source: TaskSourceContext | undefined): unknown {
  if (!source) return undefined;
  return {
    name: source.name,
    type: source.type,
    ref: source.ref,
    commit: source.commit
  };
}

function normalizeDependencyFingerprints(fingerprints: Record<string, string | null | undefined> | undefined): Record<string, string | null> {
  return Object.fromEntries(
    Object.entries(fingerprints ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, value ?? null])
  );
}

function normalizeCommandForCacheKey(command: string, options: Pick<TaskCacheKeyOptions, "candidate" | "source">): string {
  let normalized = command;
  const replacements = [
    [options.candidate?.dir, "$ASYNC_PIPELINE_CANDIDATE_DIR"],
    [options.source?.dir, "$ASYNC_PIPELINE_SOURCE_DIR"]
  ] as const;
  for (const [value, replacement] of replacements) {
    if (!value) continue;
    normalized = normalized.split(value).join(replacement);
    normalized = normalized.split(normalizePath(value)).join(replacement);
  }
  return normalized;
}

function baseDirectoryForGlob(pattern: string): string {
  const parts = pattern.split("/");
  const baseParts = [];
  for (const part of parts) {
    if (part.includes("*")) break;
    baseParts.push(part);
  }
  return baseParts.length === 0 ? "." : baseParts.join("/");
}

function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] ?? "";
    const next = pattern[index + 1];

    if (char === "*" && next === "*" && pattern[index + 2] === "/") {
      source += "(?:.*/)?";
      index += 2;
      continue;
    }

    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
      continue;
    }

    if (char === "*") {
      source += "[^/]*";
      continue;
    }

    source += escapeRegExp(char);
  }
  return new RegExp(`^${source}$`);
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function serializeSteps(steps: readonly TaskStep[]): unknown[] {
  return steps.map((step) => {
    if (typeof step === "function") return "[function]";
    if (step.kind === "deferred-shell") return { kind: "deferred-shell" };
    if (step.kind === "agent") {
      // Agent cache identity is profile id + model + prompt. The adapter
      // command argv is deliberately excluded, like absolute machine paths:
      // where a binary happens to live must never dirty the cache, while a
      // different profile, model, or prompt must.
      return {
        kind: "agent",
        use: serializeAgentValue(step.use),
        model: step.model === undefined ? undefined : serializeAgentValue(step.model),
        prompt: step.prompt,
        stdoutTo: step.stdoutTo
      };
    }
    return step;
  });
}

function serializeAgentValue(value: string | EnvVarRef): unknown {
  if (typeof value === "string") return value;
  return { env: value.name, values: value.values, default: value.default };
}

function serializeCacheOptions(cache: TaskCacheOptions): unknown {
  return {
    ...cache,
    key: typeof cache.key === "function" ? "[function]" : cache.key
  };
}

function renderSummary(record: ExecutionRecord): string {
  const lines = [
    `# Pipeline: ${record.pipelineName}`,
    "",
    `Job: ${record.jobId}`,
    `Status: ${record.status}`,
    "",
    "| Task | Status | Attempts | Cache | Duration |",
    "| --- | --- | ---: | --- | ---: |"
  ];
  for (const task of record.tasks) {
    lines.push(`| ${task.id} | ${task.status} | ${task.attempts} | ${task.cacheHit ? "hit" : "miss"} | ${task.durationMs ?? 0}ms |`);
  }
  lines.push("");
  return lines.join("\n");
}

function safeFileName(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]/g, "_");
}
