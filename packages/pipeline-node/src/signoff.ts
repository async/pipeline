import { execFile } from "node:child_process";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExecutionRecord, NormalizedPipeline } from "@async/pipeline-core";
import { createStore, writeFileAtomic } from "./store.js";

export interface SignoffCliContext {
  cwd: string;
  pipeline: NormalizedPipeline;
  env: NodeJS.ProcessEnv;
  force: boolean;
  dryRun: boolean;
  stdout(text: string): void;
  stderr(text: string): void;
}

type OutputFormat = "text" | "json";
type SignoffState = "success" | "failure";

interface SignoffOptions {
  command: "create" | "status" | "revoke" | "check";
  contexts: string[];
  job: string;
  shaRef: string;
  run: string;
  remote?: string;
  localOnly: boolean;
  remoteOnly: boolean;
  noRun: boolean;
  force: boolean;
  dryRun: boolean;
  reason?: string;
  format: OutputFormat;
}

interface GitIdentity {
  sha: string;
  branch?: string;
  remote?: string;
  upstream?: string;
  clean: boolean;
  pushed?: boolean;
  owner?: string;
  repo?: string;
}

interface SignoffReceipt {
  version: 1;
  kind: "async-pipeline.signoff";
  context: string;
  state: SignoffState;
  sha: string;
  branch?: string;
  remote?: string;
  upstream?: string;
  pipeline: string;
  job: string;
  runId?: string;
  runStatus?: ExecutionRecord["status"] | "not-required";
  tree: {
    clean: boolean;
    pushed?: boolean;
    force: boolean;
  };
  github?: {
    owner: string;
    repo: string;
    statusState: SignoffState;
  };
  createdAt: string;
  reason?: string;
}

interface LocalStatus {
  context: string;
  receiptPath: string;
  receipt: SignoffReceipt | null;
}

interface RemoteStatus {
  context: string;
  state?: string;
  description?: string;
}

export async function handleSignoffCommand(args: string[], context: SignoffCliContext, program: string): Promise<number> {
  const command = args[0] as SignoffOptions["command"] | undefined;
  if (!command || command === "help" as string || command === "--help" as string) {
    context.stdout(signoffHelp(program));
    return 0;
  }
  if (command !== "create" && command !== "status" && command !== "revoke" && command !== "check") {
    throw new Error(`Unknown signoff command "${command}".`);
  }

  const options = parseSignoffOptions(command, args.slice(1), context.pipeline);
  const commandContext = { ...context, force: context.force || options.force, dryRun: context.dryRun || options.dryRun };
  const git = await readGitIdentity(context.cwd, options.shaRef, options.remote);
  const selectedContexts = normalizeContexts(options, context.pipeline);

  if (options.command === "create") {
    return createSignoff(selectedContexts, options, git, commandContext);
  }
  if (options.command === "revoke") {
    return revokeSignoff(selectedContexts, options, git, commandContext);
  }
  if (options.command === "status") {
    return statusSignoff(selectedContexts, options, git, commandContext);
  }
  return checkSignoff(selectedContexts, options, git, commandContext);
}

async function createSignoff(contexts: string[], options: SignoffOptions, git: GitIdentity, context: SignoffCliContext): Promise<number> {
  if (!context.force && !git.clean) throw new Error("Refusing to sign off a dirty worktree. Commit or stash changes, or use --force.");
  if (!context.force && git.pushed === false) throw new Error(`Refusing to sign off ${shortSha(git.sha)} because it is not pushed to ${git.upstream ?? git.remote ?? "the selected remote"}. Use --force to bypass the pushed check.`);
  if (options.noRun && !context.force) throw new Error("--no-run requires --force.");

  const selectedRun = options.noRun ? undefined : await selectRun(context.cwd, context.pipeline.name, options.job, options.run, git.sha);
  if (!options.noRun && !selectedRun) throw new Error(`No passed local Pipeline run for ${context.pipeline.name}/${options.job} at ${shortSha(git.sha)} was found.`);
  const run = selectedRun ?? undefined;
  if (run && run.git?.sha !== git.sha) throw new Error(`Run ${run.id} was recorded for ${run.git?.sha ? shortSha(run.git.sha) : "an unknown commit"}, not ${shortSha(git.sha)}.`);

  const github = await githubRepository(context.cwd, git.remote);
  const receipts: SignoffReceipt[] = [];
  for (const signoffContext of contexts) {
    if (!context.dryRun) {
      if (!github.owner || !github.repo) throw new Error("Could not determine GitHub owner/repo from the selected remote.");
      await postCommitStatus({
        cwd: context.cwd,
        env: context.env,
        owner: github.owner,
        repo: github.repo,
        sha: git.sha,
        context: signoffContext,
        state: "success",
        description: `Pipeline ${options.job} signed off`
      });
    }
    const receipt = buildReceipt({
      context: signoffContext,
      state: "success",
      git,
      pipelineName: context.pipeline.name,
      job: options.job,
      run,
      noRun: options.noRun,
      force: context.force,
      github: github.owner && github.repo ? { owner: github.owner, repo: github.repo } : undefined
    });
    receipts.push(receipt);
    if (!context.dryRun) await writeSignoffReceipt(context.cwd, receipt);
  }

  if (options.format === "json") {
    context.stdout(`${JSON.stringify({ status: context.dryRun ? "planned" : "signed", sha: git.sha, contexts, receipts }, null, 2)}\n`);
  } else {
    for (const signoffContext of contexts) {
      context.stdout(`${context.dryRun ? "would sign off" : "signed off"} ${signoffContext} on ${shortSha(git.sha)}${run ? ` from run ${run.id}` : " without a run"}\n`);
    }
  }
  return 0;
}

async function revokeSignoff(contexts: string[], options: SignoffOptions, git: GitIdentity, context: SignoffCliContext): Promise<number> {
  const github = await githubRepository(context.cwd, git.remote);
  const receipts: SignoffReceipt[] = [];
  for (const signoffContext of contexts) {
    if (!context.dryRun) {
      if (!github.owner || !github.repo) throw new Error("Could not determine GitHub owner/repo from the selected remote.");
      await postCommitStatus({
        cwd: context.cwd,
        env: context.env,
        owner: github.owner,
        repo: github.repo,
        sha: git.sha,
        context: signoffContext,
        state: "failure",
        description: trimDescription(options.reason ?? `Pipeline ${options.job} signoff revoked`)
      });
    }
    const receipt = buildReceipt({
      context: signoffContext,
      state: "failure",
      git,
      pipelineName: context.pipeline.name,
      job: options.job,
      noRun: true,
      force: context.force,
      reason: options.reason,
      github: github.owner && github.repo ? { owner: github.owner, repo: github.repo } : undefined
    });
    receipts.push(receipt);
    if (!context.dryRun) await writeSignoffReceipt(context.cwd, receipt);
  }

  if (options.format === "json") {
    context.stdout(`${JSON.stringify({ status: context.dryRun ? "planned" : "revoked", sha: git.sha, contexts, receipts }, null, 2)}\n`);
  } else {
    for (const signoffContext of contexts) context.stdout(`${context.dryRun ? "would revoke" : "revoked"} ${signoffContext} on ${shortSha(git.sha)}\n`);
  }
  return 0;
}

async function statusSignoff(contexts: string[], options: SignoffOptions, git: GitIdentity, context: SignoffCliContext): Promise<number> {
  const local = options.remoteOnly ? [] : await Promise.all(contexts.map((signoffContext) => readLocalStatus(context.cwd, git.sha, signoffContext)));
  const remote = options.localOnly ? [] : await readRemoteStatuses(context.cwd, context.env, git, contexts);
  const result = { sha: git.sha, contexts, local, remote };
  if (options.format === "json") {
    context.stdout(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  context.stdout(`commit ${shortSha(git.sha)}\n`);
  for (const signoffContext of contexts) {
    const localState = local.find((entry) => entry.context === signoffContext)?.receipt?.state;
    const remoteState = remote.find((entry) => entry.context === signoffContext)?.state;
    const state = remoteState ?? localState ?? "missing";
    context.stdout(`${state === "success" ? "ok" : state === "failure" ? "failed" : "missing"} ${signoffContext}\n`);
  }
  return 0;
}

async function checkSignoff(contexts: string[], options: SignoffOptions, git: GitIdentity, context: SignoffCliContext): Promise<number> {
  const local = options.remoteOnly ? [] : await Promise.all(contexts.map((signoffContext) => readLocalStatus(context.cwd, git.sha, signoffContext)));
  const remote = options.localOnly ? [] : await readRemoteStatuses(context.cwd, context.env, git, contexts);
  const issues: string[] = [];
  for (const signoffContext of contexts) {
    if (!options.remoteOnly) {
      const receipt = local.find((entry) => entry.context === signoffContext)?.receipt;
      if (receipt?.state !== "success") issues.push(`${signoffContext}: local signoff is ${receipt?.state ?? "missing"}`);
    }
    if (!options.localOnly) {
      const status = remote.find((entry) => entry.context === signoffContext);
      if (status?.state !== "success") issues.push(`${signoffContext}: GitHub status is ${status?.state ?? "missing"}`);
    }
  }
  if (options.format === "json") {
    context.stdout(`${JSON.stringify({ sha: git.sha, contexts, passed: issues.length === 0, issues }, null, 2)}\n`);
  } else if (issues.length === 0) {
    context.stdout(`Signoff check passed for ${shortSha(git.sha)}.\n`);
  } else {
    for (const issue of issues) context.stderr(`${issue}\n`);
  }
  return issues.length === 0 ? 0 : 1;
}

function parseSignoffOptions(command: SignoffOptions["command"], args: string[], pipeline: NormalizedPipeline): SignoffOptions {
  const contexts: string[] = [];
  const contextFlags: string[] = [];
  let job = pipeline.jobs.verify ? "verify" : Object.keys(pipeline.jobs).sort()[0] ?? "verify";
  let shaRef = "HEAD";
  let run = "latest";
  let remote: string | undefined;
  let reason: string | undefined;
  let format: OutputFormat = "text";
  let localOnly = false;
  let remoteOnly = false;
  let noRun = false;
  let force = false;
  let dryRun = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg === "--job") {
      job = requiredValue(args, ++index, "--job");
    } else if (arg === "--sha") {
      shaRef = requiredValue(args, ++index, "--sha");
    } else if (arg === "--run") {
      run = requiredValue(args, ++index, "--run");
    } else if (arg === "--remote") {
      remote = requiredValue(args, ++index, "--remote");
    } else if (arg === "--context") {
      contextFlags.push(requiredValue(args, ++index, "--context"));
    } else if (arg === "--reason") {
      reason = requiredValue(args, ++index, "--reason");
    } else if (arg === "--format") {
      const value = requiredValue(args, ++index, "--format");
      if (value !== "text" && value !== "json") throw new Error("--format must be text or json.");
      format = value;
    } else if (arg === "--local-only") {
      localOnly = true;
    } else if (arg === "--remote-only") {
      remoteOnly = true;
    } else if (arg === "--no-run") {
      noRun = true;
    } else if (arg === "--force") {
      force = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown signoff option "${arg}".`);
    } else {
      contexts.push(arg);
    }
  }

  if (localOnly && remoteOnly) throw new Error("Use only one of --local-only or --remote-only.");
  if (command !== "create" && noRun) throw new Error("--no-run is only valid for signoff create.");
  return { command, contexts: [...contextFlags, ...contexts], job, shaRef, run, remote, localOnly, remoteOnly, noRun, force, dryRun, reason, format };
}

function normalizeContexts(options: SignoffOptions, pipeline: NormalizedPipeline): string[] {
  if (!pipeline.jobs[options.job]) throw new Error(`Unknown job "${options.job}".`);
  const values = options.contexts.length > 0 ? options.contexts : [options.job];
  return [...new Set(values.map((value) => value.startsWith("async/local/") ? value : `async/local/${safeContextPart(value)}`))];
}

async function selectRun(cwd: string, pipelineName: string, job: string, requestedRun: string, sha: string): Promise<ExecutionRecord | null> {
  const store = await createStore(cwd);
  if (requestedRun !== "latest") {
    const record = await readExecutionRecord(join(store.runsDir, requestedRun, "execution.json"));
    if (!record) throw new Error(`Run "${requestedRun}" was not found.`);
    validateRun(record, pipelineName, job, sha);
    return record;
  }
  let entries;
  try {
    entries = await readdir(store.runsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries.filter((candidate) => candidate.isDirectory()).map((candidate) => candidate.name).sort().reverse()) {
    const record = await readExecutionRecord(join(store.runsDir, entry, "execution.json"));
    if (!record) continue;
    if (record.pipelineName !== pipelineName || record.jobId !== job || record.status !== "passed") continue;
    if (record.mode !== "manual" && record.mode !== "ci") continue;
    if (record.git?.sha !== sha) continue;
    return record;
  }
  return null;
}

function validateRun(record: ExecutionRecord, pipelineName: string, job: string, sha: string): void {
  if (record.pipelineName !== pipelineName) throw new Error(`Run ${record.id} belongs to pipeline "${record.pipelineName}", not "${pipelineName}".`);
  if (record.jobId !== job) throw new Error(`Run ${record.id} belongs to job "${record.jobId}", not "${job}".`);
  if (record.status !== "passed") throw new Error(`Run ${record.id} is ${record.status}, not passed.`);
  if (record.git?.sha !== sha) throw new Error(`Run ${record.id} was recorded for ${record.git?.sha ? shortSha(record.git.sha) : "an unknown commit"}, not ${shortSha(sha)}.`);
}

async function readExecutionRecord(path: string): Promise<ExecutionRecord | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as ExecutionRecord;
  } catch {
    return null;
  }
}

async function readGitIdentity(cwd: string, shaRef: string, requestedRemote?: string): Promise<GitIdentity> {
  const sha = await gitOutput(cwd, ["rev-parse", `${shaRef}^{commit}`]);
  const branch = await gitOutput(cwd, ["branch", "--show-current"]);
  const upstream = await gitOutput(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  const remote = requestedRemote ?? (upstream?.includes("/") ? upstream.split("/")[0] : "origin");
  const status = await gitOutput(cwd, ["status", "--porcelain"]);
  const pushed = upstream ? await gitExit(cwd, ["merge-base", "--is-ancestor", sha, upstream]) : undefined;
  const github = await githubRepository(cwd, remote);
  return {
    sha,
    ...(branch ? { branch } : {}),
    ...(remote ? { remote } : {}),
    ...(upstream ? { upstream } : {}),
    clean: status.length === 0,
    ...(pushed === undefined ? {} : { pushed }),
    ...(github.owner ? { owner: github.owner } : {}),
    ...(github.repo ? { repo: github.repo } : {})
  };
}

async function githubRepository(cwd: string, remote?: string): Promise<{ owner?: string; repo?: string }> {
  const url = await gitOutput(cwd, ["remote", "get-url", remote ?? "origin"]).catch(() => "");
  const match = url.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/u);
  if (!match) return {};
  return { owner: match[1], repo: match[2] };
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const result = await execFileText("git", args, { cwd, env: process.env });
  if (result.code !== 0) throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

async function gitExit(cwd: string, args: string[]): Promise<boolean | undefined> {
  const result = await execFileText("git", args, { cwd, env: process.env });
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  return undefined;
}

async function postCommitStatus(options: { cwd: string; env: NodeJS.ProcessEnv; owner: string; repo: string; sha: string; context: string; state: SignoffState; description: string }): Promise<void> {
  const result = await execFileText("gh", [
    "api",
    `repos/${options.owner}/${options.repo}/statuses/${options.sha}`,
    "--method",
    "POST",
    "-f",
    `state=${options.state}`,
    "-f",
    `context=${options.context}`,
    "-f",
    `description=${trimDescription(options.description)}`
  ], { cwd: options.cwd, env: options.env });
  if (result.code !== 0) throw new Error(result.stderr.trim() || "gh api failed to publish the commit status.");
}

async function readRemoteStatuses(cwd: string, env: NodeJS.ProcessEnv, git: GitIdentity, contexts: string[]): Promise<RemoteStatus[]> {
  if (!git.owner || !git.repo) throw new Error("Could not determine GitHub owner/repo from the selected remote.");
  const result = await execFileText("gh", ["api", `repos/${git.owner}/${git.repo}/commits/${git.sha}/status`], { cwd, env });
  if (result.code !== 0) throw new Error(result.stderr.trim() || "gh api failed to read commit statuses.");
  const payload = JSON.parse(result.stdout || "{}") as { statuses?: Array<{ context?: string; state?: string; description?: string }> };
  return contexts.map((signoffContext) => {
    const match = (payload.statuses ?? []).find((status) => status.context === signoffContext);
    return {
      context: signoffContext,
      ...(match?.state === undefined ? {} : { state: match.state }),
      ...(match?.description === undefined ? {} : { description: match.description })
    };
  });
}

async function execFileText(file: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { cwd: options.cwd, env: options.env }, (error, stdout, stderr) => {
      const rawCode = (error as NodeJS.ErrnoException | null)?.code;
      const code = typeof rawCode === "number"
        ? rawCode
        : error ? 1 : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function buildReceipt(options: { context: string; state: SignoffState; git: GitIdentity; pipelineName: string; job: string; run?: ExecutionRecord; noRun: boolean; force: boolean; github?: { owner: string; repo: string }; reason?: string }): SignoffReceipt {
  return {
    version: 1,
    kind: "async-pipeline.signoff",
    context: options.context,
    state: options.state,
    sha: options.git.sha,
    ...(options.git.branch ? { branch: options.git.branch } : {}),
    ...(options.git.remote ? { remote: options.git.remote } : {}),
    ...(options.git.upstream ? { upstream: options.git.upstream } : {}),
    pipeline: options.pipelineName,
    job: options.job,
    ...(options.run ? { runId: options.run.id } : {}),
    runStatus: options.run?.status ?? (options.noRun ? "not-required" : undefined),
    tree: {
      clean: options.git.clean,
      ...(options.git.pushed === undefined ? {} : { pushed: options.git.pushed }),
      force: options.force
    },
    ...(options.github ? { github: { ...options.github, statusState: options.state } } : {}),
    createdAt: new Date().toISOString(),
    ...(options.reason ? { reason: trimDescription(options.reason) } : {})
  };
}

async function writeSignoffReceipt(cwd: string, receipt: SignoffReceipt): Promise<void> {
  const path = signoffReceiptPath(cwd, receipt.sha, receipt.context);
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomic(path, `${JSON.stringify(receipt, null, 2)}\n`);
}

async function readLocalStatus(cwd: string, sha: string, context: string): Promise<LocalStatus> {
  const path = signoffReceiptPath(cwd, sha, context);
  try {
    const receipt = JSON.parse(await readFile(path, "utf8")) as SignoffReceipt;
    return { context, receiptPath: path, receipt };
  } catch {
    return { context, receiptPath: path, receipt: null };
  }
}

function signoffReceiptPath(cwd: string, sha: string, context: string): string {
  return join(cwd, ".async", "signoff", sha, `${safeFileName(context)}.json`);
}

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function safeContextPart(value: string): string {
  const safe = value.trim().replaceAll(/[^a-zA-Z0-9._/-]/g, "-").replaceAll(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
  if (!safe) throw new Error("Signoff context cannot be empty.");
  return safe;
}

function safeFileName(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]/g, "_");
}

function shortSha(value: string): string {
  return value.slice(0, 7);
}

function trimDescription(value: string): string {
  return value.slice(0, 140);
}

function signoffHelp(program: string): string {
  return `Usage:
  ${program} signoff create [context...] [--job <id>] [--run latest|<id>] [--sha <ref>] [--context <name>] [--remote <name>] [--force] [--no-run] [--dry-run] [--format text|json]
  ${program} signoff status [context...] [--job <id>] [--sha <ref>] [--context <name>] [--local-only|--remote-only] [--format text|json]
  ${program} signoff revoke [context...] [--job <id>] [--sha <ref>] [--context <name>] [--reason <text>] [--dry-run] [--format text|json]
  ${program} signoff check [context...] [--job <id>] [--sha <ref>] [--context <name>] [--local-only|--remote-only] [--format text|json]\n`;
}
