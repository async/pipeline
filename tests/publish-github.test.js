// scripts/publish-github.mjs against a mocked npm CLI and a mocked GitHub
// API: publish/dist-tag behavior, fork and stale-head guards, idempotent
// re-runs, and token hygiene. No real registry is touched.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const scriptPath = join(repoRoot, "scripts", "publish-github.mjs");
const manifest = JSON.parse(readFileSync(join(repoRoot, "packages", "pipeline", "package.json"), "utf8"));

const HEAD_SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const TOKEN = "fake-publish-token-do-not-echo";

// --- mocked GitHub API -------------------------------------------------
let server;
let apiUrl;
let apiState;

function resetApi() {
  apiState = {
    requests: [],
    prHeadSha: HEAD_SHA,
    branchSha: HEAD_SHA,
    comments: []
  };
}

before(async () => {
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      apiState.requests.push({ method: request.method, url: request.url, body });
      const respond = (status, payload) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(payload));
      };
      if (request.url.includes("/branches/main")) return respond(200, { commit: { sha: apiState.branchSha } });
      if (/\/pulls\/\d+$/.test(request.url)) return respond(200, { head: { sha: apiState.prHeadSha } });
      if (request.url.includes("/comments") && request.method === "GET") return respond(200, apiState.comments);
      if (request.method === "POST") return respond(201, { id: 1 });
      if (request.method === "PATCH") return respond(200, { id: 1 });
      respond(404, { message: "unexpected route" });
    });
  });
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  apiUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

// --- mocked npm CLI -----------------------------------------------------
function makeNpmShim(dir) {
  const shim = join(dir, "npm");
  writeFileSync(
    shim,
    [
      "#!/usr/bin/env node",
      "const { appendFileSync, readFileSync, readdirSync } = require(\"node:fs\");",
      "const { join } = require(\"node:path\");",
      "const args = process.argv.slice(2);",
      "const record = { args, cwd: process.cwd() };",
      "try { record.userconfig = readFileSync(process.env.NPM_CONFIG_USERCONFIG, \"utf8\"); } catch {}",
      "try { record.manifest = JSON.parse(readFileSync(join(process.cwd(), \"package.json\"), \"utf8\")); } catch {}",
      "try { record.files = readdirSync(process.cwd()).sort(); } catch {}",
      "appendFileSync(process.env.NPM_SHIM_LOG, JSON.stringify(record) + \"\\n\");",
      "if (args[0] === \"view\") process.exit(Number(process.env.NPM_SHIM_VIEW_EXIT ?? 1));",
      "if (args[0] === \"publish\") process.exit(Number(process.env.NPM_SHIM_PUBLISH_EXIT ?? 0));",
      "process.exit(Number(process.env.NPM_SHIM_DISTTAG_EXIT ?? 0));"
    ].join("\n"),
    "utf8"
  );
  chmodSync(shim, 0o755);
}

// The script talks to the in-process mock API, so the spawn must be async:
// a sync spawn would block the event loop and deadlock the mock server.
async function runScript(mode, { event, env = {} } = {}) {
  resetApi();
  if (env.__branchSha) apiState.branchSha = env.__branchSha;
  if (env.__prHeadSha) apiState.prHeadSha = env.__prHeadSha;
  if (env.__comments) apiState.comments = env.__comments;
  const dir = mkdtempSync(join(tmpdir(), "publish-github-test-"));
  try {
    makeNpmShim(dir);
    const logPath = join(dir, "npm-calls.jsonl");
    writeFileSync(logPath, "", "utf8");
    let eventPath;
    if (event) {
      eventPath = join(dir, "event.json");
      writeFileSync(eventPath, JSON.stringify(event), "utf8");
    }
    const child = spawn(process.execPath, [scriptPath, mode], {
      cwd: repoRoot,
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        HOME: process.env.HOME,
        NPM_SHIM_LOG: logPath,
        GITHUB_REPOSITORY: "async-framework/async-pipeline",
        GITHUB_REPOSITORY_OWNER: "async-framework",
        GITHUB_API_URL: apiUrl,
        GITHUB_TOKEN: TOKEN,
        ...(eventPath ? { GITHUB_EVENT_PATH: eventPath } : {}),
        ...Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("__")))
      }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const status = await new Promise((resolveExit, rejectExit) => {
      child.on("error", rejectExit);
      child.on("close", resolveExit);
    });
    const calls = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    return { status, stdout, stderr, calls, api: apiState };
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

function prEvent(headRepo, headSha = HEAD_SHA, number = 5) {
  return { pull_request: { number, head: { sha: headSha, repo: { full_name: headRepo } } } };
}

// --- release mode -------------------------------------------------------
test("PROMISE: stable releases mirror to GitHub Packages as @async-framework/pipeline with the latest tag", async () => {
  const run = await runScript("release");
  assert.equal(run.status, 0, run.stderr);
  const publish = run.calls.find((call) => call.args[0] === "publish");
  assert.ok(publish, "expected an npm publish call");
  assert.deepEqual(publish.args, ["publish", "--tag", "latest", "--ignore-scripts", "--registry", "https://npm.pkg.github.com"]);
  assert.equal(publish.manifest.name, "@async-framework/pipeline");
  assert.equal(publish.manifest.version, manifest.version);
  assert.equal(publish.manifest.publishConfig.registry, "https://npm.pkg.github.com");
  assert.equal(publish.manifest.bin["async-pipeline"], "./dist/cli.js");
  // The mirror must ship what the npm tarball ships: dist plus LICENSE and README.
  for (const expected of ["LICENSE", "README.md", "dist", "package.json"]) {
    assert.ok(publish.files.includes(expected), `staged mirror package is missing ${expected}`);
  }
  const distTag = run.calls.find((call) => call.args[0] === "dist-tag");
  assert.deepEqual(distTag.args.slice(0, 4), ["dist-tag", "add", `@async-framework/pipeline@${manifest.version}`, "latest"]);
});

test("PROMISE: republishing an existing version skips publish but still moves the dist-tag", async () => {
  const run = await runScript("release", { env: { NPM_SHIM_VIEW_EXIT: "0" } });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.calls.some((call) => call.args[0] === "publish"), false);
  assert.equal(run.calls.some((call) => call.args[0] === "dist-tag"), true);
  assert.match(run.stdout, /already exists/);
});

test("release publish failures exit non-zero with an actionable error", async () => {
  const run = await runScript("release", { env: { NPM_SHIM_PUBLISH_EXIT: "1" } });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /packages:write/);
});

test("PROMISE: the GitHub token never appears in publish output", async () => {
  const run = await runScript("release");
  assert.equal(run.status, 0, run.stderr);
  assert.ok(!run.stdout.includes(TOKEN) && !run.stderr.includes(TOKEN), "token leaked into output");
  const publish = run.calls.find((call) => call.args[0] === "publish");
  assert.match(publish.userconfig, /_authToken/, "npm auth must come from the throwaway userconfig");
});

// --- pr mode --------------------------------------------------------------
test("PROMISE: fork pull requests never publish preview packages", async () => {
  const run = await runScript("pr", { event: prEvent("outsider/async-pipeline-fork") });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.calls.length, 0, "no npm command may run for fork PRs");
  assert.match(run.stdout, /Skipping preview publish/);
});

test("PRs whose fork repo was deleted skip cleanly instead of failing", async () => {
  const run = await runScript("pr", { event: { pull_request: { number: 5, head: { sha: HEAD_SHA, repo: null } } } });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.calls.length, 0);
  assert.match(run.stdout, /Skipping preview publish/);
});

test("same-repo PRs publish an immutable preview version, move the pr tag, and upsert one comment", async () => {
  const run = await runScript("pr", { event: prEvent("async-framework/async-pipeline") });
  assert.equal(run.status, 0, run.stderr);
  const publish = run.calls.find((call) => call.args[0] === "publish");
  assert.equal(publish.manifest.version, `0.0.0-pr.5.sha.${HEAD_SHA}`);
  assert.deepEqual(publish.args.slice(0, 3), ["publish", "--tag", "pr-5"]);
  const posted = run.api.requests.find((request) => request.method === "POST" && request.url.includes("/comments"));
  assert.ok(posted, "expected a new PR comment");
  assert.match(posted.body, /@async\/pipeline@npm:@async-framework\/pipeline@pr-5/);
  assert.match(posted.body, /0\.0\.0-pr\.5\.sha\./);
});

test("an existing marker comment is updated in place instead of duplicated", async () => {
  const run = await runScript("pr", {
    event: prEvent("async-framework/async-pipeline"),
    env: { __comments: [{ id: 7, body: "<!-- github-packages-pr-preview --> old", user: { login: "github-actions[bot]" } }] }
  });
  assert.equal(run.status, 0, run.stderr);
  const patched = run.api.requests.find((request) => request.method === "PATCH");
  assert.ok(patched, "expected the marker comment to be PATCHed");
  assert.match(patched.url, /\/issues\/comments\/7$/);
  assert.equal(run.api.requests.some((request) => request.method === "POST" && request.url.includes("/comments")), false);
});

test("a stale PR head publishes the immutable version but does not move the tag or comment", async () => {
  const run = await runScript("pr", {
    event: prEvent("async-framework/async-pipeline"),
    env: { __prHeadSha: OTHER_SHA }
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.calls.some((call) => call.args[0] === "publish"), true);
  assert.equal(run.calls.some((call) => call.args[0] === "dist-tag"), false);
  assert.equal(run.api.requests.some((request) => request.method === "POST" && request.url.includes("/comments")), false);
  assert.match(run.stdout, /Not moving pr-5/);
});

// --- main mode -------------------------------------------------------------
test("main snapshots publish 0.0.0-main.sha.<sha> and move the main tag while current", async () => {
  const run = await runScript("main", { env: { GITHUB_SHA: HEAD_SHA } });
  assert.equal(run.status, 0, run.stderr);
  const publish = run.calls.find((call) => call.args[0] === "publish");
  assert.equal(publish.manifest.version, `0.0.0-main.sha.${HEAD_SHA}`);
  assert.deepEqual(publish.args.slice(0, 3), ["publish", "--tag", "main"]);
  assert.equal(run.calls.some((call) => call.args[0] === "dist-tag"), true);
});

test("PROMISE: a superseded main snapshot never drags the main tag backwards", async () => {
  const run = await runScript("main", { env: { GITHUB_SHA: HEAD_SHA, __branchSha: OTHER_SHA } });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.calls.some((call) => call.args[0] === "publish"), true);
  assert.equal(run.calls.some((call) => call.args[0] === "dist-tag"), false);
  assert.match(run.stdout, /Not moving main/);
});
