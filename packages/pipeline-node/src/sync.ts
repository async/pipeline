import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { NormalizedPipeline, NormalizedTaskSyncConfig, SyncRunner, SyncTargetSelector } from "@async/pipeline-core";
import { pipelineError } from "@async/pipeline-core";

export const TASK_SYNC_LOCK_PATH = ".async-pipeline/tasks.lock.json";
const TASK_SYNC_GENERATOR_VERSION = 1;
const DEFAULT_DENO_PIPELINE_COMMAND = "deno run -A npm:@async/pipeline/cli";

export interface TaskSyncOptions {
  cwd: string;
  configPath: string;
}

export interface TaskSyncCommand {
  name: string;
  value: string;
}

export interface TaskSyncManifest {
  path: string;
  runner: SyncRunner;
  field: "scripts" | "tasks";
  commands: TaskSyncCommand[];
}

export interface TaskSyncLock {
  version: number;
  generator: string;
  config: string;
  prefix: string;
  runners: "all" | SyncRunner[];
  targets: "root" | SyncTargetSelector[];
  manifests: TaskSyncManifest[];
  commands: TaskSyncCommand[];
  hash: string;
  generatedAt: string;
}

export interface TaskSyncRenderResult {
  enabled: boolean;
  lockPath: string;
  lock: TaskSyncLock;
  manifests: TaskSyncManifest[];
}

export async function renderTaskSync(pipeline: NormalizedPipeline, options: TaskSyncOptions): Promise<TaskSyncRenderResult> {
  const config = pipeline.sync.tasks;
  const manifests = config.enabled ? await resolveTaskSyncManifests(config, options.cwd) : [];
  const commands = config.enabled ? renderCommands(pipeline, config, options.cwd) : [];
  const manifestEntries = manifests.map((manifest) => ({
    ...manifest,
    commands
  }));
  const lockInput = {
    version: TASK_SYNC_GENERATOR_VERSION,
    config: relativePath(options.cwd, options.configPath),
    prefix: config.prefix,
    runners: config.runners,
    targets: config.targets,
    manifests: manifestEntries.map((manifest) => ({
      path: manifest.path,
      runner: manifest.runner,
      field: manifest.field,
      commands: manifest.commands
    })),
    commands
  };
  const lock: TaskSyncLock = {
    version: TASK_SYNC_GENERATOR_VERSION,
    generator: "@async/pipeline",
    config: lockInput.config,
    prefix: config.prefix,
    runners: config.runners,
    targets: config.targets,
    manifests: lockInput.manifests,
    commands,
    hash: hashJson(lockInput),
    generatedAt: new Date().toISOString()
  };
  return {
    enabled: config.enabled,
    lockPath: TASK_SYNC_LOCK_PATH,
    lock,
    manifests: manifestEntries
  };
}

export async function writeTaskSync(result: TaskSyncRenderResult, cwd: string): Promise<void> {
  if (!result.enabled) {
    throw pipelineError("ASYNC_PIPELINE_SYNC_NOT_CONFIGURED", "Task sync is not configured.");
  }

  const existingLock = await readTaskSyncLock(cwd);
  for (const manifest of result.manifests) {
    await writeManifestCommands(cwd, manifest, existingLock);
  }

  const lockFile = resolve(cwd, result.lockPath);
  await mkdir(dirname(lockFile), { recursive: true });
  await writeFile(lockFile, `${JSON.stringify(result.lock, null, 2)}\n`, "utf8");
}

export async function checkTaskSync(result: TaskSyncRenderResult, cwd: string, options: { requireConfigured?: boolean } = {}): Promise<string[]> {
  if (!result.enabled) {
    return options.requireConfigured ? ["Task sync is not configured. Add sync.tasks to pipeline.ts."] : [];
  }

  const issues: string[] = [];
  const existingLock = await readTaskSyncLock(cwd);
  for (const manifest of result.manifests) {
    const file = resolve(cwd, manifest.path);
    if (!existsSync(file)) {
      issues.push(`Missing task sync target ${manifest.path}. Run async-pipeline sync tasks generate.`);
      continue;
    }
    const parsed = await readJsonManifest(file);
    const current = objectRecord(parsed.value[manifest.field]);
    for (const command of manifest.commands) {
      if (current[command.name] !== command.value) {
        issues.push(`Generated ${manifest.field.slice(0, -1)} ${command.name} in ${manifest.path} is stale. Run async-pipeline sync tasks generate.`);
      }
    }

    const nextCommandNames = new Set(manifest.commands.map((command) => command.name));
    for (const commandName of managedCommandsForManifest(existingLock, manifest.path)) {
      if (!nextCommandNames.has(commandName) && current[commandName] !== undefined) {
        issues.push(`Generated ${manifest.field.slice(0, -1)} ${commandName} in ${manifest.path} is obsolete. Run async-pipeline sync tasks generate.`);
      }
    }
  }

  if (!existingLock) {
    issues.push(`Missing task sync lock ${result.lockPath}. Run async-pipeline sync tasks generate.`);
  } else if (
    existingLock.hash !== result.lock.hash
    || existingLock.config !== result.lock.config
    || existingLock.prefix !== result.lock.prefix
  ) {
    issues.push(`Task sync lock ${result.lockPath} is stale. Run async-pipeline sync tasks generate.`);
  }

  return issues;
}

export function describeTaskSync(result: TaskSyncRenderResult): string[] {
  if (!result.enabled) return ["Task sync is not configured."];
  const lines = [`Task sync lock: ${result.lockPath}`];
  for (const manifest of result.manifests) {
    lines.push(`${manifest.runner}\t${manifest.path}\t${manifest.commands.map((command) => command.name).join(", ")}`);
  }
  return lines;
}

function renderCommands(pipeline: NormalizedPipeline, config: NormalizedTaskSyncConfig, cwd: string): TaskSyncCommand[] {
  const commands: TaskSyncCommand[] = [];
  const pipelineCommand = resolvePipelineCommand(pipeline.sync.command, cwd);
  const jobIds = config.jobs === "all" ? Object.keys(pipeline.jobs).sort() : [...config.jobs].sort();
  for (const jobId of jobIds) {
    commands.push({
      name: `${config.prefix}:${jobId}`,
      value: `${pipelineCommand} run ${jobId}`
    });
  }

  const taskIds = config.tasks === undefined ? [] : config.tasks === "all" ? Object.keys(pipeline.tasks).sort() : [...config.tasks].sort();
  for (const taskId of taskIds) {
    commands.push({
      name: `${config.prefix}:task:${taskId}`,
      value: `${pipelineCommand} run-task ${taskId}`
    });
  }

  for (const [name, command] of Object.entries(config.scripts).sort(([left], [right]) => left.localeCompare(right))) {
    commands.push({
      name: `${config.prefix}:${name}`,
      value: `${pipelineCommand} ${command}`
    });
  }

  return commands;
}

function resolvePipelineCommand(command: string, cwd: string): string {
  if (command !== "async-pipeline") return command;
  if (!existsSync(join(cwd, "package.json")) && (existsSync(join(cwd, "deno.json")) || existsSync(join(cwd, "deno.jsonc")))) {
    return DEFAULT_DENO_PIPELINE_COMMAND;
  }
  return command;
}

async function resolveTaskSyncManifests(config: NormalizedTaskSyncConfig, cwd: string): Promise<Array<Omit<TaskSyncManifest, "commands">>> {
  const runners = selectedRunners(config.runners);
  if (config.targets === "root") {
    const rootManifests: Array<Omit<TaskSyncManifest, "commands">> = [];
    if (runners.has("package") && existsSync(join(cwd, "package.json"))) {
      rootManifests.push({ path: "package.json", runner: "package", field: "scripts" });
    }
    if (runners.has("deno")) {
      for (const name of ["deno.json", "deno.jsonc"]) {
        if (existsSync(join(cwd, name))) {
          rootManifests.push({ path: name, runner: "deno", field: "tasks" });
        }
      }
    }
    if (rootManifests.length === 0) {
      throw pipelineError("ASYNC_PIPELINE_SYNC_TARGET_NOT_FOUND", "Task sync root target did not match package.json, deno.json, or deno.jsonc.");
    }
    return rootManifests;
  }

  const manifests: Array<Omit<TaskSyncManifest, "commands">> = [];
  for (const target of config.targets) {
    if ("path" in target) {
      const manifest = resolveManifestPath(cwd, target.path);
      if (!runners.has(manifest.runner)) {
        throw pipelineError("ASYNC_PIPELINE_SYNC_RUNNER_DISABLED", `Task sync target ${target.path} uses disabled runner "${manifest.runner}".`);
      }
      manifests.push(manifest);
      continue;
    }

    const matches = await findPackagesByName(cwd, target.package);
    if (matches.length === 0) {
      throw pipelineError("ASYNC_PIPELINE_SYNC_TARGET_NOT_FOUND", `No package.json found with name "${target.package}".`);
    }
    if (matches.length > 1 && !target.allowMultiple) {
      throw pipelineError("ASYNC_PIPELINE_SYNC_AMBIGUOUS_TARGET", `Package selector "${target.package}" matched multiple package.json files.`);
    }
    if (!runners.has("package")) {
      throw pipelineError("ASYNC_PIPELINE_SYNC_RUNNER_DISABLED", `Package selector "${target.package}" requires the package runner.`);
    }
    for (const match of matches) {
      manifests.push({ path: match, runner: "package", field: "scripts" });
    }
  }

  return uniqueManifests(manifests);
}

function selectedRunners(runners: "all" | SyncRunner[]): Set<SyncRunner> {
  return new Set(runners === "all" ? ["package", "deno"] : runners);
}

function resolveManifestPath(cwd: string, inputPath: string): Omit<TaskSyncManifest, "commands"> {
  const absolute = resolve(cwd, inputPath);
  const relativeManifest = relativePath(cwd, absolute);
  if (!existsSync(absolute)) {
    throw pipelineError("ASYNC_PIPELINE_SYNC_TARGET_NOT_FOUND", `Task sync target ${inputPath} does not exist.`);
  }
  if (relativeManifest.endsWith("package.json")) return { path: relativeManifest, runner: "package", field: "scripts" };
  if (relativeManifest.endsWith("deno.json") || relativeManifest.endsWith("deno.jsonc")) return { path: relativeManifest, runner: "deno", field: "tasks" };
  throw pipelineError("ASYNC_PIPELINE_SYNC_UNSUPPORTED_TARGET", `Task sync target ${inputPath} must be package.json, deno.json, or deno.jsonc.`);
}

async function findPackagesByName(cwd: string, packageName: string): Promise<string[]> {
  const matches: string[] = [];
  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (shouldSkipDirectory(entry.name)) continue;
        await visit(absolute);
        continue;
      }
      if (entry.isFile() && entry.name === "package.json") {
        const packageJson = JSON.parse(await readFile(absolute, "utf8")) as { name?: string };
        if (packageJson.name === packageName) matches.push(relativePath(cwd, absolute));
      }
    }
  }
  await visit(cwd);
  return matches.sort();
}

function shouldSkipDirectory(name: string): boolean {
  return name === ".git"
    || name === "node_modules"
    || name === "dist"
    || name === ".async"
    || name === ".async-pipeline"
    || name === ".tmp"
    || name === "coverage";
}

async function writeManifestCommands(cwd: string, manifest: TaskSyncManifest, existingLock: TaskSyncLock | null): Promise<void> {
  const file = resolve(cwd, manifest.path);
  const parsed = await readJsonManifest(file);
  const current = objectRecord(parsed.value[manifest.field]);
  const managed = managedCommandsForManifest(existingLock, manifest.path);

  for (const command of manifest.commands) {
    if (current[command.name] !== undefined && !managed.has(command.name)) {
      throw pipelineError(
        "ASYNC_PIPELINE_SYNC_CONFLICT",
        `${manifest.path} already has unmanaged ${manifest.field.slice(0, -1)} "${command.name}". Rename it or remove it before running async-pipeline sync tasks generate.`
      );
    }
  }

  const nextCommandNames = new Set(manifest.commands.map((command) => command.name));
  const nextCommands = { ...current };
  for (const commandName of managed) {
    if (!nextCommandNames.has(commandName)) {
      delete nextCommands[commandName];
    }
  }

  for (const command of manifest.commands) {
    nextCommands[command.name] = command.value;
  }

  parsed.value[manifest.field] = sortRecord(nextCommands);
  await writeFile(file, `${JSON.stringify(parsed.value, null, parsed.indent)}\n`, "utf8");
}

function managedCommandsForManifest(lock: TaskSyncLock | null, manifestPath: string): Set<string> {
  const names = new Set<string>();
  for (const manifest of lock?.manifests ?? []) {
    if (manifest.path !== manifestPath) continue;
    for (const command of manifest.commands) names.add(command.name);
  }
  return names;
}

async function readTaskSyncLock(cwd: string): Promise<TaskSyncLock | null> {
  const lockFile = resolve(cwd, TASK_SYNC_LOCK_PATH);
  if (!existsSync(lockFile)) return null;
  return JSON.parse(await readFile(lockFile, "utf8")) as TaskSyncLock;
}

async function readJsonManifest(file: string): Promise<{ value: Record<string, unknown>; indent: number }> {
  const text = await readFile(file, "utf8");
  const indent = detectIndent(text);
  const source = file.endsWith(".jsonc") ? stripJsonComments(text) : text;
  const value = JSON.parse(source) as Record<string, unknown>;
  return { value, indent };
}

function detectIndent(text: string): number {
  const line = text.split(/\r?\n/).find((entry) => /^ +"/.test(entry));
  return line ? line.match(/^ +/)?.[0].length ?? 2 : 2;
}

function stripJsonComments(text: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      output += char;
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      output += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index += 1;
      index += 1;
      continue;
    }
    output += char;
  }
  return output;
}

function objectRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function sortRecord(input: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(input).sort(([left], [right]) => left.localeCompare(right)));
}

function uniqueManifests(manifests: Array<Omit<TaskSyncManifest, "commands">>): Array<Omit<TaskSyncManifest, "commands">> {
  const seen = new Set<string>();
  const unique: Array<Omit<TaskSyncManifest, "commands">> = [];
  for (const manifest of manifests) {
    if (seen.has(manifest.path)) continue;
    seen.add(manifest.path);
    unique.push(manifest);
  }
  return unique.sort((left, right) => left.path.localeCompare(right.path));
}

function hashJson(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function relativePath(cwd: string, path: string): string {
  const relativeFile = relative(cwd, resolve(path));
  if (relativeFile === "") return ".";
  if (relativeFile === ".." || relativeFile.startsWith(`..${sep}`)) {
    throw pipelineError("ASYNC_PIPELINE_SYNC_TARGET_OUTSIDE_ROOT", `Sync path "${path}" must be inside ${cwd}.`);
  }
  return relativeFile;
}
