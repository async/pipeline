import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDir, "..");
const repoRoot = resolve(packageRoot, "../..");
const distDir = join(packageRoot, "dist");
const internalDir = join(distDir, "internal");
const stagedInternalDir = join(distDir, `.internal-${process.pid}-${Date.now()}`);

const internalPackages = [
  ["pipeline-core", "core"],
  ["pipeline-node", "node"],
  ["pipeline-adapter-lima", "lima"]
];

await rm(stagedInternalDir, { recursive: true, force: true });
await mkdir(stagedInternalDir, { recursive: true });

for (const [workspacePackage, targetName] of internalPackages) {
  await cp(
    join(repoRoot, "packages", workspacePackage, "dist"),
    join(stagedInternalDir, targetName),
    { recursive: true }
  );
}

const rewrites = [
  {
    dir: distDir,
    replacements: [
      ["../../pipeline-core/dist/index.js", "./internal/core/index.js"],
      ["../../pipeline-core/dist/runtime.js", "./internal/core/runtime.js"],
      ["../../pipeline-node/dist/index.js", "./internal/node/index.js"],
      ["../../pipeline-node/dist/cli.js", "./internal/node/cli.js"],
      ["../../pipeline-adapter-lima/dist/index.js", "./internal/lima/index.js"]
    ]
  },
  {
    dir: join(stagedInternalDir, "node"),
    replacements: [
      ["@async/pipeline-core/graph", "../core/graph.js"],
      ["@async/pipeline-core", "../core/index.js"]
    ]
  },
  {
    dir: join(stagedInternalDir, "lima"),
    replacements: [
      ["@async/pipeline-core/graph", "../core/graph.js"],
      ["@async/pipeline-core", "../core/index.js"],
      ["@async/pipeline-node", "../node/index.js"]
    ]
  }
];

for (const rewrite of rewrites) {
  await rewriteTextFiles(rewrite.dir, rewrite.replacements);
}

await writeLifecycleStub(join(stagedInternalDir, "node"));
await syncDirectory(stagedInternalDir, internalDir);
await rm(stagedInternalDir, { recursive: true, force: true });

async function rewriteTextFiles(dir, replacements) {
  const entries = await listTextFiles(dir);
  for (const entry of entries) {
    const filePath = join(dir, entry);
    let text = await readFile(filePath, "utf8");
    for (const [from, to] of replacements) {
      text = text.replaceAll(from, to);
    }
    await writeFile(filePath, text, "utf8");
  }
}

async function listTextFiles(root) {
  const files = [];

  async function visit(relativeDir) {
    const absoluteDir = join(root, relativeDir);
    for (const entry of await readdir(absoluteDir, { withFileTypes: true })) {
      const relativePath = join(relativeDir, entry.name);
      if (entry.isDirectory()) {
        await visit(relativePath);
      } else if (entry.isFile() && isTextBuildFile(entry.name)) {
        files.push(relativePath);
      }
    }
  }

  await visit("");
  return files;
}

async function syncDirectory(source, target) {
  await mkdir(target, { recursive: true });
  await cp(source, target, { recursive: true, force: true });
  await removeStaleEntries(source, target);
}

async function removeStaleEntries(source, target) {
  if (!existsSync(target)) return;
  for (const entry of await readdir(target, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);
    if (!existsSync(sourcePath)) {
      await rm(targetPath, { recursive: true, force: true });
      continue;
    }
    if (entry.isDirectory()) {
      await removeStaleEntries(sourcePath, targetPath);
    }
  }
}

function isTextBuildFile(fileName) {
  return fileName.endsWith(".js") || fileName.endsWith(".d.ts") || fileName.endsWith(".map");
}

async function writeLifecycleStub(nodeInternalDir) {
  const message = "Package lifecycle commands moved out of the @async/pipeline npm tarball. Use generated workflows with async/actions publish, preview, and pages steps.";
  const releaseCommand = "pnpm dlx github:async/release#v0.1.3";
  await writeFile(join(nodeInternalDir, "package-lifecycle.js"), [
    "import { spawnSync } from \"node:child_process\";",
    "const message = \"Package lifecycle commands moved out of the @async/pipeline npm tarball. Use generated workflows with async/actions publish, preview, and pages steps.\";",
    `const releaseCommand = ${JSON.stringify(releaseCommand)};`,
    "export function publishGitHubPackage() { throw new Error(message); }",
    "export function publishNpmPackage() { throw new Error(message); }",
    "export function ensureGitHubRelease() { throw new Error(message); }",
    "export function runReleaseDoctor() { throw new Error(message); }",
    "export async function syncGitHubReleaseDescriptions(options = {}) {",
    "  const args = [...releaseCommand.split(/\\s+/u), \"release\", \"sync-descriptions\", \"--package\", options.packagePath ?? \".\", \"--evidence-dir\", options.evidenceDir ?? \".async/release\"];",
    "  if (options.check) args.push(\"--check\");",
    "  const result = spawnSync(args[0], args.slice(1), {",
    "    cwd: options.cwd ?? process.cwd(),",
    "    encoding: \"utf8\",",
    "    stdio: [\"ignore\", \"pipe\", \"pipe\"],",
    "    env: { ...process.env, ...(options.env ?? {}) }",
    "  });",
    "  if (result.stdout) options.io?.stdout?.(result.stdout);",
    "  if (result.stderr) options.io?.stderr?.(result.stderr);",
    "  if (result.status !== 0) throw new Error(`async-release sync-descriptions failed with exit code ${result.status ?? \"unknown\"}.`);",
    "}",
    "export async function runLifecycleCli(action, io) {",
    "  try {",
    "    await action();",
    "    return 0;",
    "  } catch (error) {",
    "    io?.stderr?.(`${error instanceof Error ? error.message : String(error)}\\n`);",
    "    return 1;",
    "  }",
    "}",
    ""
  ].join("\n"), "utf8");
  await writeFile(join(nodeInternalDir, "package-lifecycle.d.ts"), [
    "export type GitHubPackagePublishMode = \"pr\" | \"main\" | \"release\";",
    "export interface PackageLifecycleIO { stdout(text: string): void; stderr(text: string): void; }",
    "export interface PackageLifecycleOptions { cwd: string; packagePath: string; registry?: string; namespace?: string; comment?: boolean; env: NodeJS.ProcessEnv; io: PackageLifecycleIO; }",
    "export interface ReleaseDescriptionSyncOptions extends PackageLifecycleOptions { check?: boolean; evidenceDir?: string; }",
    "export declare function publishGitHubPackage(): never;",
    "export declare function publishNpmPackage(): never;",
    "export declare function ensureGitHubRelease(): never;",
    "export declare function runReleaseDoctor(): never;",
    "export declare function syncGitHubReleaseDescriptions(options: ReleaseDescriptionSyncOptions): Promise<void>;",
    "export declare function runLifecycleCli(_action: () => Promise<void>, io: PackageLifecycleIO): Promise<number>;",
    ""
  ].join("\n"), "utf8");
  await rm(join(nodeInternalDir, "package-lifecycle.js.map"), { force: true });
  await rm(join(nodeInternalDir, "package-lifecycle.d.ts.map"), { force: true });
}
