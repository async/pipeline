import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { DEFAULT_PIPELINE_CONFIG_FILES } from "@async/pipeline-core";

export type LifecycleAuditFormat = "text" | "json";
export type LifecycleFindingCategory = "keep" | "configure" | "promote" | "remove" | "review";
export type LifecycleFindingSeverity = "info" | "warn" | "action";

export interface LifecycleAuditOptions {
  cwd: string;
  packagePath?: string;
}

export interface LifecyclePackageSummary {
  path: string;
  name?: string;
  version?: string;
  private?: boolean;
  packageManager?: string;
  asyncPipelineVersion?: string;
}

export interface LifecycleScriptSignal {
  name: string;
  value: string;
  category: LifecycleFindingCategory;
  managedByPipeline: boolean;
  keywords: string[];
}

export interface LifecycleWorkflowSignal {
  path: string;
  managedByPipeline: boolean;
  keywords: string[];
}

export interface LifecycleFileSignal {
  path: string;
  kind: "script" | "release-config" | "pipeline-lock";
  keywords: string[];
}

export interface LifecycleFinding {
  id: string;
  severity: LifecycleFindingSeverity;
  category: LifecycleFindingCategory;
  title: string;
  evidence: string[];
  recommendation: string;
}

export interface LifecycleAuditReport {
  schemaVersion: 1;
  cwd: string;
  packagePath: string;
  package: LifecyclePackageSummary | null;
  pipeline: {
    configPath?: string;
    taskSyncLock?: string;
    githubLock?: string;
  };
  scripts: LifecycleScriptSignal[];
  workflows: LifecycleWorkflowSignal[];
  files: LifecycleFileSignal[];
  findings: LifecycleFinding[];
}

const LIFECYCLE_KEYWORDS = [
  "release",
  "publish",
  "npm",
  "packages",
  "package",
  "preview",
  "pages",
  "doctor",
  "changelog",
  "provenance",
  "attest",
  "release-please"
];

const LIFECYCLE_PATTERN = /\b(release|publish|npm|packages?|preview|pages|doctor|changelog|provenance|attest|release-please)\b/i;

export async function auditLifecycle(options: LifecycleAuditOptions): Promise<LifecycleAuditReport> {
  const cwd = resolve(options.cwd);
  const packageRelativePath = normalizeRelativePath(options.packagePath ?? ".");
  const packageRoot = resolveInside(cwd, packageRelativePath);
  const scanRoot = resolveLifecycleScanRoot(cwd, packageRoot);
  const packageJsonPath = join(packageRoot, "package.json");
  const packageJson = await readJsonIfExists(packageJsonPath);
  const packageSummary = packageJson ? packageSummaryFromJson(cwd, packageRoot, packageJson) : null;
  const pipelineConfig = findPipelineConfig(cwd, scanRoot);
  const taskSyncLock = existsSync(join(scanRoot, ".async-pipeline", "tasks.lock.json"))
    ? relativePath(cwd, join(scanRoot, ".async-pipeline", "tasks.lock.json"))
    : undefined;
  const githubLock = existsSync(join(scanRoot, ".github", "async-pipeline.lock.json"))
    ? relativePath(cwd, join(scanRoot, ".github", "async-pipeline.lock.json"))
    : undefined;
  const scripts = packageJson ? scriptSignals(objectRecord(packageJson.scripts)) : [];
  const workflows = await workflowSignals(cwd, scanRoot);
  const files = await fileSignals(cwd, scanRoot, packageRoot);
  const findings = buildFindings({
    packageSummary,
    pipelineConfig,
    taskSyncLock,
    githubLock,
    scripts,
    workflows,
    files
  });

  return {
    schemaVersion: 1,
    cwd,
    packagePath: packageRelativePath,
    package: packageSummary,
    pipeline: {
      ...(pipelineConfig ? { configPath: pipelineConfig } : {}),
      ...(taskSyncLock ? { taskSyncLock } : {}),
      ...(githubLock ? { githubLock } : {})
    },
    scripts,
    workflows,
    files,
    findings
  };
}

export function renderLifecycleAuditText(report: LifecycleAuditReport): string {
  const lines: string[] = [];
  lines.push(`Lifecycle audit: ${report.package?.name ?? report.packagePath}`);
  lines.push(`Package: ${report.package ? `${report.package.name ?? "(unnamed)"}${report.package.version ? `@${report.package.version}` : ""}` : "missing package.json"}`);
  lines.push(`Pipeline config: ${report.pipeline.configPath ?? "not found"}`);
  if (report.package?.asyncPipelineVersion) lines.push(`@async/pipeline: ${report.package.asyncPipelineVersion}`);
  lines.push("");
  lines.push("Findings:");
  if (report.findings.length === 0) {
    lines.push("  none");
  } else {
    for (const finding of report.findings) {
      lines.push(`  [${finding.category}/${finding.severity}] ${finding.title}`);
      for (const evidence of finding.evidence) lines.push(`    - ${evidence}`);
      lines.push(`    recommendation: ${finding.recommendation}`);
    }
  }
  lines.push("");
  lines.push(`Scripts scanned: ${report.scripts.length}`);
  lines.push(`Workflows scanned: ${report.workflows.length}`);
  lines.push(`Lifecycle files scanned: ${report.files.length}`);
  return `${lines.join("\n")}\n`;
}

function packageSummaryFromJson(cwd: string, packageRoot: string, packageJson: Record<string, unknown>): LifecyclePackageSummary {
  const dependencies = {
    ...objectRecord(packageJson.dependencies),
    ...objectRecord(packageJson.devDependencies),
    ...objectRecord(packageJson.peerDependencies),
    ...objectRecord(packageJson.optionalDependencies)
  };
  return {
    path: relativePath(cwd, join(packageRoot, "package.json")),
    ...(typeof packageJson.name === "string" ? { name: packageJson.name } : {}),
    ...(typeof packageJson.version === "string" ? { version: packageJson.version } : {}),
    ...(typeof packageJson.private === "boolean" ? { private: packageJson.private } : {}),
    ...(typeof packageJson.packageManager === "string" ? { packageManager: packageJson.packageManager } : {}),
    ...(typeof dependencies["@async/pipeline"] === "string" ? { asyncPipelineVersion: dependencies["@async/pipeline"] } : {})
  };
}

function scriptSignals(scripts: Record<string, unknown>): LifecycleScriptSignal[] {
  return Object.entries(scripts)
    .filter(([name, value]) => typeof value === "string" && (LIFECYCLE_PATTERN.test(name) || LIFECYCLE_PATTERN.test(value)))
    .map(([name, value]) => {
      const scriptValue = value as string;
      const keywords = keywordsFromText(`${name} ${scriptValue}`);
      const managedByPipeline = scriptValue.trim().startsWith("async-pipeline ");
      return {
        name,
        value: scriptValue,
        managedByPipeline,
        keywords,
        category: classifyScript(name, scriptValue, managedByPipeline, keywords)
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function workflowSignals(cwd: string, scanRoot: string): Promise<LifecycleWorkflowSignal[]> {
  const workflowsDir = join(scanRoot, ".github", "workflows");
  let entries: Array<{ name: string; isFile(): boolean }>;
  try {
    entries = await readdir(workflowsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const signals: LifecycleWorkflowSignal[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || (!entry.name.endsWith(".yml") && !entry.name.endsWith(".yaml"))) continue;
    const workflowPath = join(workflowsDir, entry.name);
    const relativeWorkflowPath = relativePath(cwd, workflowPath);
    const text = await readFile(workflowPath, "utf8");
    const keywords = keywordsFromText(text);
    if (!hasWorkflowLifecycleSignal(keywords) && entry.name !== "async-pipeline.yml") continue;
    signals.push({
      path: relativeWorkflowPath,
      managedByPipeline: entry.name === "async-pipeline.yml",
      keywords
    });
  }
  return signals.sort((left, right) => left.path.localeCompare(right.path));
}

async function fileSignals(cwd: string, scanRoot: string, packageRoot: string): Promise<LifecycleFileSignal[]> {
  const signals: LifecycleFileSignal[] = [];
  const seen = new Set<string>();
  for (const path of [
    ".github/async-pipeline.lock.json",
    ".async-pipeline/tasks.lock.json",
    "release-please-config.json",
    ".release-please-manifest.json"
  ]) {
    const absolutePath = join(scanRoot, path);
    if (!existsSync(absolutePath)) continue;
    signals.push({
      path: relativePath(cwd, absolutePath),
      kind: path.includes("pipeline") ? "pipeline-lock" : "release-config",
      keywords: keywordsFromText(path)
    });
  }

  for (const scriptsRoot of scriptSignalRoots(scanRoot, packageRoot)) {
    await appendScriptFileSignals({ cwd, scriptsRoot, signals, seen });
  }
  return signals.sort((left, right) => left.path.localeCompare(right.path));
}

async function appendScriptFileSignals(input: {
  cwd: string;
  scriptsRoot: string;
  signals: LifecycleFileSignal[];
  seen: Set<string>;
}): Promise<void> {
  const scriptsDir = join(input.scriptsRoot, "scripts");
  let entries: Array<{ name: string; isFile(): boolean }>;
  try {
    entries = await readdir(scriptsDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const keywords = keywordsFromText(entry.name);
    if (keywords.length === 0) continue;
    const path = relativePath(input.cwd, join(scriptsDir, entry.name));
    if (input.seen.has(path)) continue;
    input.seen.add(path);
    input.signals.push({
      path,
      kind: "script",
      keywords
    });
  }
}

function buildFindings(input: {
  packageSummary: LifecyclePackageSummary | null;
  pipelineConfig?: string;
  taskSyncLock?: string;
  githubLock?: string;
  scripts: LifecycleScriptSignal[];
  workflows: LifecycleWorkflowSignal[];
  files: LifecycleFileSignal[];
}): LifecycleFinding[] {
  const findings: LifecycleFinding[] = [];
  if (!input.packageSummary) {
    findings.push({
      id: "package.missing",
      severity: "warn",
      category: "review",
      title: "No package.json was found for the selected package path.",
      evidence: ["package.json"],
      recommendation: "Point --package at the publishable package path before classifying release ownership."
    });
  }

  if (!input.pipelineConfig) {
    findings.push({
      id: "pipeline.config.missing",
      severity: "action",
      category: "configure",
      title: "No Pipeline config was found in this repo.",
      evidence: [...DEFAULT_PIPELINE_CONFIG_FILES],
      recommendation: "Add pipeline.ts or pipeline.js before moving release and publish orchestration behind Pipeline flags."
    });
  }

  if (input.pipelineConfig && !input.taskSyncLock) {
    findings.push({
      id: "pipeline.task-sync.missing-lock",
      severity: "warn",
      category: "configure",
      title: "Pipeline config exists, but no task sync lock was found.",
      evidence: [input.pipelineConfig, ".async-pipeline/tasks.lock.json"],
      recommendation: "Use sync.tasks and run async-pipeline sync tasks generate when package scripts should be Pipeline-owned."
    });
  }

  if (input.pipelineConfig && !input.githubLock) {
    findings.push({
      id: "pipeline.github-sync.missing-lock",
      severity: "warn",
      category: "configure",
      title: "Pipeline config exists, but no generated GitHub workflow lock was found.",
      evidence: [input.pipelineConfig, ".github/async-pipeline.lock.json"],
      recommendation: "Use sync.github and run async-pipeline github generate when GitHub workflow structure should be Pipeline-owned."
    });
  }

  const unmanagedScripts = input.scripts.filter((script) => !script.managedByPipeline && script.category !== "keep");
  if (unmanagedScripts.length > 0) {
    findings.push({
      id: "scripts.lifecycle.unmanaged",
      severity: "action",
      category: "review",
      title: "Lifecycle-looking package scripts are not Pipeline-owned.",
      evidence: unmanagedScripts.map((script) => `package.json scripts.${script.name}`),
      recommendation: "Classify each script as package evidence to keep, Pipeline config to generate, Pipeline capability to promote, or obsolete logic to remove."
    });
  }

  const customWorkflows = input.workflows.filter((workflow) => !workflow.managedByPipeline);
  if (customWorkflows.length > 0) {
    findings.push({
      id: "workflows.lifecycle.custom",
      severity: "action",
      category: "promote",
      title: "Custom workflow files contain release or publish lifecycle signals.",
      evidence: customWorkflows.map((workflow) => workflow.path),
      recommendation: "Move common workflow structure into Pipeline-generated jobs before deleting custom YAML."
    });
  }

  const lifecycleScripts = input.files.filter((file) => file.kind === "script");
  if (lifecycleScripts.length > 0) {
    findings.push({
      id: "files.lifecycle.scripts",
      severity: "warn",
      category: "review",
      title: "Lifecycle-looking files exist under scripts/.",
      evidence: lifecycleScripts.map((file) => file.path),
      recommendation: "Keep product CLIs and package evidence scripts, but remove repo-local publish orchestration once Pipeline owns it."
    });
  }

  const releaseConfig = input.files.filter((file) => file.kind === "release-config");
  if (releaseConfig.length > 0) {
    findings.push({
      id: "files.release-config.legacy",
      severity: "warn",
      category: "review",
      title: "Release configuration files exist outside Pipeline config.",
      evidence: releaseConfig.map((file) => file.path),
      recommendation: "Verify whether these files still own active release behavior or are legacy metadata that can be removed after Pipeline migration."
    });
  }

  const managedScripts = input.scripts.filter((script) => script.managedByPipeline);
  if (managedScripts.length > 0) {
    findings.push({
      id: "scripts.lifecycle.pipeline-managed",
      severity: "info",
      category: "configure",
      title: "Some lifecycle scripts already delegate to async-pipeline.",
      evidence: managedScripts.map((script) => `package.json scripts.${script.name}`),
      recommendation: "Check generated task locks before changing these scripts by hand."
    });
  }

  return findings;
}

function classifyScript(name: string, value: string, managedByPipeline: boolean, keywords: string[]): LifecycleFindingCategory {
  if (managedByPipeline) return "configure";
  const joined = `${name} ${value}`.toLowerCase();
  if (
    joined.includes("evidence")
    || joined.includes("bundle:size")
    || joined.includes("api-surface")
    || joined.includes("schema")
    || (joined.includes("pack") && joined.includes("check"))
  ) {
    return "keep";
  }
  if (keywords.includes("publish") || keywords.includes("npm") || keywords.includes("packages")) return "review";
  if (keywords.includes("release") || keywords.includes("doctor") || keywords.includes("release-please")) return "review";
  return "review";
}

function keywordsFromText(text: string): string[] {
  const lower = text.toLowerCase();
  return LIFECYCLE_KEYWORDS.filter((keyword) => lower.includes(keyword));
}

function hasWorkflowLifecycleSignal(keywords: string[]): boolean {
  return keywords.some((keyword) => [
    "release",
    "publish",
    "preview",
    "pages",
    "doctor",
    "provenance",
    "attest",
    "release-please"
  ].includes(keyword));
}

function findPipelineConfig(cwd: string, scanRoot: string): string | undefined {
  for (const file of DEFAULT_PIPELINE_CONFIG_FILES) {
    const absolutePath = join(scanRoot, file);
    if (existsSync(absolutePath)) return relativePath(cwd, absolutePath);
  }
  return undefined;
}

function resolveLifecycleScanRoot(cwd: string, packageRoot: string): string {
  if (packageRoot === cwd) return cwd;
  for (const marker of [".git", ".github", ".async-pipeline", ...DEFAULT_PIPELINE_CONFIG_FILES]) {
    if (existsSync(join(packageRoot, marker))) return packageRoot;
  }
  if (isDirectChild(cwd, packageRoot) && existsSync(join(packageRoot, "package.json"))) return packageRoot;
  return cwd;
}

function scriptSignalRoots(scanRoot: string, packageRoot: string): string[] {
  if (scanRoot === packageRoot) return [scanRoot];
  return [scanRoot, packageRoot];
}

function isDirectChild(cwd: string, path: string): boolean {
  const value = relative(cwd, path);
  return value !== "" && !value.startsWith("..") && !value.includes(sep);
}

async function readJsonIfExists(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function resolveInside(cwd: string, inputPath: string): string {
  const absolute = resolve(cwd, inputPath);
  const relativeInput = relative(cwd, absolute);
  if (relativeInput === "" || (!relativeInput.startsWith("..") && !relativeInput.includes(`${sep}..${sep}`) && relativeInput !== "..")) {
    return absolute;
  }
  throw new Error(`Path must stay inside the repo: ${inputPath}`);
}

function normalizeRelativePath(inputPath: string): string {
  if (inputPath === "" || inputPath === ".") return ".";
  return inputPath.replaceAll("\\", "/").replace(/\/+$/u, "");
}

function relativePath(cwd: string, path: string): string {
  const value = relative(cwd, path).split(sep).join("/");
  return value === "" ? "." : value;
}
