import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { chmod, cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

const GITHUB_REGISTRY = "https://npm.pkg.github.com";
const NPM_REGISTRY = "https://registry.npmjs.org/";
const COMMENT_MARKER = "<!-- github-packages-pr-preview -->";
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const NAME_PATTERN = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const RELEASE_DOCTOR_REGISTRY_ATTEMPTS = 12;
const RELEASE_DOCTOR_REGISTRY_RETRY_DELAY_MS = 5000;

export type GitHubPackagePublishMode = "pr" | "main" | "release";

export interface PackageLifecycleIO {
  stdout(text: string): void;
  stderr(text: string): void;
}

export interface PackageLifecycleOptions {
  cwd: string;
  packagePath: string;
  registry?: string;
  namespace?: string;
  comment?: boolean;
  env: NodeJS.ProcessEnv;
  io: PackageLifecycleIO;
}

interface PackageManifest {
  name: string;
  version: string;
  private?: boolean;
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
  publishConfig?: Record<string, unknown>;
  bin?: Record<string, string>;
  [key: string]: unknown;
}

interface PackageContext {
  packageDir: string;
  manifest: PackageManifest;
}

export async function publishGitHubPackage(mode: GitHubPackagePublishMode, options: PackageLifecycleOptions): Promise<void> {
  const context = await readPackageContext(options.cwd, options.packagePath);
  const { packageDir, manifest } = context;
  assertPublicPackage(manifest);

  const repository = options.env.GITHUB_REPOSITORY ?? packageRepositoryName(manifest) ?? "";
  const owner = (options.namespace ?? options.env.GITHUB_REPOSITORY_OWNER ?? repository.split("/")[0] ?? "").toLowerCase();
  const registry = normalizeRegistry(options.registry ?? GITHUB_REGISTRY);
  const shouldComment = options.comment ?? true;
  if (!repository || !owner) {
    throw new Error("Set GITHUB_REPOSITORY or package.json repository so GitHub Packages publishing can resolve the repository owner.");
  }

  const mirrorName = githubMirrorPackageName(manifest.name, owner);
  const token = options.env.GITHUB_TOKEN ?? options.env.NODE_AUTH_TOKEN;
  const apiBase = (options.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");
  const releaseContext = await resolveGitHubPublishContext(mode, { manifest, repository, env: options.env, io: options.io });

  if (!token) {
    throw new Error("Set GITHUB_TOKEN (or NODE_AUTH_TOKEN) with packages:write to publish to GitHub Packages.");
  }
  if (!existsSync(join(packageDir, "dist"))) {
    throw new Error(`${relativeLabel(options.cwd, packageDir)}/dist is missing. Build before publishing.`);
  }

  const stagingDir = await mkdtemp(join(tmpdir(), "async-pipeline-github-publish-"));
  try {
    const staged = {
      ...manifest,
      name: mirrorName,
      version: releaseContext.version,
      publishConfig: { registry }
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

    const registryUrl = new URL(registry);
    const registryAuthPath = `${registryUrl.host}${registryUrl.pathname.replace(/\/$/, "")}`;
    const npmConfig = join(stagingDir, ".github-packages.npmrc");
    await writeFile(npmConfig, `@${owner}:registry=${registry}\n//${registryAuthPath}/:_authToken=${token}\n`, "utf8");
    await chmod(npmConfig, 0o600);

    const npm = (args: string[], runOptions: { capture?: boolean } = {}): SpawnSyncReturns<string> => spawnSync("npm", args, {
      cwd: stagingDir,
      stdio: runOptions.capture ? ["ignore", "pipe", "pipe"] : "inherit",
      encoding: "utf8",
      env: { ...options.env, NPM_CONFIG_USERCONFIG: npmConfig }
    });

    const spec = `${mirrorName}@${releaseContext.version}`;
    const view = npm(["view", spec, "version", "--registry", registry], { capture: true });
    const viewOutput = npmOutput(view);
    const exists = view.status === 0;
    if (!exists && !isMissingVersion(view)) {
      options.io.stderr(viewOutput.slice(0, 2000));
      throw new Error(`Could not check whether ${spec} already exists on GitHub Packages; refusing to guess. See npm output above.`);
    }
    if (exists) {
      options.io.stdout(`${spec} already exists on GitHub Packages; skipping publish.\n`);
    } else {
      options.io.stdout(`Publishing ${spec} to GitHub Packages with tag ${releaseContext.distTag}.\n`);
      const publish = npm(["publish", "--tag", releaseContext.distTag, "--ignore-scripts", "--registry", registry]);
      if (publish.status !== 0) {
        throw new Error(`Failed to publish ${spec} to GitHub Packages. Check the job's packages:write permission, package visibility, and whether this immutable version already exists.`);
      }
    }

    const moveDistTag = (): void => {
      const result = npm(["dist-tag", "add", spec, releaseContext.distTag, "--registry", registry]);
      if (result.status !== 0) {
        throw new Error(`Failed to move GitHub Packages dist-tag ${releaseContext.distTag} to ${spec}.`);
      }
    };

    const ghApi = async (path: string, init: RequestInit = {}): Promise<unknown> => {
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
    };

    if (mode === "release") {
      moveDistTag();
    } else if (mode === "main") {
      const branch = await guardedApi(() => ghApi(`/repos/${repository}/branches/main`), "Could not read the current main branch head");
      const branchSha = asRecord(asRecord(branch).commit).sha;
      if (branchSha === options.env.GITHUB_SHA) {
        moveDistTag();
      } else {
        options.io.stdout(`::notice::Not moving ${releaseContext.distTag}: main moved from ${options.env.GITHUB_SHA} to ${String(branchSha)}.\n`);
      }
    } else {
      const pr = releaseContext.prContext;
      if (!pr) throw new Error("Internal error: missing PR context.");
      const pull = await guardedApi(() => ghApi(`/repos/${repository}/pulls/${pr.number}`), "Could not read the current PR head");
      const currentHead = asRecord(asRecord(pull).head).sha;
      if (currentHead !== pr.headSha) {
        options.io.stdout(`::notice::Not moving ${releaseContext.distTag}: PR head moved from ${pr.headSha} to ${String(currentHead)}.\n`);
        return;
      }
      moveDistTag();
      if (!shouldComment) {
        options.io.stdout("Skipping PR preview comment.\n");
        return;
      }

      const installTarget = (versionOrTag: string): string => {
        const target = `${mirrorName}@${versionOrTag}`;
        return mirrorName === manifest.name ? target : `${manifest.name}@npm:${target}`;
      };
      const body = [
        COMMENT_MARKER,
        "### Preview package",
        "",
        `Preview for PR head \`${pr.headSha}\` (built from its merge with main), published to GitHub Packages as \`${mirrorName}\`.`,
        "",
        "Latest successful build for this PR:",
        "```sh",
        `pnpm add ${installTarget(releaseContext.distTag)}`,
        "```",
        "",
        "Exact commit build:",
        "```sh",
        `pnpm add ${installTarget(releaseContext.version)}`,
        "```",
        "",
        `Requires GitHub Packages auth and \`@${owner}:registry=${registry}\` in your npm config.`
      ].join("\n");
      const comments = await guardedApi(() => ghApi(`/repos/${repository}/issues/${pr.number}/comments?per_page=100`), "Could not list PR comments");
      const previous = Array.isArray(comments)
        ? comments.find((comment) => {
            const record = asRecord(comment);
            return typeof record.body === "string"
              && record.body.includes(COMMENT_MARKER)
              && asRecord(record.user).login === "github-actions[bot]";
          })
        : undefined;
      if (previous) {
        await guardedApi(() => ghApi(`/repos/${repository}/issues/comments/${String(asRecord(previous).id)}`, { method: "PATCH", body: JSON.stringify({ body }) }), "Failed to update the PR preview comment");
      } else {
        await guardedApi(() => ghApi(`/repos/${repository}/issues/${pr.number}/comments`, { method: "POST", body: JSON.stringify({ body }) }), "Failed to create the PR preview comment");
      }
    }

    options.io.stdout(`GitHub Packages ${mode} publish complete: ${spec} (${releaseContext.distTag}).\n`);
  } finally {
    rmSync(stagingDir, { force: true, recursive: true });
  }
}

export async function publishNpmPackage(options: PackageLifecycleOptions): Promise<void> {
  const { packageDir, manifest } = await readPackageContext(options.cwd, options.packagePath);
  assertPublicPackage(manifest);
  const spec = `${manifest.name}@${manifest.version}`;
  const auth = await prepareNpmPublishAuth(options);
  try {
    const npm = (args: string[], runOptions: { inherit?: boolean } = {}): SpawnSyncReturns<string> => spawnSync("npm", args, {
      cwd: packageDir,
      encoding: "utf8",
      stdio: runOptions.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
      env: {
        ...auth.env,
        NPM_CONFIG_CACHE: options.env.NPM_CONFIG_CACHE ?? join(options.cwd, ".async", "npm-cache")
      }
    });

    const ensurePublicAccess = (): void => {
      if (!auth.hasTraditionalAuth) {
        options.io.stdout("Skipping npm access public check because no npm token is configured; trusted publishing only authenticates npm publish.\n");
        return;
      }
      options.io.stdout(`Ensuring ${manifest.name} is public on npm.\n`);
      const access = npm(["access", "set", "status=public", manifest.name, "--registry", NPM_REGISTRY], { inherit: true });
      if (access.status !== 0) {
        throw new Error(`Failed to set npm package access for ${manifest.name}.`);
      }
    };

    const view = npm(["view", spec, "version", "--registry", NPM_REGISTRY]);
    if (view.status === 0 && view.stdout.trim() === manifest.version) {
      ensurePublicAccess();
      options.io.stdout(`${spec} is already published to npm; skipping.\n`);
      return;
    }
    if (!isMissingVersion(view)) {
      options.io.stderr(npmOutput(view).slice(0, 2000));
      throw new Error(`Could not determine whether ${spec} exists on npm; refusing to guess.`);
    }

    options.io.stdout(`Publishing ${spec} to npm with provenance.\n`);
    const publish = npm(["publish", "--access", "public", "--registry", NPM_REGISTRY, "--provenance"], { inherit: true });
    if (publish.status !== 0) {
      throw new Error(`Failed to publish ${spec} to npm.`);
    }
    ensurePublicAccess();
  } finally {
    if (auth.cleanupDir) rmSync(auth.cleanupDir, { force: true, recursive: true });
  }
}

export async function ensureGitHubRelease(options: PackageLifecycleOptions): Promise<void> {
  const { manifest } = await readPackageContext(options.cwd, options.packagePath);
  assertPublicPackage(manifest);
  if (!SEMVER_PATTERN.test(manifest.version)) {
    throw new Error(`${manifest.name} version must be simple semver for release creation. Found: ${manifest.version}`);
  }

  const repository = options.env.GITHUB_REPOSITORY ?? packageRepositoryName(manifest);
  if (!repository) {
    throw new Error("Set GITHUB_REPOSITORY or package.json repository so release creation can resolve GitHub state.");
  }
  const token = options.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("Set GITHUB_TOKEN with contents:write so release creation can create tags and GitHub Releases.");
  }
  const targetSha = options.env.GITHUB_SHA;
  if (!targetSha || !SHA_PATTERN.test(targetSha)) {
    throw new Error("Set GITHUB_SHA to the commit that the release tag should point at.");
  }

  const apiBase = (options.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");
  const tagName = `v${manifest.version}`;
  const encodedTagName = encodeURIComponent(tagName);
  const ghApi = async (path: string, init: RequestInit = {}, allowMissing = false): Promise<unknown | undefined> => {
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
    if (allowMissing && response.status === 404) return undefined;
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GitHub API ${init.method ?? "GET"} ${path} failed with ${response.status}: ${text.slice(0, 500)}`);
    }
    return response.status === 204 ? null : response.json();
  };

  const resolveRefCommit = async (ref: unknown): Promise<string> => {
    const object = asRecord(asRecord(ref).object);
    const type = object.type;
    const sha = object.sha;
    if (type === "commit" && typeof sha === "string") return sha;
    if (type === "tag" && typeof sha === "string") {
      const tag = await ghApi(`/repos/${repository}/git/tags/${sha}`);
      const target = asRecord(asRecord(tag).object);
      if (target.type === "commit" && typeof target.sha === "string") return target.sha;
    }
    throw new Error(`Release tag ${tagName} points to an unsupported Git object.`);
  };

  const existingRef = await ghApi(`/repos/${repository}/git/ref/tags/${encodedTagName}`, {}, true);
  if (existingRef) {
    const existingSha = await resolveRefCommit(existingRef);
    if (existingSha !== targetSha) {
      throw new Error(`Release tag ${tagName} already points to ${existingSha}; refusing to move it to ${targetSha}.`);
    }
    options.io.stdout(`OK Git tag: ${tagName} -> ${targetSha}\n`);
  } else {
    await ghApi(`/repos/${repository}/git/refs`, {
      method: "POST",
      body: JSON.stringify({ ref: `refs/tags/${tagName}`, sha: targetSha })
    });
    options.io.stdout(`Created Git tag ${tagName} -> ${targetSha}.\n`);
  }

  const existingRelease = await ghApi(`/repos/${repository}/releases/tags/${encodedTagName}`, {}, true);
  if (existingRelease) {
    options.io.stdout(`OK GitHub Release: ${repository}@${tagName}\n`);
  } else {
    await ghApi(`/repos/${repository}/releases`, {
      method: "POST",
      body: JSON.stringify({
        tag_name: tagName,
        target_commitish: targetSha,
        name: `${manifest.name} ${tagName}`,
        body: `Release ${manifest.name}@${manifest.version}.`,
        draft: false,
        prerelease: manifest.version.includes("-")
      })
    });
    options.io.stdout(`Created GitHub Release ${repository}@${tagName}.\n`);
  }
}

export async function runReleaseDoctor(options: PackageLifecycleOptions): Promise<void> {
  const { manifest } = await readPackageContext(options.cwd, options.packagePath);
  assertPublicPackage(manifest);
  if (!SEMVER_PATTERN.test(manifest.version)) {
    throw new Error(`${manifest.name} version must be simple semver for release doctor. Found: ${manifest.version}`);
  }

  const repository = options.env.GITHUB_REPOSITORY ?? packageRepositoryName(manifest);
  const owner = (options.env.GITHUB_REPOSITORY_OWNER ?? repository?.split("/")[0] ?? "").toLowerCase();
  if (!repository || !owner) {
    throw new Error("Set GITHUB_REPOSITORY or package.json repository so release doctor can resolve GitHub state.");
  }

  const npmPackage = `${manifest.name}@${manifest.version}`;
  const githubPackage = `${githubMirrorPackageName(manifest.name, owner)}@${manifest.version}`;
  assertReleaseTagMatches(manifest, options.env);
  await assertRegistryVersion(npmPackage, NPM_REGISTRY, options, "npm");
  await assertRegistryVersion(githubPackage, GITHUB_REGISTRY, options, "GitHub Packages");
  await assertGitHubRelease(repository, manifest.version, options);
  options.io.stdout(`Release doctor passed for ${manifest.name}@${manifest.version}.\n`);
}

async function resolveGitHubPublishContext(
  mode: GitHubPackagePublishMode,
  options: { manifest: PackageManifest; repository: string; env: NodeJS.ProcessEnv; io: PackageLifecycleIO }
): Promise<{ version: string; distTag: string; prContext?: { number: number; headSha: string } }> {
  if (mode === "release") {
    if (!SEMVER_PATTERN.test(options.manifest.version)) {
      throw new Error(`${options.manifest.name} version must be simple semver for a stable mirror. Found: ${options.manifest.version}`);
    }
    assertReleaseTagMatches(options.manifest, options.env);
    return { version: options.manifest.version, distTag: "latest" };
  }
  if (mode === "main") {
    const sha = options.env.GITHUB_SHA;
    if (!sha || !SHA_PATTERN.test(sha)) {
      throw new Error("main mode needs GITHUB_SHA (40-char lowercase hex). Run it from the generated workflow on a push to main.");
    }
    return { version: `0.0.0-main.sha.${sha}`, distTag: "main" };
  }
  const event = await readGitHubEvent(options.env, "pr mode needs GITHUB_EVENT_PATH with a pull_request payload. Run it from the generated workflow on a pull request.");
  const pullRequest = asRecord(event).pull_request;
  const number = Number(asRecord(pullRequest).number ?? asRecord(event).number);
  const head = asRecord(asRecord(pullRequest).head);
  const headSha = head.sha;
  const headRepo = asRecord(head.repo).full_name;
  if (!Number.isInteger(number) || number <= 0 || typeof headSha !== "string" || !SHA_PATTERN.test(headSha)) {
    throw new Error("pr mode could not read a positive number and head.sha from the pull_request payload.");
  }
  if (headRepo !== options.repository) {
    options.io.stdout(`Skipping preview publish: PR #${number} head is ${typeof headRepo === "string" ? headRepo : "a deleted repo"}, not ${options.repository}.\n`);
    return Promise.reject(new LifecycleSkip());
  }
  return {
    version: `0.0.0-pr.${number}.sha.${headSha}`,
    distTag: `pr-${number}`,
    prContext: { number, headSha }
  };
}

export async function runLifecycleCli(action: () => Promise<void>, io: PackageLifecycleIO): Promise<number> {
  try {
    await action();
    return 0;
  } catch (error) {
    if (error instanceof LifecycleSkip) return 0;
    io.stderr(`::error::${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function readPackageContext(cwd: string, packagePath: string): Promise<PackageContext> {
  const packageDir = resolve(cwd, packagePath);
  const relativePackageDir = relative(cwd, packageDir);
  if (relativePackageDir === ".." || relativePackageDir.startsWith("../") || relativePackageDir.startsWith("..\\") || isAbsolute(relativePackageDir)) {
    throw new Error(`Package path "${packagePath}" must stay inside ${cwd}.`);
  }
  const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")) as PackageManifest;
  if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
    throw new Error(`${relativeLabel(cwd, packageDir)}/package.json must include name and version.`);
  }
  return { packageDir, manifest };
}

function assertPublicPackage(manifest: PackageManifest): void {
  if (manifest.private) {
    throw new Error(`${manifest.name} is marked private; refusing to publish.`);
  }
}

function githubMirrorPackageName(packageName: string, owner: string): string {
  const leaf = packageName.startsWith("@") ? packageName.split("/")[1] : packageName;
  const mirrorName = `@${owner}/${leaf}`;
  if (!NAME_PATTERN.test(mirrorName)) {
    throw new Error(`GitHub Packages package name must be a simple lowercase scoped npm name. Found: ${mirrorName}`);
  }
  return mirrorName;
}

function normalizeRegistry(registry: string): string {
  const normalized = registry.trim().replace(/\/$/, "");
  try {
    const url = new URL(normalized);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("unsupported protocol");
    }
  } catch {
    throw new Error(`GitHub package registry must be an HTTP(S) URL. Found: ${registry}`);
  }
  return normalized;
}

function packageRepositoryName(manifest: PackageManifest): string | undefined {
  const repository = manifest.repository;
  const url = typeof repository === "string"
    ? repository
    : typeof repository === "object" && repository !== null && "url" in repository && typeof repository.url === "string"
      ? repository.url
      : undefined;
  const match = url?.match(/github\.com[:/]([^/\s]+)\/([^/\s.]+)(?:\.git)?/i);
  return match ? `${match[1]}/${match[2]}` : undefined;
}

async function readGitHubEvent(env: NodeJS.ProcessEnv, missingMessage: string): Promise<unknown> {
  const eventPath = env.GITHUB_EVENT_PATH;
  if (!eventPath || !existsSync(eventPath)) {
    throw new Error(missingMessage);
  }
  return JSON.parse(await readFile(eventPath, "utf8"));
}

async function prepareNpmPublishAuth(options: PackageLifecycleOptions): Promise<{ env: NodeJS.ProcessEnv; hasTraditionalAuth: boolean; cleanupDir?: string }> {
  const token = npmAuthToken(options.env);
  const env: NodeJS.ProcessEnv = { ...options.env };
  if (!token) {
    if (!env.NODE_AUTH_TOKEN) delete env.NODE_AUTH_TOKEN;
    if (!env.NPM_TOKEN) delete env.NPM_TOKEN;
    return { env, hasTraditionalAuth: Boolean(env.NPM_CONFIG_USERCONFIG) };
  }

  const cleanupDir = await mkdtemp(join(tmpdir(), "async-pipeline-npm-publish-"));
  const registryUrl = new URL(NPM_REGISTRY);
  const registryAuthPath = `${registryUrl.host}${registryUrl.pathname.replace(/\/$/, "")}`;
  const userconfig = join(cleanupDir, ".npmrc");
  await writeFile(userconfig, `//${registryAuthPath}/:_authToken=${token}\n`, "utf8");
  await chmod(userconfig, 0o600);
  delete env.NPM_TOKEN;
  delete env.NODE_AUTH_TOKEN;
  env.NPM_CONFIG_USERCONFIG = userconfig;
  return { env, hasTraditionalAuth: true, cleanupDir };
}

function npmAuthToken(env: NodeJS.ProcessEnv): string | undefined {
  const token = env.NPM_TOKEN ?? env.NODE_AUTH_TOKEN;
  return token && token.trim().length > 0 ? token : undefined;
}

async function assertRegistryVersion(spec: string, registry: string, options: PackageLifecycleOptions, label: string): Promise<void> {
  let cleanupDir: string | undefined;
  let userconfig: string | undefined;
  if (registry === GITHUB_REGISTRY) {
    const token = options.env.GITHUB_TOKEN ?? options.env.NODE_AUTH_TOKEN;
    if (!token) {
      throw new Error("Set GITHUB_TOKEN or NODE_AUTH_TOKEN so release doctor can verify GitHub Packages.");
    }
    const scopePart = spec.startsWith("@") ? spec.split("/")[0] : undefined;
    const scope = scopePart?.slice(1);
    if (!scope) {
      throw new Error(`Cannot infer GitHub Packages scope from ${spec}.`);
    }
    cleanupDir = await mkdtemp(join(tmpdir(), "async-pipeline-release-doctor-"));
    const registryUrl = new URL(GITHUB_REGISTRY);
    const registryAuthPath = `${registryUrl.host}${registryUrl.pathname.replace(/\/$/, "")}`;
    userconfig = join(cleanupDir, ".npmrc");
    await writeFile(userconfig, `@${scope}:registry=${GITHUB_REGISTRY}\n//${registryAuthPath}/:_authToken=${token}\n`, "utf8");
    await chmod(userconfig, 0o600);
  }
  let lastView: SpawnSyncReturns<string> | undefined;
  try {
    const attempts = positiveInt(options.env.ASYNC_PIPELINE_RELEASE_DOCTOR_REGISTRY_ATTEMPTS, RELEASE_DOCTOR_REGISTRY_ATTEMPTS);
    const delayMs = positiveInt(options.env.ASYNC_PIPELINE_RELEASE_DOCTOR_REGISTRY_RETRY_DELAY_MS, RELEASE_DOCTOR_REGISTRY_RETRY_DELAY_MS);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const view = spawnSync("npm", ["view", spec, "version", "--registry", registry], {
        cwd: options.cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...options.env,
          ...(userconfig ? { NPM_CONFIG_USERCONFIG: userconfig } : {}),
          NPM_CONFIG_CACHE: options.env.NPM_CONFIG_CACHE ?? join(options.cwd, ".async", "npm-cache")
        }
      });
      lastView = view;
      if (view.status === 0) {
        options.io.stdout(`OK ${label}: ${spec}\n`);
        return;
      }
      if (!isMissingVersion(view)) {
        options.io.stderr(npmOutput(view).slice(0, 2000));
        throw new Error(`Release doctor could not verify ${spec} on ${label}.`);
      }
      if (attempt < attempts) {
        options.io.stdout(`Waiting for ${label} to expose ${spec} (${attempt}/${attempts}).\n`);
        await sleep(delayMs);
      }
    }
    if (lastView) options.io.stderr(npmOutput(lastView).slice(0, 2000));
    throw new Error(`Release doctor could not find ${spec} on ${label}.`);
  } finally {
    if (cleanupDir) rmSync(cleanupDir, { force: true, recursive: true });
  }
}

async function assertGitHubRelease(repository: string, version: string, options: PackageLifecycleOptions): Promise<void> {
  const token = options.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("Set GITHUB_TOKEN so release doctor can verify the GitHub Release.");
  }
  const apiBase = (options.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");
  const response = await fetch(`${apiBase}/repos/${repository}/releases/tags/v${version}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28"
    }
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Release doctor could not verify GitHub Release v${version}: ${response.status} ${text.slice(0, 500)}`);
  }
  options.io.stdout(`OK GitHub Release: ${repository}@v${version}\n`);
}

function assertReleaseTagMatches(manifest: PackageManifest, env: NodeJS.ProcessEnv): void {
  const refTag = env.GITHUB_REF?.startsWith("refs/tags/") ? env.GITHUB_REF.slice("refs/tags/".length) : undefined;
  if (refTag && refTag.replace(/^v/, "") !== manifest.version) {
    throw new Error(`Release tag ${refTag} does not match ${manifest.name} version ${manifest.version}. Publish from a matching tag such as v${manifest.version}.`);
  }
  if (env.GITHUB_EVENT_NAME === "release") {
    const eventPath = env.GITHUB_EVENT_PATH;
    if (!eventPath || !existsSync(eventPath)) {
      throw new Error("release events need GITHUB_EVENT_PATH to verify the release tag matches package.json.");
    }
    const event = JSON.parse(readFileSync(eventPath, "utf8"));
    const tagName = asRecord(asRecord(event).release).tag_name;
    if (typeof tagName !== "string" || tagName.length === 0) {
      throw new Error("Release event payload did not include release.tag_name.");
    }
    if (tagName.replace(/^v/, "") !== manifest.version) {
      throw new Error(`Release tag ${tagName} does not match ${manifest.name} version ${manifest.version}. Publish from a matching tag such as v${manifest.version}.`);
    }
  }
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

async function guardedApi<T>(operation: () => Promise<T>, message: string): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new Error(`${message}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isMissingVersion(result: SpawnSyncReturns<string>): boolean {
  return result.status !== 0 && /(^|[\s])(E404|404)([\s]|$)|not found/i.test(npmOutput(result));
}

function npmOutput(result: SpawnSyncReturns<string>): string {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function relativeLabel(cwd: string, target: string): string {
  const path = relative(cwd, target);
  return path || ".";
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

class LifecycleSkip extends Error {}
