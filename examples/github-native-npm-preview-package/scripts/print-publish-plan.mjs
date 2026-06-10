import { readFile } from "node:fs/promises";

const mode = process.argv[2];
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const packageName = packageJson.name;
const version = packageJson.version;
const sha = process.env.PR_HEAD_SHA ?? process.env.GITHUB_SHA ?? "<sha>";
const prNumber = process.env.PR_NUMBER ?? process.env.GITHUB_REF_NAME ?? "<pr-number>";

if (!["pr", "main", "release"].includes(mode)) {
  throw new Error("Usage: node scripts/print-publish-plan.mjs <pr|main|release>");
}

if (mode === "pr") {
  const previewVersion = `0.0.0-pr.${prNumber}.sha.${sha}`;
  console.log([
    "PR preview package plan:",
    `  npm pkg set version=${previewVersion}`,
    "  npm pkg set publishConfig.registry=https://npm.pkg.github.com",
    `  npm publish --tag pr-${prNumber} --registry https://npm.pkg.github.com`,
    `  npm dist-tag add ${packageName}@${previewVersion} pr-${prNumber} --registry https://npm.pkg.github.com`
  ].join("\n"));
}

if (mode === "main") {
  const snapshotVersion = `0.0.0-main.sha.${sha}`;
  console.log([
    "Main snapshot package plan:",
    `  npm pkg set version=${snapshotVersion}`,
    "  npm pkg set publishConfig.registry=https://npm.pkg.github.com",
    "  npm publish --tag main --registry https://npm.pkg.github.com",
    `  npm dist-tag add ${packageName}@${snapshotVersion} main --registry https://npm.pkg.github.com`
  ].join("\n"));
}

if (mode === "release") {
  console.log([
    "Stable release package plan:",
    `  npm publish ${packageName}@${version} --access public --provenance --registry https://registry.npmjs.org`,
    `  npm publish ${packageName}@${version} --tag latest --registry https://npm.pkg.github.com`,
    `  npm dist-tag add ${packageName}@${version} latest --registry https://npm.pkg.github.com`
  ].join("\n"));
}
