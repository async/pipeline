import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDir, "..");
const repoRoot = resolve(packageRoot, "../..");
const distDir = join(packageRoot, "dist");
const internalDir = join(distDir, "internal");

const internalPackages = [
  ["pipeline-core", "core"],
  ["pipeline-node", "node"],
  ["pipeline-adapter-lima", "lima"]
];

await rm(internalDir, { recursive: true, force: true });
await mkdir(internalDir, { recursive: true });

for (const [workspacePackage, targetName] of internalPackages) {
  await cp(
    join(repoRoot, "packages", workspacePackage, "dist"),
    join(internalDir, targetName),
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
    dir: join(internalDir, "node"),
    replacements: [
      ["@async/pipeline-core/graph", "../core/graph.js"],
      ["@async/pipeline-core", "../core/index.js"]
    ]
  },
  {
    dir: join(internalDir, "lima"),
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

function isTextBuildFile(fileName) {
  return fileName.endsWith(".js") || fileName.endsWith(".d.ts") || fileName.endsWith(".map");
}
