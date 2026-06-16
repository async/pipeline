import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const cliPath = join(repoRoot, "packages/pipeline-node/dist/cli.js");
const manifest = JSON.parse(readFileSync(join(repoRoot, "packages", "pipeline", "package.json"), "utf8"));
const changelog = readFileSync(join(repoRoot, "CHANGELOG.md"), "utf8");
const HEAD_SHA = "a".repeat(40);
const TOKEN = "fake-lifecycle-token-do-not-echo";

let server;
let apiUrl;
let apiState;

function expectedReleaseBody(version = manifest.version) {
  const headingPattern = /^##[ \t]+(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)[ \t]+-[ \t]+(.+?)[ \t]*$/gm;
  const headings = [...changelog.matchAll(headingPattern)];
  const index = headings.findIndex((heading) => heading[1] === version);
  assert.notEqual(index, -1, `expected CHANGELOG.md to include ${version}`);
  const heading = headings[index];
  const start = heading.index + heading[0].length;
  const end = index + 1 < headings.length ? headings[index + 1].index : changelog.length;
  const body = changelog.slice(start, end).trim();
  return [
    `Release notes from \`CHANGELOG.md\` for ${version} (${heading[2].trim()}).`,
    "",
    body,
    "",
    "---",
    `Source: \`CHANGELOG.md\` in tag \`v${version}\`.`,
    ""
  ].join("\n");
}

function releaseFixture(version = manifest.version, { id = 1, body = expectedReleaseBody(version), tagName = `v${version}` } = {}) {
  return {
    id,
    tag_name: tagName,
    name: `@async/pipeline ${tagName}`,
    body,
    draft: false,
    prerelease: version.includes("-")
  };
}

function defaultReleases() {
  return [
    releaseFixture(manifest.version, { id: 1 }),
    releaseFixture("0.7.0", { id: 2 }),
    releaseFixture(manifest.version, { id: 3, tagName: "nightly", body: "Manual non-semver release notes." })
  ];
}

function resetApi() {
  apiState = {
    requests: [],
    branchSha: HEAD_SHA,
    prHeadSha: HEAD_SHA,
    comments: [],
    tagSha: HEAD_SHA,
    releases: defaultReleases(),
    nextReleaseId: 100
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
      if (request.url.includes("/comments") && request.method === "POST") return respond(201, { id: 1 });
      if (request.url.includes("/comments") && request.method === "PATCH") return respond(200, { id: 1 });
      if (request.method === "GET" && request.url.includes(`/git/ref/tags/v${manifest.version}`)) {
        return apiState.tagSha
          ? respond(200, { object: { type: "commit", sha: apiState.tagSha } })
          : respond(404, { message: "Not Found" });
      }
      if (request.method === "POST" && request.url.includes("/git/refs")) {
        const payload = JSON.parse(body || "{}");
        apiState.tagSha = payload.sha;
        return respond(201, { ref: payload.ref, object: { type: "commit", sha: payload.sha } });
      }
      if (request.method === "GET" && request.url.includes("/releases/tags/")) {
        const tagName = decodeURIComponent(request.url.split("/releases/tags/")[1].split("?")[0]);
        const release = apiState.releases.find((entry) => entry.tag_name === tagName);
        return release ? respond(200, release) : respond(404, { message: "Not Found" });
      }
      if (request.method === "GET" && request.url.includes("/releases")) {
        const url = new URL(request.url, "http://localhost");
        const perPage = Number(url.searchParams.get("per_page") ?? 100);
        const page = Number(url.searchParams.get("page") ?? 1);
        const start = (page - 1) * perPage;
        return respond(200, apiState.releases.slice(start, start + perPage));
      }
      if (request.method === "POST" && request.url.includes("/releases")) {
        const payload = JSON.parse(body || "{}");
        const release = { id: apiState.nextReleaseId, ...payload, html_url: "https://github.test/release" };
        apiState.nextReleaseId += 1;
        apiState.releases.push(release);
        return respond(201, release);
      }
      if (request.method === "PATCH" && /\/releases\/\d+$/.test(request.url)) {
        const id = Number(request.url.split("/").at(-1));
        const release = apiState.releases.find((entry) => entry.id === id);
        if (!release) return respond(404, { message: "Not Found" });
        Object.assign(release, JSON.parse(body || "{}"));
        return respond(200, release);
      }
      respond(404, { message: "unexpected route" });
    });
  });
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  apiUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
    server.closeAllConnections?.();
  });
});

function makeNpmShim(dir) {
  const shim = join(dir, "npm");
  writeFileSync(
    shim,
    [
      "#!/usr/bin/env node",
      "const { appendFileSync, readFileSync, writeFileSync } = require(\"node:fs\");",
      "const { join } = require(\"node:path\");",
      "const args = process.argv.slice(2);",
      "const record = { args, cwd: process.cwd() };",
      "try { record.userconfig = readFileSync(process.env.NPM_CONFIG_USERCONFIG, \"utf8\"); } catch {}",
      "try { record.manifest = JSON.parse(readFileSync(join(process.cwd(), \"package.json\"), \"utf8\")); } catch {}",
      "appendFileSync(process.env.NPM_SHIM_LOG, JSON.stringify(record) + \"\\n\");",
      "if (args[0] === \"view\") {",
      "  const countPath = process.env.NPM_SHIM_VIEW_COUNT;",
      "  const transientFailures = Number(process.env.NPM_SHIM_VIEW_FAILS_BEFORE_SUCCESS ?? 0);",
      "  let count = 0;",
      "  try { count = Number(readFileSync(countPath, \"utf8\")); } catch {}",
      "  if (count < transientFailures) {",
      "    try { writeFileSync(countPath, String(count + 1)); } catch {}",
      "    console.error(\"npm error code E404\\nnpm error 404 No match found for version\");",
      "    process.exit(1);",
      "  }",
      "  const exit = Number(process.env.NPM_SHIM_VIEW_EXIT ?? 1);",
      "  if (exit === 0) console.log(process.env.NPM_SHIM_VIEW_VERSION ?? \"0.0.0\");",
      "  else console.error(process.env.NPM_SHIM_VIEW_ERROR === \"1\" ? \"npm error network ECONNRESET\" : \"npm error code E404\\nnpm error 404 Not Found\");",
      "  process.exit(exit);",
      "}",
      "if (args[0] === \"publish\") process.exit(Number(process.env.NPM_SHIM_PUBLISH_EXIT ?? 0));",
      "if (args[0] === \"access\") process.exit(Number(process.env.NPM_SHIM_ACCESS_EXIT ?? 0));",
      "process.exit(Number(process.env.NPM_SHIM_DISTTAG_EXIT ?? 0));"
    ].join("\n"),
    "utf8"
  );
  chmodSync(shim, 0o755);
}

async function runCli(args, { env = {}, api = {}, event, cwd = repoRoot } = {}) {
  resetApi();
  Object.assign(apiState, api);
  const dir = mkdtempSync(join(tmpdir(), "async-pipeline-lifecycle-test-"));
  try {
    makeNpmShim(dir);
    const logPath = join(dir, "npm-calls.jsonl");
    const viewCountPath = join(dir, "npm-view-count.txt");
    writeFileSync(logPath, "", "utf8");
    writeFileSync(viewCountPath, "0", "utf8");
    let eventPath;
    if (event) {
      eventPath = join(dir, "event.json");
      writeFileSync(eventPath, JSON.stringify(event), "utf8");
    }
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        HOME: process.env.HOME,
        NPM_SHIM_LOG: logPath,
        NPM_SHIM_VIEW_COUNT: viewCountPath,
        GITHUB_REPOSITORY: "async/pipeline",
        GITHUB_REPOSITORY_OWNER: "async",
        GITHUB_API_URL: apiUrl,
        GITHUB_TOKEN: TOKEN,
        ...(eventPath ? { GITHUB_EVENT_PATH: eventPath } : {}),
        ...env
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

test("lifecycle CLI publishes GitHub Packages snapshots from a package path", async () => {
  const run = await runCli(["publish", "github", "main", "--package", "packages/pipeline"], {
    env: { GITHUB_SHA: HEAD_SHA }
  });

  assert.equal(run.status, 0, run.stderr);
  const publish = run.calls.find((call) => call.args[0] === "publish");
  assert.ok(publish, "expected npm publish to run");
  assert.equal(publish.manifest.name, "@async/pipeline");
  assert.equal(publish.manifest.version, `0.0.0-main.sha.${HEAD_SHA}`);
  assert.deepEqual(publish.args.slice(0, 3), ["publish", "--tag", "main"]);
  assert.equal(run.calls.some((call) => call.args[0] === "dist-tag"), true);
  assert.equal(run.api.requests.some((request) => request.url.includes("/branches/main")), true);
});

test("lifecycle CLI accepts custom GitHub package registry and namespace", async () => {
  const run = await runCli([
    "publish",
    "github",
    "pr",
    "--package",
    "packages/pipeline",
    "--registry",
    "https://registry.example.test",
    "--namespace",
    "preview"
  ], {
    event: prEvent("async/pipeline")
  });

  assert.equal(run.status, 0, run.stderr);
  const publish = run.calls.find((call) => call.args[0] === "publish");
  assert.ok(publish, "expected npm publish to run");
  assert.equal(publish.manifest.name, "@preview/pipeline");
  assert.equal(publish.manifest.publishConfig.registry, "https://registry.example.test");
  assert.deepEqual(publish.args.slice(-2), ["--registry", "https://registry.example.test"]);
  assert.match(publish.userconfig, /@preview:registry=https:\/\/registry\.example\.test/);
  const posted = run.api.requests.find((request) => request.method === "POST" && request.url.includes("/comments"));
  assert.ok(posted, "expected a PR preview comment");
  assert.match(posted.body, /@preview\/pipeline/);
  assert.match(posted.body, /@preview:registry=https:\/\/registry\.example\.test/);
});

test("lifecycle CLI skips npm publish for an already published package and keeps public access", async () => {
  const run = await runCli(["publish", "npm", "--package", "packages/pipeline"], {
    env: {
      NODE_AUTH_TOKEN: TOKEN,
      NPM_SHIM_VIEW_EXIT: "0",
      NPM_SHIM_VIEW_VERSION: manifest.version
    }
  });

  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.calls.some((call) => call.args[0] === "publish"), false);
  assert.equal(run.calls.some((call) => call.args[0] === "access"), true);
  assert.match(run.stdout, /already published to npm/);
});

test("lifecycle CLI token-backed npm publish uses a temporary npmjs auth config", async () => {
  const run = await runCli(["publish", "npm", "--package", "packages/pipeline"], {
    env: {
      NODE_AUTH_TOKEN: TOKEN
    }
  });

  assert.equal(run.status, 0, run.stderr);
  const publish = run.calls.find((call) => call.args[0] === "publish");
  assert.ok(publish, "expected npm publish to run");
  assert.match(publish.userconfig, /\/\/registry\.npmjs\.org\/:_authToken=fake-lifecycle-token-do-not-echo/);
  assert.equal(run.calls.some((call) => call.args[0] === "access"), true);
});

test("lifecycle CLI tokenless npm publish leaves auth to trusted publishing and skips access", async () => {
  const run = await runCli(["publish", "npm", "--package", "packages/pipeline"]);

  assert.equal(run.status, 0, run.stderr);
  const publish = run.calls.find((call) => call.args[0] === "publish");
  assert.ok(publish, "expected npm publish to run");
  assert.equal(publish.userconfig, undefined);
  assert.equal(run.calls.some((call) => call.args[0] === "access"), false);
  assert.match(run.stdout, /trusted publishing only authenticates npm publish/);
});

test("lifecycle CLI release ensure creates a missing tag and GitHub Release", async () => {
  const run = await runCli(["release", "ensure", "--package", "packages/pipeline"], {
    env: { GITHUB_SHA: HEAD_SHA },
    api: { tagSha: undefined, releases: defaultReleases().filter((release) => release.tag_name !== `v${manifest.version}`) }
  });

  assert.equal(run.status, 0, run.stderr);
  const createTag = run.api.requests.find((request) => request.method === "POST" && request.url.includes("/git/refs"));
  assert.ok(createTag, "expected release ensure to create a Git ref");
  assert.deepEqual(JSON.parse(createTag.body), { ref: `refs/tags/v${manifest.version}`, sha: HEAD_SHA });
  const createRelease = run.api.requests.find((request) => request.method === "POST" && request.url.includes("/releases"));
  assert.ok(createRelease, "expected release ensure to create a GitHub Release");
  const createPayload = JSON.parse(createRelease.body);
  assert.equal(createPayload.tag_name, `v${manifest.version}`);
  assert.equal(createPayload.body, expectedReleaseBody(manifest.version));
  assert.match(run.stdout, /Created Git tag/);
  assert.match(run.stdout, /Created GitHub Release/);
});

test("lifecycle CLI release ensure updates stale GitHub Release notes from CHANGELOG", async () => {
  const run = await runCli(["release", "ensure", "--package", "packages/pipeline"], {
    env: { GITHUB_SHA: HEAD_SHA },
    api: { releases: [releaseFixture(manifest.version, { id: 1, body: "stale notes" }), releaseFixture("0.7.0", { id: 2 })] }
  });

  assert.equal(run.status, 0, run.stderr);
  const patch = run.api.requests.find((request) => request.method === "PATCH" && request.url.endsWith("/releases/1"));
  assert.ok(patch, "expected release ensure to patch stale release notes");
  assert.equal(JSON.parse(patch.body).body, expectedReleaseBody(manifest.version));
  assert.match(run.stdout, /Updated GitHub Release notes/);
});

test("lifecycle CLI release ensure syncs multiple semver GitHub Release notes", async () => {
  const run = await runCli(["release", "ensure", "--package", "packages/pipeline"], {
    env: { GITHUB_SHA: HEAD_SHA },
    api: {
      releases: [
        releaseFixture(manifest.version, { id: 1, body: "current stale" }),
        releaseFixture("0.7.0", { id: 2, body: "historical stale" }),
        releaseFixture(manifest.version, { id: 3, tagName: "nightly", body: "custom notes" })
      ]
    }
  });

  assert.equal(run.status, 0, run.stderr);
  const patches = run.api.requests.filter((request) => request.method === "PATCH" && request.url.includes("/releases/"));
  assert.equal(patches.length, 2);
  assert.equal(JSON.parse(patches.find((request) => request.url.endsWith("/releases/1")).body).body, expectedReleaseBody(manifest.version));
  assert.equal(JSON.parse(patches.find((request) => request.url.endsWith("/releases/2")).body).body, expectedReleaseBody("0.7.0"));
  assert.equal(run.api.releases.find((release) => release.tag_name === "nightly").body, "custom notes");
});

test("lifecycle CLI release ensure fails when a semver GitHub Release has no CHANGELOG section", async () => {
  const run = await runCli(["release", "ensure", "--package", "packages/pipeline"], {
    env: { GITHUB_SHA: HEAD_SHA },
    api: { releases: [releaseFixture(manifest.version, { id: 1 }), releaseFixture("9.9.9", { id: 2, body: "orphan release notes" })] }
  });

  assert.equal(run.status, 1);
  assert.match(run.stderr, /v9\.9\.9 has no parseable, non-empty CHANGELOG\.md section/);
  assert.equal(run.api.requests.some((request) => request.method === "PATCH" && request.url.includes("/releases/")), false);
});

test("lifecycle CLI release ensure rejects changelog headings without same-line dates", async () => {
  const dir = mkdtempSync(join(tmpdir(), "async-pipeline-lifecycle-malformed-changelog-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@async/malformed", version: "1.2.3", type: "module" }, null, 2), "utf8");
    writeFileSync(join(dir, "CHANGELOG.md"), "# Changelog\n\n## 1.2.3\n\n- Missing heading date.\n", "utf8");
    writeFileSync(
      join(dir, "pipeline.js"),
      `import { definePipeline } from ${JSON.stringify(join(repoRoot, "packages", "pipeline", "dist", "index.js"))};\nexport default definePipeline({ tasks: {}, jobs: {} });\n`,
      "utf8"
    );

    const run = await runCli(["release", "ensure", "--package", "."], {
      cwd: dir,
      env: { GITHUB_REPOSITORY: "async/malformed", GITHUB_SHA: HEAD_SHA }
    });

    assert.equal(run.status, 1);
    assert.match(run.stderr, /CHANGELOG\.md has no parseable, non-empty "## 1\.2\.3 - <date>" entry/);
    assert.equal(run.api.requests.some((request) => request.method === "POST"), false);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("lifecycle CLI release ensure refuses to move an existing release tag", async () => {
  const otherSha = "b".repeat(40);
  const run = await runCli(["release", "ensure", "--package", "packages/pipeline"], {
    env: { GITHUB_SHA: HEAD_SHA },
    api: { tagSha: otherSha, releaseExists: false }
  });

  assert.equal(run.status, 1);
  assert.match(run.stderr, new RegExp(`already points to ${otherSha}`));
  assert.equal(run.api.requests.some((request) => request.method === "POST" && request.url.includes("/git/refs")), false);
  assert.equal(run.api.requests.some((request) => request.method === "POST" && request.url.includes("/releases")), false);
});

test("lifecycle CLI release doctor verifies npm, GitHub Packages, GitHub Release, and release notes", async () => {
  const run = await runCli(["release", "doctor", "--package", "packages/pipeline"], {
    env: {
      NPM_SHIM_VIEW_EXIT: "0",
      NPM_SHIM_VIEW_VERSION: manifest.version
    }
  });

  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.calls.filter((call) => call.args[0] === "view").length, 2);
  assert.equal(run.calls.some((call) => call.userconfig?.includes("_authToken")), true, "GitHub Packages check must use token auth");
  assert.equal(run.api.requests.some((request) => request.url.includes(`/releases/tags/v${manifest.version}`)), true);
  assert.equal(run.api.requests.some((request) => request.method === "GET" && request.url.includes("/releases?per_page=100")), true);
  assert.match(run.stdout, /Release doctor passed/);
});

test("lifecycle CLI release doctor fails when GitHub Release notes drift from CHANGELOG", async () => {
  const run = await runCli(["release", "doctor", "--package", "packages/pipeline"], {
    env: {
      NPM_SHIM_VIEW_EXIT: "0",
      NPM_SHIM_VIEW_VERSION: manifest.version
    },
    api: { releases: [releaseFixture(manifest.version, { id: 1, body: "stale notes" }), releaseFixture("0.7.0", { id: 2 })] }
  });

  assert.equal(run.status, 1);
  assert.match(run.stderr, new RegExp(`GitHub Release descriptions do not match CHANGELOG\\.md: v${manifest.version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} body differs`));
});

test("lifecycle CLI release doctor retries registry propagation misses", async () => {
  const run = await runCli(["release", "doctor", "--package", "packages/pipeline"], {
    env: {
      NPM_SHIM_VIEW_EXIT: "0",
      NPM_SHIM_VIEW_FAILS_BEFORE_SUCCESS: "1",
      NPM_SHIM_VIEW_VERSION: manifest.version,
      ASYNC_PIPELINE_RELEASE_DOCTOR_REGISTRY_ATTEMPTS: "3",
      ASYNC_PIPELINE_RELEASE_DOCTOR_REGISTRY_RETRY_DELAY_MS: "1"
    }
  });

  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.calls.filter((call) => call.args[0] === "view").length, 3);
  assert.match(run.stdout, /Waiting for npm to expose/);
  assert.match(run.stdout, /Release doctor passed/);
});
