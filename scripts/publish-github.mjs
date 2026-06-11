#!/usr/bin/env node
// GitHub Packages publishing for @async/pipeline, adapted from PatrickJS's
// GitHub-native npm preview packages gist into this repo's own pipeline:
// https://gist.github.com/PatrickJS/3fa2925713fcdf75a27a505ce2cd0d80
//
// One script, three modes:
//   pr      publish 0.0.0-pr.<n>.sha.<head-sha> and move the pr-<n> dist-tag
//   main    publish 0.0.0-main.sha.<sha> and move the main dist-tag
//   release publish the package.json version and move the latest dist-tag
//
// GitHub Packages requires the npm scope to match the repo owner, so the
// mirror publishes as @async-framework/pipeline while npm keeps
// @async/pipeline. Published versions are immutable; re-runs skip cleanly.
// Fork PRs are skipped: their GITHUB_TOKEN cannot write packages, and PR
// branches from forks are untrusted by default.
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { chmod, cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const GITHUB_REGISTRY = "https://npm.pkg.github.com";
const COMMENT_MARKER = "<!-- github-packages-pr-preview -->";
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const NAME_PATTERN = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const packageDir = join(repoRoot, "packages", "pipeline");

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

const mode = process.argv[2];
if (!["pr", "main", "release"].includes(mode ?? "")) {
  console.error("Usage: node scripts/publish-github.mjs <pr|main|release>");
  process.exit(2);
}

const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));

const repository = process.env.GITHUB_REPOSITORY ?? "async-framework/async-pipeline";
const owner = (process.env.GITHUB_REPOSITORY_OWNER ?? repository.split("/")[0]).toLowerCase();
const mirrorName = `@${owner}/${manifest.name.split("/")[1]}`;
if (!NAME_PATTERN.test(mirrorName)) {
  fail(`GitHub Packages package name must be a simple lowercase scoped npm name. Found: ${mirrorName}`);
}

const token = process.env.GITHUB_TOKEN ?? process.env.NODE_AUTH_TOKEN;
const apiBase = (process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");

async function ghApi(path, init = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
      ...init.headers
    }
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API ${init.method ?? "GET"} ${path} failed with ${response.status}: ${text.slice(0, 500)}`);
  }
  return response.status === 204 ? null : response.json();
}

// Mode-specific version, dist-tag, and context.
let version;
let distTag;
let prContext;
if (mode === "release") {
  version = manifest.version;
  distTag = "latest";
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    fail(`packages/pipeline version must be simple semver for a stable mirror. Found: ${version}`);
  }
  // A GitHub release cut on a commit whose package.json was never bumped
  // would silently republish the old version. Enforce tag/version parity.
  if (process.env.GITHUB_EVENT_NAME === "release") {
    const eventPath = process.env.GITHUB_EVENT_PATH;
    if (!eventPath || !existsSync(eventPath)) {
      fail("release events need GITHUB_EVENT_PATH to verify the release tag matches package.json.");
    }
    const event = JSON.parse(await readFile(eventPath, "utf8"));
    const tagName = event.release?.tag_name;
    if (!tagName) {
      fail("Release event payload did not include release.tag_name.");
    }
    if (tagName.replace(/^v/, "") !== version) {
      fail(`Release tag ${tagName} does not match packages/pipeline version ${version}. Publish from a matching tag such as v${version}.`);
    }
  }
} else if (mode === "main") {
  const sha = process.env.GITHUB_SHA;
  if (!sha || !SHA_PATTERN.test(sha)) {
    fail("main mode needs GITHUB_SHA (40-char lowercase hex). Run it from the generated workflow on a push to main.");
  }
  version = `0.0.0-main.sha.${sha}`;
  distTag = "main";
} else {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !existsSync(eventPath)) {
    fail("pr mode needs GITHUB_EVENT_PATH with a pull_request payload. Run it from the generated workflow on a pull request.");
  }
  const event = JSON.parse(await readFile(eventPath, "utf8"));
  const pullRequest = event.pull_request;
  const number = Number(pullRequest?.number ?? event.number);
  const headSha = pullRequest?.head?.sha;
  const headRepo = pullRequest?.head?.repo?.full_name;
  if (!Number.isInteger(number) || number <= 0 || !headSha || !SHA_PATTERN.test(headSha)) {
    fail("pr mode could not read a positive number and head.sha from the pull_request payload.");
  }
  if (headRepo !== repository) {
    // Covers forks and deleted fork repos (head.repo is null then) alike:
    // neither is this repo, so neither publishes.
    console.log(`Skipping preview publish: PR #${number} head is ${headRepo ?? "a deleted repo"}, not ${repository}.`);
    process.exit(0);
  }
  version = `0.0.0-pr.${number}.sha.${headSha}`;
  distTag = `pr-${number}`;
  prContext = { number, headSha };
}

if (!token) {
  fail("Set GITHUB_TOKEN (or NODE_AUTH_TOKEN) with packages:write to publish to GitHub Packages.");
}

// Stage the mirror package: same dist, LICENSE, and README as the npm
// tarball, renamed scope, mode-specific version.
if (!existsSync(join(packageDir, "dist", "cli.js"))) {
  fail("packages/pipeline/dist is missing. Build before publishing (the pipeline's pack task does this).");
}
const stagingDir = await mkdtemp(join(tmpdir(), "async-pipeline-github-publish-"));
// The staged npmrc holds the auth token; never leave it on disk after exit.
process.on("exit", () => rmSync(stagingDir, { force: true, recursive: true }));
const staged = {
  ...manifest,
  name: mirrorName,
  version,
  publishConfig: { registry: GITHUB_REGISTRY }
};
delete staged.scripts;
delete staged.devDependencies;
await writeFile(join(stagingDir, "package.json"), `${JSON.stringify(staged, null, 2)}\n`, "utf8");
await cp(join(packageDir, "dist"), join(stagingDir, "dist"), { recursive: true });
for (const extra of ["LICENSE", "README.md"]) {
  if (existsSync(join(packageDir, extra))) {
    await cp(join(packageDir, extra), join(stagingDir, extra));
  }
}

// npm auth scoped to a throwaway userconfig so the token never lands in the
// repo or in run logs. The auth line derives from the registry URL so a
// GHES registry (host or path based) works by changing GITHUB_REGISTRY.
const registryUrl = new URL(GITHUB_REGISTRY);
const registryAuthPath = `${registryUrl.host}${registryUrl.pathname.replace(/\/$/, "")}`;
const npmConfig = join(stagingDir, ".github-packages.npmrc");
await writeFile(npmConfig, `@${owner}:registry=${GITHUB_REGISTRY}\n//${registryAuthPath}/:_authToken=${token}\n`, "utf8");
await chmod(npmConfig, 0o600);

function npm(args, options = {}) {
  return spawnSync("npm", args, {
    cwd: stagingDir,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
    env: { ...process.env, NPM_CONFIG_USERCONFIG: npmConfig }
  });
}

const spec = `${mirrorName}@${version}`;
// A registry outage must not look like a missing version: only a 404-shaped
// failure may fall through to publish.
const view = npm(["view", spec, "version", "--registry", GITHUB_REGISTRY], { capture: true });
const viewOutput = `${view.stdout ?? ""}${view.stderr ?? ""}`;
const exists = view.status === 0;
if (!exists && !/(^|[\s])(E404|404)([\s]|$)|not found/i.test(viewOutput)) {
  console.error(viewOutput.slice(0, 2000));
  fail(`Could not check whether ${spec} already exists on GitHub Packages; refusing to guess. See npm output above.`);
}
if (exists) {
  console.log(`${spec} already exists on GitHub Packages; skipping publish.`);
} else {
  console.log(`Publishing ${spec} to GitHub Packages with tag ${distTag}.`);
  const publish = npm(["publish", "--tag", distTag, "--ignore-scripts", "--registry", GITHUB_REGISTRY]);
  if (publish.status !== 0) {
    fail(`Failed to publish ${spec} to GitHub Packages. Check the job's packages:write permission, package visibility, and whether this immutable version already exists.`);
  }
}

function moveDistTag() {
  const result = npm(["dist-tag", "add", spec, distTag, "--registry", GITHUB_REGISTRY]);
  if (result.status !== 0) {
    fail(`Failed to move GitHub Packages dist-tag ${distTag} to ${spec}.`);
  }
}

async function guardedApi(path, why) {
  try {
    return await ghApi(path);
  } catch (error) {
    fail(`${why}: ${error.message}`);
  }
}

if (mode === "release") {
  moveDistTag();
} else if (mode === "main") {
  // Only move the moving tag when this commit is still the branch head, so a
  // slow re-run cannot drag `main` backwards.
  const branch = await guardedApi(`/repos/${repository}/branches/main`, "Could not read the current main branch head");
  if (branch.commit?.sha === process.env.GITHUB_SHA) {
    moveDistTag();
  } else {
    console.log(`::notice::Not moving ${distTag}: main moved from ${process.env.GITHUB_SHA} to ${branch.commit?.sha}.`);
  }
} else {
  const pull = await guardedApi(`/repos/${repository}/pulls/${prContext.number}`, "Could not read the current PR head");
  if (pull.head?.sha !== prContext.headSha) {
    console.log(`::notice::Not moving ${distTag}: PR head moved from ${prContext.headSha} to ${pull.head?.sha}.`);
    process.exit(0);
  }
  moveDistTag();

  // Upsert one marker comment with copy/paste install commands.
  const body = [
    COMMENT_MARKER,
    "### Preview package",
    "",
    `Preview for PR head \`${prContext.headSha}\` (built from its merge with main), published to GitHub Packages as \`${mirrorName}\`.`,
    "",
    "Latest successful build for this PR:",
    "```sh",
    `pnpm add @async/pipeline@npm:${mirrorName}@${distTag}`,
    "```",
    "",
    "Exact commit build:",
    "```sh",
    `pnpm add @async/pipeline@npm:${mirrorName}@${version}`,
    "```",
    "",
    `Requires GitHub Packages auth and \`@${owner}:registry=${GITHUB_REGISTRY}\` in your npm config.`
  ].join("\n");
  const comments = await guardedApi(`/repos/${repository}/issues/${prContext.number}/comments?per_page=100`, "Could not list PR comments");
  const previous = comments.find(
    (comment) => comment.body?.includes(COMMENT_MARKER) && comment.user?.login === "github-actions[bot]"
  );
  try {
    if (previous) {
      await ghApi(`/repos/${repository}/issues/comments/${previous.id}`, { method: "PATCH", body: JSON.stringify({ body }) });
    } else {
      await ghApi(`/repos/${repository}/issues/${prContext.number}/comments`, { method: "POST", body: JSON.stringify({ body }) });
    }
  } catch (error) {
    fail(`Failed to create or update the PR preview comment: ${error.message}`);
  }
}

console.log(`GitHub Packages ${mode} publish complete: ${spec} (${distTag}).`);
