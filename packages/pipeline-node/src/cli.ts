#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_PIPELINE_CONFIG_FILES, buildGraph, composePipelines, tasksForJob, type ContainerProvider, type ExecutionRecord, type NormalizedPipeline, type TaskResult } from "@async/pipeline-core";
import { runDoctor } from "./doctor.js";
import { checkGitHubWorkflow, planGitHubJobs, readGitHubEventContext, renderGitHubWorkflow, runGitHubLocalPlan, writeGitHubWorkflow, type GitHubLocalNetworkMode, type GitHubPlanOptions, type GitHubPlanResult } from "./github.js";
import { auditLifecycle, renderLifecycleAuditText, type LifecycleAuditFormat } from "./lifecycle-audit.js";
import { loadPipeline } from "./loader.js";
import { beginShutdown, cacheManifestForJob, cacheManifestForTask, commandProxy, planJob, runJob, runSingleTask, shutdownExitCode, type CommandResult, type GitHubCacheManifestTrust, type PipelineCommands } from "./runner.js";
import { runMcpServer } from "./mcp.js";
import { ensureGitHubRelease, publishGitHubPackage, publishNpmPackage, runLifecycleCli, runReleaseDoctor, syncGitHubReleaseDescriptions, type GitHubPackagePublishMode } from "./package-lifecycle.js";
import { computeTaskInputManifest, createStore, diffInputManifests, pruneCacheEntries, readCacheInputManifest, readContextPacks, readTaskBaseline, readTaskCacheReceipts, type TaskCacheReceipt, type TaskContextPack } from "./store.js";
import { matrixForJob, readPipelineMetadata, resolveSources, sourceContext } from "./sources.js";
import { checkTaskSync, describeTaskSync, renderTaskSync, writeTaskSync } from "./sync.js";
import { checkCloudflareSync, describeCloudflareSync, planCloudflareWorkflow, renderCloudflareSync, runCloudflareWorkflowMock, writeCloudflareSync, type CloudflareWorkflowMockMode, type CloudflareWorkflowPlanOptions, type CloudflareWorkflowPlanResult } from "./cloudflare.js";
import { handleSignoffCommand } from "./signoff.js";

export interface PipelineCliOptions {
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  commands?: PipelineCommands;
  program?: string;
  stdout?(text: string): void;
  stderr?(text: string): void;
}

interface PipelineCliContext {
  concurrency?: number;
  force: boolean;
  dryRun: boolean;
  cwd: string;
  configPath: string;
  pipeline: NormalizedPipeline;
  env: NodeJS.ProcessEnv;
  commands?: PipelineCommands;
  sandboxId?: string;
  executionId?: string;
  provider?: ContainerProvider;
  stdout(text: string): void;
  stderr(text: string): void;
}

interface ParsedGlobalOptions {
  args: string[];
  concurrency?: number;
  force: boolean;
  dryRun: boolean;
  sandboxId?: string;
  executionId?: string;
  provider?: ContainerProvider;
}

export async function runPipelineCli(options: PipelineCliOptions): Promise<CommandResult> {
  const sinkStdout = options.stdout ?? ((text: string): void => { process.stdout.write(text); });
  const sinkStderr = options.stderr ?? ((text: string): void => { process.stderr.write(text); });
  let streamedStdout = 0;
  let streamedStderr = 0;

  const result = await runPipelineCliBuffered({
    args: options.args,
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    commands: options.commands,
    program: options.program,
    onStdout(text) {
      streamedStdout += text.length;
      sinkStdout(text);
    },
    onStderr(text) {
      streamedStderr += text.length;
      sinkStderr(text);
    },
    applyCommandPolicy: true
  });

  // Streamed text is always a prefix of the final result text; replaced output
  // (command policy deny/mock, or errors) was never streamed, so flush the rest.
  if (result.stdout.length > streamedStdout) sinkStdout(result.stdout.slice(streamedStdout));
  if (result.stderr.length > streamedStderr) sinkStderr(result.stderr.slice(streamedStderr));
  return result;
}

interface PipelineCliStreamOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  commands?: PipelineCommands;
  applyCommandPolicy: boolean;
  onStdout?(text: string): void;
  onStderr?(text: string): void;
}

async function runPipelineCliBuffered(options: Omit<PipelineCliOptions, "stdout" | "stderr"> & PipelineCliStreamOptions): Promise<CommandResult> {
  try {
    const parsed = parseGlobalOptions(options.args);
    const [commandName, ...args] = parsed.args;
    const program = options.program ?? programName();
    const cwd = options.cwd;
    const configPath = findPipelineConfig(cwd);
    let stdout = "";
    let stderr = "";
    const out = (text: string): void => {
      stdout += text;
      options.onStdout?.(text);
    };
    const err = (text: string): void => {
      stderr += text;
      options.onStderr?.(text);
    };

    if (commandName === "doctor") {
      // Best-effort pipeline load: doctor must still work in projects where
      // the config is missing or broken — pipeline-aware checks just skip.
      const doctorPipeline = configPath ? await loadPipeline(configPath).catch(() => undefined) : undefined;
      const checks = await runDoctor(cwd, doctorPipeline);
      for (const check of checks) out(`${check.status.toUpperCase()} ${check.name}: ${check.message}\n`);
      return { code: checks.some((check) => check.status === "fail") ? 1 : 0, stdout, stderr };
    }

    if (commandName === "lifecycle") {
      const code = await handleLifecycleCommand(args, { cwd, stdout: out, stderr: err }, program);
      return { code, stdout, stderr };
    }

    if (!commandName || commandName === "help" || commandName === "--help") {
      out(printHelp(program));
      return { code: 0, stdout, stderr };
    }

    if (!configPath) {
      throw new Error(`No ${formatPipelineConfigList()} found in ${cwd}.`);
    }

    const pipeline = await loadPipeline(configPath);
    const configDir = dirname(configPath);
    // Validate the sandbox id before the command policy can mock the
    // invocation, so typos fail loudly even under mocked CLI commands.
    if (parsed.sandboxId && parsed.sandboxId !== "host" && !pipeline.sandboxes[parsed.sandboxId]) {
      throw new Error(`Unknown sandbox "${parsed.sandboxId}". Declare it under \`sandboxes\` in the pipeline config.`);
    }
    if (parsed.executionId && !pipeline.execution[parsed.executionId]) {
      throw new Error(`Unknown execution profile "${parsed.executionId}". Declare it under \`execution\` in the pipeline config.`);
    }
    const commands = options.commands ?? (pipeline.commands ? commandProxy(pipeline.commands) : undefined);

    if (options.applyCommandPolicy && commands) {
      return commands.run({
        argv: ["async-pipeline", ...options.args],
        cwd: configDir,
        env: options.env
      }, () => runPipelineCliBuffered({
        ...options,
        args: options.args,
        cwd: configDir,
        commands,
        applyCommandPolicy: false
      }));
    }

    const context: PipelineCliContext = {
      concurrency: parsed.concurrency,
      force: parsed.force,
      dryRun: parsed.dryRun,
      cwd: configDir,
      configPath,
      pipeline,
      env: options.env,
      commands,
      sandboxId: parsed.sandboxId,
      executionId: parsed.executionId,
      provider: parsed.provider,
      stdout: out,
      stderr: err
    };

    const code = await dispatchCommand(commandName, args, context, program);
    return { code, stdout, stderr };
  } catch (error) {
    const message = `${error instanceof Error ? error.message : String(error)}\n`;
    return { code: 1, stdout: "", stderr: message };
  }
}

async function dispatchCommand(commandName: string, args: string[], context: PipelineCliContext, program: string): Promise<number> {
  if (commandName === "sync") {
    return handleSyncCommand(args, context);
  }

  if (commandName === "github") {
    const subcommand = args[0] ?? "help";
    const paths = githubGenerationPaths(args.slice(1));
    const rendered = await renderGitHubWorkflow(context.pipeline, { cwd: context.cwd, configPath: context.configPath, ...paths });
    if (subcommand === "generate") {
      await writeGitHubWorkflow(rendered, context.cwd);
      context.stdout(`Generated ${rendered.workflowPath}\n`);
      context.stdout(`Generated ${rendered.lockPath}\n`);
      return 0;
    }
    if (subcommand === "check") {
      const issues = await checkGitHubWorkflow(rendered, context.cwd);
      if (issues.length > 0) {
        for (const issue of issues) context.stderr(`${issue}\n`);
        return 1;
      }
      context.stdout("GitHub workflow is current.\n");
      return 0;
    }
    if (subcommand === "plan") {
      const planOptions = await githubPlanOptions(args.slice(1), context, paths);
      const issues = args.includes("--check") || args.includes("--include-local-plan")
        ? await checkGitHubWorkflow(rendered, context.cwd)
        : [];
      const plan = await planGitHubJobs(context.pipeline, planOptions);
      if (issues.length > 0) {
        for (const issue of issues) context.stderr(`${issue}\n`);
        return 1;
      }
      const format = githubOutputFormat(args.slice(1));
      if (format === "json") {
        context.stdout(`${JSON.stringify(plan, null, 2)}\n`);
      } else if (args.includes("--check")) {
        context.stdout(`GitHub plan is current (${plan.manifests.length} selected job${plan.manifests.length === 1 ? "" : "s"}).\n`);
      } else {
        context.stdout(renderGitHubPlanText(plan));
      }
      return 0;
    }
    if (subcommand === "run") {
      const planOptions = await githubPlanOptions(args.slice(1), context, paths);
      const result = await runGitHubLocalPlan(context.pipeline, {
        ...planOptions,
        env: context.env,
        dryRun: context.dryRun
      });
      const format = githubOutputFormat(args.slice(1));
      if (format === "json") {
        context.stdout(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        if (result.receipts.length === 0) {
          context.stdout(`No generated GitHub jobs matched event "${result.plan.event.name}".\n`);
        }
        for (const receipt of result.receipts) {
          context.stdout(`GitHub local ${receipt.status}: ${receipt.job}${receipt.manifestPath ? ` (${receipt.manifestPath})` : ""}\n`);
          for (const issue of receipt.issues) context.stderr(`${issue}\n`);
        }
      }
      return result.status === "failed" ? 1 : 0;
    }
    throw new Error(`Unknown github command "${subcommand}".`);
  }

  if (commandName === "cloudflare") {
    const subcommand = args[0] ?? "help";
    if (subcommand === "plan") {
      const options = cloudflarePlanOptions(args.slice(1), context);
      const plan = await planCloudflareWorkflow(context.pipeline, options);
      const format = cloudflareOutputFormat(args.slice(1));
      if (format === "json") {
        context.stdout(`${JSON.stringify(plan, null, 2)}\n`);
      } else {
        context.stdout(renderCloudflarePlanText(plan));
      }
      return 0;
    }
    if (subcommand === "run") {
      const rest = args.slice(1);
      const mode = cloudflareRunMode(rest);
      const result = await runCloudflareWorkflowMock(context.pipeline, {
        ...cloudflarePlanOptions(rest, context),
        mode,
        dryRun: context.dryRun
      });
      const format = cloudflareOutputFormat(rest);
      if (format === "json") {
        context.stdout(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        if (result.receipts.length === 0) {
          context.stdout(`No Cloudflare jobs matched event "${result.plan.event.event}".\n`);
        }
        for (const receipt of result.receipts) {
          context.stdout(`Cloudflare ${mode} ${receipt.status}: ${receipt.job}${receipt.receiptPath ? ` (${receipt.receiptPath})` : ""}\n`);
          for (const issue of receipt.issues) context.stderr(`${issue}\n`);
        }
      }
      return result.status === "skipped" || result.status === "passed" || result.status === "planned" ? 0 : 1;
    }
    throw new Error(`Unknown cloudflare command "${subcommand}".`);
  }

  if (commandName === "signoff") {
    return handleSignoffCommand(args, context, program);
  }

  if (commandName === "list") {
    context.stdout("Jobs:\n");
    for (const jobId of Object.keys(context.pipeline.jobs).sort()) context.stdout(`  ${jobId}\n`);
    context.stdout("Tasks:\n");
    for (const taskId of Object.keys(context.pipeline.tasks).sort()) context.stdout(`  ${taskId}\n`);
    if (Object.keys(context.pipeline.sources).length > 0) {
      context.stdout("Sources:\n");
      for (const sourceId of Object.keys(context.pipeline.sources).sort()) context.stdout(`  ${sourceId}\n`);
    }
    return 0;
  }

  if (commandName === "graph") {
    const formatIndex = args.indexOf("--format");
    const format = formatIndex >= 0 ? args[formatIndex + 1] : "json";
    const store = virtualStore(context.cwd);
    const graphPipeline = await loadAvailableSourceGraph(context.pipeline, context.cwd, store);
    const graph = buildGraph(graphPipeline);
    if (format === "json") {
      context.stdout(`${JSON.stringify(graph, null, 2)}\n`);
      return 0;
    }
    if (format === "dot") {
      context.stdout("digraph pipeline {\n");
      for (const task of graph.tasks) {
        if (task.dependsOn.length === 0) context.stdout(`  "${task.id}";\n`);
        for (const dependency of task.dependsOn) context.stdout(`  "${dependency}" -> "${task.id}";\n`);
      }
      context.stdout("}\n");
      return 0;
    }
    throw new Error(`Unsupported graph format "${format}".`);
  }

  if (commandName === "explain") {
    const store = virtualStore(context.cwd);
    const formatIndex = args.indexOf("--format");
    const explainFormat = formatIndex >= 0 ? args[formatIndex + 1] : "text";
    if (explainFormat !== "text" && explainFormat !== "json") throw new Error(`Unsupported explain format "${explainFormat}".`);

    const runIndex = args.indexOf("--run");
    if (runIndex >= 0) {
      const runId = args[runIndex + 1];
      if (!runId || runId.startsWith("--")) throw new Error(`Usage: ${program} explain --run <run-id|latest> [--format json]`);
      const evidence = await readRunEvidence(store, runId);
      if (explainFormat === "json") {
        context.stdout(`${JSON.stringify(evidence, null, 2)}\n`);
        return 0;
      }
      context.stdout(renderRunEvidenceText(evidence));
      return 0;
    }

    const taskId = args[0];
    if (!taskId || taskId.startsWith("--")) throw new Error(`Usage: ${program} explain <task> [--diff-inputs] | explain --run <run-id>`);
    const explainPipeline = await loadAvailableSourceGraph(context.pipeline, context.cwd, store);
    const task = explainPipeline.tasks[taskId];
    if (!task) throw new Error(`Unknown task "${taskId}".`);

    if (args.includes("--diff-inputs")) {
      const baseline = await readTaskBaseline(store, taskId);
      const baselineManifest = baseline ? await readCacheInputManifest(store, baseline.cacheKey) : null;
      const current = await computeTaskInputManifest(explainPipeline, task, context.cwd);
      if (!baseline || !baselineManifest) {
        if (explainFormat === "json") {
          context.stdout(`${JSON.stringify({ task: taskId, baselineMissing: true, current }, null, 2)}\n`);
        } else {
          context.stdout(`No passing baseline recorded for task "${taskId}" (${Object.keys(current.files).length} current input file(s)). Run the task to record one.\n`);
        }
        return 0;
      }
      const diff = diffInputManifests(baselineManifest, current);
      if (explainFormat === "json") {
        context.stdout(`${JSON.stringify({ task: taskId, baselineCacheKey: baseline.cacheKey, baselineRecordedAt: baseline.recordedAt, ...diff }, null, 2)}\n`);
        return 0;
      }
      const total = diff.changed.length + diff.added.length + diff.removed.length;
      context.stdout(`Inputs for "${taskId}" vs last passing entry (recorded ${baseline.recordedAt}):\n`);
      if (total === 0) {
        context.stdout("  unchanged\n");
        return 0;
      }
      for (const path of diff.changed) context.stdout(`  ~ ${path}\n`);
      for (const path of diff.added) context.stdout(`  + ${path}\n`);
      for (const path of diff.removed) context.stdout(`  - ${path}\n`);
      return 0;
    }

    context.stdout(`${JSON.stringify(task, jsonReplacer, 2)}\n`);
    return 0;
  }

  if (commandName === "sources") {
    return handleSourcesCommand(args, context);
  }

  if (commandName === "metadata") {
    const formatIndex = args.indexOf("--format");
    const format = formatIndex >= 0 ? args[formatIndex + 1] : "json";
    if (format !== "json") throw new Error(`Unsupported metadata format "${format}".`);
    const includeSources = args.includes("--include-sources");
    const store = virtualStore(context.cwd);
    const metadata = await readPipelineMetadata(context.configPath, { cwd: context.cwd, includeSources, store });
    context.stdout(`${JSON.stringify(metadata, jsonReplacer, 2)}\n`);
    return 0;
  }

  if (commandName === "mcp") {
    return runMcpServer({
      pipeline: context.pipeline,
      configPath: context.configPath,
      cwd: context.cwd,
      env: context.env,
      store: virtualStore(context.cwd),
      allowRun: args.includes("--allow-run"),
      serverVersion: await ownPackageVersion(),
      input: process.stdin,
      write: (line) => context.stdout(`${line}\n`)
    });
  }

  if (commandName === "matrix") {
    const jobId = args[0];
    if (!jobId) throw new Error(`Usage: ${program} matrix <job> --format github`);
    const formatIndex = args.indexOf("--format");
    const format = formatIndex >= 0 ? args[formatIndex + 1] : "github";
    if (format !== "github") throw new Error(`Unsupported matrix format "${format}".`);
    context.stdout(`${JSON.stringify(matrixForJob(context.pipeline, jobId))}\n`);
    return 0;
  }

  if (commandName === "publish") {
    return handlePublishCommand(args, context, program);
  }

  if (commandName === "release") {
    return handleReleaseCommand(args, context, program);
  }

  if (commandName === "run") {
    const jobId = args[0];
    if (!jobId) throw new Error(`Usage: ${program} run <job>`);
    const format = runOutputFormat(args, program);
    const graph = tasksForJob(context.pipeline, jobId);
    if (context.dryRun) {
      return printDryRun(context, format, jobId);
    }
    if (format === "text") context.stdout(`Running ${context.pipeline.name}:${jobId} (${graph.executionOrder.join(" -> ")})\n`);
    const selectedJob = context.pipeline.jobs[jobId];
    const result = await runJob(context.pipeline, { id: jobId, mode: context.env.CI ? "ci" : "manual", cwd: context.cwd, env: context.env, commands: context.commands, sandbox: context.sandboxId, execution: context.executionId ?? selectedJob?.execution, provider: context.provider, concurrency: context.concurrency, force: context.force, echo: format === "text" });
    if (format === "json") {
      context.stdout(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      reportFailedTasks(context, result.tasks);
      context.stdout(`Pipeline ${result.status}: ${result.id}\n`);
    }
    await pruneRunsAfterRun(context);
    return result.status === "passed" ? 0 : 1;
  }

  if (commandName === "run-task") {
    const taskId = args[0];
    if (!taskId) throw new Error(`Usage: ${program} run-task <task>`);
    const format = runOutputFormat(args, program);
    if (context.dryRun) {
      return printDryRun(context, format, undefined, taskId);
    }
    const result = await runSingleTask(context.pipeline, taskId, { mode: context.env.CI ? "ci" : "manual", cwd: context.cwd, env: context.env, commands: context.commands, sandbox: context.sandboxId, execution: context.executionId, provider: context.provider, concurrency: context.concurrency, force: context.force, echo: format === "text" });
    if (format === "json") {
      context.stdout(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      reportFailedTasks(context, result.tasks);
      context.stdout(`Task run ${result.status}: ${result.id}\n`);
    }
    await pruneRunsAfterRun(context);
    return result.status === "passed" ? 0 : 1;
  }

  if (commandName === "cache") {
    const subcommand = args[0];
    if (subcommand === "clear") {
      await rm(join(context.cwd, ".async", "cache", "tasks"), { recursive: true, force: true });
      context.stdout("Cleared task cache.\n");
      return 0;
    }
    if (subcommand === "manifest") {
      return handleCacheManifestCommand(args.slice(1), context, program);
    }
    throw new Error(`Unknown cache command "${subcommand ?? ""}". Use: ${program} cache clear | cache manifest --job <id> --output <path>`);
  }

  if (commandName === "gc") {
    const keep = parsePositiveInteger(args, "--keep", 20);
    const cacheDays = parsePositiveInteger(args, "--cache-days", 30);
    const removed = await pruneRuns(context.cwd, keep);
    const remaining = await countRuns(context.cwd);
    const removedCacheEntries = await pruneCacheEntries(context.cwd, cacheDays);
    context.stdout(`Removed ${removed} run record${removed === 1 ? "" : "s"}; kept ${remaining}.\n`);
    context.stdout(
      cacheDays > 0
        ? `Removed ${removedCacheEntries} cache entr${removedCacheEntries === 1 ? "y" : "ies"} unused for ${cacheDays}+ days.\n`
        : "Cache pruning disabled (--cache-days 0).\n"
    );
    return 0;
  }

  throw new Error(`Unknown command "${commandName}".`);
}

async function handleCacheManifestCommand(args: string[], context: PipelineCliContext, program: string): Promise<number> {
  const jobId = optionalFlagValue(args, "--job");
  const taskId = optionalFlagValue(args, "--task");
  if ((jobId ? 1 : 0) + (taskId ? 1 : 0) !== 1) {
    throw new Error(`Usage: ${program} cache manifest (--job <id> | --task <id>) --output <path> [--trust read-only|read-write]`);
  }
  const outputPath = requiredFlagValue(args, "--output", `Usage: ${program} cache manifest (--job <id> | --task <id>) --output <path> [--trust read-only|read-write]`);
  const trust = (optionalFlagValue(args, "--trust") ?? "read-only") as GitHubCacheManifestTrust;
  if (trust !== "read-only" && trust !== "read-write") {
    throw new Error("--trust must be read-only or read-write.");
  }
  const manifest = jobId
    ? await cacheManifestForJob(context.pipeline, { id: jobId, trust, cwd: context.cwd, env: context.env, commands: context.commands, sandbox: context.sandboxId, execution: context.executionId, provider: context.provider })
    : await cacheManifestForTask(context.pipeline, taskId as string, { trust, cwd: context.cwd, env: context.env, commands: context.commands, sandbox: context.sandboxId, execution: context.executionId, provider: context.provider });
  const target = resolveRepoOutputPath(context.cwd, outputPath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  context.stdout(`Generated ${relativePath(context.cwd, target)}\n`);
  return 0;
}

async function handlePublishCommand(args: string[], context: PipelineCliContext, program: string): Promise<number> {
  const target = args[0];
  const packagePath = requiredFlagValue(args, "--package", `Usage: ${program} publish github <pr|main|release> --package <path> [--registry <url>] [--namespace <scope>] [--no-comment]\n       ${program} publish npm --package <path>`);
  if (target === "github") {
    const mode = args[1];
    if (mode !== "pr" && mode !== "main" && mode !== "release") {
      throw new Error(`Usage: ${program} publish github <pr|main|release> --package <path> [--registry <url>] [--namespace <scope>] [--no-comment]`);
    }
    const registry = optionalFlagValue(args, "--registry");
    const namespace = optionalFlagValue(args, "--namespace");
    const comment = !args.includes("--no-comment");
    return runLifecycleCli(
      () => publishGitHubPackage(mode as GitHubPackagePublishMode, { cwd: context.cwd, packagePath, registry, namespace, comment, env: context.env, io: context }),
      context
    );
  }
  if (target === "npm") {
    return runLifecycleCli(
      () => publishNpmPackage({ cwd: context.cwd, packagePath, env: context.env, io: context }),
      context
    );
  }
  throw new Error(`Usage: ${program} publish github <pr|main|release> --package <path> [--registry <url>] [--namespace <scope>] [--no-comment]\n       ${program} publish npm --package <path>`);
}

async function handleReleaseCommand(args: string[], context: PipelineCliContext, program: string): Promise<number> {
  const subcommand = args[0];
  const usage = `Usage: ${program} release <ensure|doctor|sync-descriptions> --package <path>`;
  const packagePath = requiredFlagValue(args, "--package", usage);
  if (subcommand === "ensure") {
    return runLifecycleCli(
      () => ensureGitHubRelease({ cwd: context.cwd, packagePath, env: context.env, io: context }),
      context
    );
  }
  if (subcommand === "doctor") {
    return runLifecycleCli(
      () => runReleaseDoctor({ cwd: context.cwd, packagePath, env: context.env, io: context }),
      context
    );
  }
  if (subcommand === "sync-descriptions") {
    return runLifecycleCli(
      () => syncGitHubReleaseDescriptions({ cwd: context.cwd, packagePath, env: context.env, io: context, check: args.includes("--check") }),
      context
    );
  }
  throw new Error(usage);
}

async function handleLifecycleCommand(
  args: string[],
  context: Pick<PipelineCliContext, "cwd" | "stdout" | "stderr">,
  program: string
): Promise<number> {
  const subcommand = args[0] ?? "help";
  if (subcommand !== "audit") {
    throw new Error(`Usage: ${program} lifecycle audit [--package <path>] [--format text|json]`);
  }
  const rest = args.slice(1);
  const format = lifecycleAuditFormat(rest);
  const packagePath = optionalFlagValue(rest, "--package");
  const report = await auditLifecycle({ cwd: context.cwd, packagePath });
  if (format === "json") {
    context.stdout(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    context.stdout(renderLifecycleAuditText(report));
  }
  return 0;
}

function lifecycleAuditFormat(args: string[]): LifecycleAuditFormat {
  const format = optionalFlagValue(args, "--format") ?? "text";
  if (format !== "text" && format !== "json") {
    throw new Error("--format must be text or json.");
  }
  return format;
}

async function printDryRun(context: PipelineCliContext, format: "text" | "json", jobId?: string, taskId?: string): Promise<number> {
  let pipeline = context.pipeline;
  let id = jobId;
  if (taskId !== undefined) {
    id = `task:${taskId}`;
    pipeline = {
      ...pipeline,
      jobs: { ...pipeline.jobs, [id]: { id, target: [taskId], trigger: [] } }
    };
  }
  if (!id) throw new Error("Dry run requires a job or task.");
  const selectedJob = jobId ? pipeline.jobs[jobId] : undefined;
  const plan = await planJob(pipeline, { id, cwd: context.cwd, env: context.env, sandbox: context.sandboxId, execution: context.executionId ?? selectedJob?.execution, provider: context.provider });
  if (format === "json") {
    context.stdout(`${JSON.stringify(plan, null, 2)}\n`);
    return 0;
  }
  context.stdout(`Plan ${context.pipeline.name}:${jobId ?? taskId} (${plan.executionOrder.join(" -> ")})\n`);
  for (const entry of plan.entries) {
    const note = context.force && entry.predicted === "cached"
      ? "run (cache ignored by --force)"
      : entry.predicted;
    context.stdout(`  ${entry.id}\t${note}${entry.reason ? `\t${entry.reason}` : ""}\n`);
  }
  context.stdout("Dry run: no tasks executed. Cached predictions do not verify restored output files.\n");
  return 0;
}

async function githubPlanOptions(args: string[], context: PipelineCliContext, paths: { workflowPath?: string; lockPath?: string }): Promise<GitHubPlanOptions> {
  const eventContext = args.includes("--event") ? undefined : await readGitHubEventContext(context.env);
  return {
    cwd: context.cwd,
    configPath: context.configPath,
    ...paths,
    job: optionalFlagValue(args, "--job"),
    repository: optionalFlagValue(args, "--repository") ?? context.env.GITHUB_REPOSITORY,
    eventName: optionalFlagValue(args, "--event") ?? eventContext?.eventName,
    eventAction: optionalFlagValue(args, "--event-action") ?? eventContext?.action,
    ref: optionalFlagValue(args, "--ref") ?? eventContext?.ref,
    sha: optionalFlagValue(args, "--sha"),
    actor: optionalFlagValue(args, "--actor"),
    schedule: optionalFlagValue(args, "--schedule") ?? eventContext?.schedule,
    selectedJob: optionalFlagValue(args, "--selected-job") ?? eventContext?.selectedJob,
    prNumber: optionalPositiveIntegerFlag(args, "--pr-number"),
    headRepo: optionalFlagValue(args, "--head-repo"),
    headSha: optionalFlagValue(args, "--head-sha"),
    baseRef: optionalFlagValue(args, "--base-ref") ?? eventContext?.baseRef,
    sameRepository: optionalBooleanFlag(args, "--same-repository"),
    network: parseGitHubNetwork(args)
  };
}

function githubOutputFormat(args: string[]): "text" | "json" {
  const format = optionalFlagValue(args, "--format") ?? "text";
  if (format !== "text" && format !== "json") {
    throw new Error("--format must be text or json.");
  }
  return format;
}

function parseGitHubNetwork(args: string[]): GitHubLocalNetworkMode {
  if (args.includes("--mock-network")) return "mock";
  const network = optionalFlagValue(args, "--network") ?? "mock";
  if (network !== "mock" && network !== "deny" && network !== "allow") {
    throw new Error("--network must be mock, deny, or allow.");
  }
  return network;
}

function cloudflarePlanOptions(args: string[], context: PipelineCliContext): CloudflareWorkflowPlanOptions {
  const source = optionalFlagValue(args, "--source") ?? "github";
  if (source !== "github" && source !== "cloudflare") {
    throw new Error("--source must be github or cloudflare.");
  }
  return {
    cwd: context.cwd,
    configPath: context.configPath,
    job: optionalFlagValue(args, "--job"),
    event: optionalFlagValue(args, "--event") as CloudflareWorkflowPlanOptions["event"],
    source,
    action: optionalFlagValue(args, "--event-action"),
    ref: optionalFlagValue(args, "--ref"),
    branch: optionalFlagValue(args, "--branch") ?? optionalFlagValue(args, "--base-ref"),
    sha: optionalFlagValue(args, "--sha"),
    repository: optionalFlagValue(args, "--repository"),
    owner: optionalFlagValue(args, "--owner"),
    repo: optionalFlagValue(args, "--repo"),
    installationId: optionalPositiveIntegerFlag(args, "--installation-id"),
    pullRequestNumber: optionalPositiveIntegerFlag(args, "--pr-number"),
    pullRequestHeadSha: optionalFlagValue(args, "--head-sha"),
    pullRequestHeadRepo: optionalFlagValue(args, "--head-repo"),
    sameRepository: optionalBooleanFlag(args, "--same-repository"),
    releaseTag: optionalFlagValue(args, "--release-tag"),
    releaseAction: optionalFlagValue(args, "--release-action"),
    requestedJob: optionalFlagValue(args, "--requested-job")
  };
}

function cloudflareOutputFormat(args: string[]): "text" | "json" {
  const format = optionalFlagValue(args, "--format") ?? "text";
  if (format !== "text" && format !== "json") {
    throw new Error("--format must be text or json.");
  }
  return format;
}

function cloudflareRunMode(args: string[]): CloudflareWorkflowMockMode {
  const mode = optionalFlagValue(args, "--mode") ?? "mock";
  if (mode !== "mock") {
    throw new Error("--mode must be mock.");
  }
  return mode;
}

function renderCloudflarePlanText(plan: CloudflareWorkflowPlanResult): string {
  const lines = [
    `Cloudflare plan for ${plan.event.source}:${plan.event.event}`,
    `Worker: ${plan.sync.worker}`,
    `Queue: ${plan.sync.queue}`,
    `Workflow: ${plan.sync.workflow}`,
    "Selected jobs:"
  ];
  if (plan.jobs.length === 0) {
    lines.push("  none");
  } else {
    for (const job of plan.jobs) {
      lines.push(`  ${job.id}`);
      lines.push(`    lifecycle: ${job.lifecycle.join(" -> ")}`);
      lines.push(`    idempotency: ${job.idempotencyKey}`);
      lines.push(`    trust: ${job.trust.reason}; writes: ${job.trust.writeCredentials ? "enabled" : "disabled"}; cache-save: ${job.trust.cacheSave ? "enabled" : "disabled"}`);
      lines.push(`    effects: ${job.effects.map((effect) => effect.kind).join(", ") || "none"}`);
    }
  }
  if (plan.skippedJobs.length > 0) {
    lines.push("Skipped jobs:");
    for (const skipped of plan.skippedJobs) {
      lines.push(`  ${skipped.id}: ${skipped.reason}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function optionalBooleanFlag(args: string[], flag: string): boolean | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) return true;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${flag} must be true or false.`);
}

function optionalPositiveIntegerFlag(args: string[], flag: string): number | undefined {
  const raw = optionalFlagValue(args, flag);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${flag} requires a non-negative integer.`);
  }
  return value;
}

function renderGitHubPlanText(plan: GitHubPlanResult): string {
  const lines = [
    `GitHub plan for ${plan.event.name}${plan.event.action ? `:${plan.event.action}` : ""}`,
    `Workflow: ${plan.workflow}`,
    `Lock: ${plan.lock}`,
    "Selected jobs:"
  ];
  if (plan.manifests.length === 0) {
    lines.push("  none");
  } else {
    for (const manifest of plan.manifests) {
      const matrix = manifest.job.matrix?.length ? ` (${manifest.job.matrix.length} matrix leg${manifest.job.matrix.length === 1 ? "" : "s"})` : "";
      lines.push(`  ${manifest.job.id}${matrix}`);
      lines.push(`    permissions: ${Object.entries(manifest.job.permissions).map(([scope, access]) => `${scope}:${access}`).join(", ") || "none"}`);
      lines.push(`    steps: ${manifest.steps.length}; artifacts: ${manifest.artifacts.length}; network: ${manifest.local.network}`);
    }
  }
  if (plan.skippedJobs.length > 0) {
    lines.push("Skipped jobs:");
    for (const skipped of plan.skippedJobs) {
      lines.push(`  ${skipped.id}: ${skipped.reason}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function runOutputFormat(args: string[], program: string): "text" | "json" {
  const formatIndex = args.indexOf("--format");
  if (formatIndex < 0) return "text";
  const format = args[formatIndex + 1];
  if (format !== "text" && format !== "json") {
    throw new Error(`Usage: ${program} run <job> --format text|json`);
  }
  return format;
}

const DEFAULT_KEPT_RUNS = 50;

async function pruneRunsAfterRun(context: PipelineCliContext): Promise<void> {
  const raw = context.env.ASYNC_PIPELINE_KEEP_RUNS;
  let keep = DEFAULT_KEPT_RUNS;
  if (raw !== undefined && raw !== "") {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 0) return;
    if (parsed === 0) return; // 0 disables automatic pruning.
    keep = parsed;
  }
  await pruneRuns(context.cwd, keep);
}

async function pruneRuns(cwd: string, keep: number): Promise<number> {
  const runsDir = join(cwd, ".async", "runs");
  let runIds: string[] = [];
  try {
    runIds = (await readdir(runsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left));
  } catch {
    return 0;
  }
  const stale = runIds.slice(keep);
  for (const runId of stale) {
    await rm(join(runsDir, runId), { recursive: true, force: true });
  }
  return stale.length;
}

async function countRuns(cwd: string): Promise<number> {
  try {
    const entries = await readdir(join(cwd, ".async", "runs"), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).length;
  } catch {
    return 0;
  }
}

function collectFlagValues(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== flag) continue;
    const value = args[index + 1];
    if (!value) throw new Error(`${flag} requires a value.`);
    values.push(value);
    index += 1;
  }
  return values;
}

function requiredFlagValue(args: string[], flag: string, usage: string): string {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) throw new Error(usage);
  return value;
}

function optionalFlagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value) throw new Error(`${flag} requires a value.`);
  return value;
}

function parsePositiveInteger(args: string[], flag: string, fallback: number): number {
  const index = args.indexOf(flag);
  if (index < 0) return fallback;
  const raw = args[index + 1];
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${flag} requires a non-negative integer.`);
  }
  return value;
}

async function handleSourcesCommand(args: string[], context: PipelineCliContext): Promise<number> {
  const subcommand = args[0] ?? "list";
  if (subcommand === "list") {
    const store = virtualStore(context.cwd);
    const sources = await resolveSources(context.pipeline, context.cwd, store, { sync: false, loadPipelines: false });
    for (const source of Object.values(sources)) {
      const detail = source.definition.type === "git"
        ? `${source.definition.url}#${source.definition.ref}`
        : source.definition.path;
      context.stdout(`${source.id}\t${source.definition.type}\t${detail}\t${source.dir}\n`);
    }
    return 0;
  }
  if (subcommand === "sync") {
    const store = await createStore(context.cwd);
    const sources = await resolveSources(context.pipeline, context.cwd, store, { sync: true, loadPipelines: true });
    for (const source of Object.values(sources)) context.stdout(`${source.id}\t${source.record.commit ?? "unknown"}\t${source.dir}\n`);
    return 0;
  }
  throw new Error(`Unknown sources command "${subcommand}".`);
}

interface RunGraphEvidenceNode {
  id: string;
  kind?: string;
  fingerprint?: string;
  dependsOn?: string[];
  dependents?: string[];
  inputs?: string[];
  outputs?: string[];
  effects?: Array<Record<string, unknown>>;
  source?: string;
}

interface RunGraphEvidence {
  schemaVersion?: number;
  pipelineName?: string;
  jobId?: string;
  executionOrder?: string[];
  nodes?: RunGraphEvidenceNode[];
}

interface RunEvidenceTask {
  id: string;
  status?: TaskResult["status"];
  attempts?: number;
  cacheKey?: string;
  cacheHit?: boolean;
  durationMs?: number;
  graphNodeFingerprint?: string;
  dependsOn: string[];
  dependents: string[];
  effects: Array<Record<string, unknown>>;
  cache?: TaskCacheReceipt;
  error?: string;
  contextPack?: TaskContextPack;
  logPath: string;
}

interface RunEvidence {
  schemaVersion: 1;
  runId: string;
  requestedRunId: string;
  pipelineName: string;
  jobId: string;
  status: ExecutionRecord["status"];
  startedAt: string;
  finishedAt?: string;
  executionOrder: string[];
  tasks: RunEvidenceTask[];
  cacheReceipts: TaskCacheReceipt[];
  contextPacks: TaskContextPack[];
  paths: {
    execution: string;
    graph: string;
    cache: string;
    context: string;
    logs: string;
  };
}

async function readRunEvidence(store: ReturnType<typeof virtualStore>, requestedRunId: string): Promise<RunEvidence> {
  const runId = await resolveRunId(store, requestedRunId);
  const runDir = join(store.runsDir, runId);
  const executionPath = join(runDir, "execution.json");
  const execution = await readJsonFile<ExecutionRecord>(executionPath);
  if (!execution) throw new Error(`Run "${runId}" was not found or has no execution record.`);
  const graph = await readJsonFile<RunGraphEvidence>(join(runDir, "graph.json"));
  const cacheReceipts = await readTaskCacheReceipts(store, runId);
  const contextPacks = await readContextPacks(store, runId);
  const paths = {
    execution: `.async/runs/${runId}/execution.json`,
    graph: `.async/runs/${runId}/graph.json`,
    cache: `.async/runs/${runId}/cache`,
    context: `.async/runs/${runId}/context`,
    logs: `.async/runs/${runId}/logs`
  };
  return {
    schemaVersion: 1,
    runId,
    requestedRunId,
    pipelineName: execution.pipelineName,
    jobId: execution.jobId,
    status: execution.status,
    startedAt: execution.startedAt,
    ...(execution.finishedAt === undefined ? {} : { finishedAt: execution.finishedAt }),
    executionOrder: graph?.executionOrder ?? execution.tasks.map((task) => task.id),
    tasks: buildRunEvidenceTasks(execution, graph, cacheReceipts, contextPacks, paths.logs),
    cacheReceipts,
    contextPacks,
    paths
  };
}

async function resolveRunId(store: ReturnType<typeof virtualStore>, requestedRunId: string): Promise<string> {
  if (requestedRunId !== "latest") return requestedRunId;
  let entries: Array<{ isDirectory(): boolean; name: string }>;
  try {
    entries = await readdir(store.runsDir, { withFileTypes: true });
  } catch {
    throw new Error("No run records found.");
  }
  const candidates = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const candidate of candidates) {
    if (existsSync(join(store.runsDir, candidate, "execution.json"))) return candidate;
  }
  throw new Error("No run records found.");
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function buildRunEvidenceTasks(
  execution: ExecutionRecord,
  graph: RunGraphEvidence | null,
  cacheReceipts: TaskCacheReceipt[],
  contextPacks: TaskContextPack[],
  logsPath: string
): RunEvidenceTask[] {
  const graphNodes = new Map((graph?.nodes ?? []).map((node) => [node.id, node]));
  const taskResults = new Map(execution.tasks.map((task) => [task.id, task]));
  const cacheByTask = new Map(cacheReceipts.map((receipt) => [receipt.task, receipt]));
  const packByTask = new Map(contextPacks.map((pack) => [pack.task, pack]));
  const graphIndex = new Map((graph?.executionOrder ?? []).map((taskId, index) => [taskId, index]));
  const resultIndex = new Map(execution.tasks.map((task, index) => [task.id, index]));
  const taskIds = new Set<string>([
    ...(graph?.executionOrder ?? []),
    ...execution.tasks.map((task) => task.id),
    ...cacheReceipts.map((receipt) => receipt.task),
    ...contextPacks.map((pack) => pack.task)
  ]);

  return [...taskIds]
    .sort((left, right) => taskEvidenceSort(left, right, graphIndex, resultIndex))
    .map((taskId) => {
      const task = taskResults.get(taskId);
      const graphNode = graphNodes.get(taskId);
      const cache = cacheByTask.get(taskId);
      const pack = packByTask.get(taskId);
      return {
        id: taskId,
        ...(task?.status === undefined ? {} : { status: task.status }),
        ...(task?.attempts === undefined ? {} : { attempts: task.attempts }),
        ...(task?.cacheKey === undefined && cache?.cacheKey === undefined ? {} : { cacheKey: task?.cacheKey ?? cache?.cacheKey }),
        ...(task?.cacheHit === undefined ? {} : { cacheHit: task.cacheHit }),
        ...(task?.durationMs === undefined ? {} : { durationMs: task.durationMs }),
        ...(graphNode?.fingerprint === undefined && cache?.graphNodeFingerprint === undefined ? {} : { graphNodeFingerprint: graphNode?.fingerprint ?? cache?.graphNodeFingerprint }),
        dependsOn: graphNode?.dependsOn ?? [],
        dependents: graphNode?.dependents ?? [],
        effects: graphNode?.effects ?? [],
        ...(cache === undefined ? {} : { cache }),
        ...(task?.error === undefined && pack?.error === undefined ? {} : { error: task?.error ?? pack?.error }),
        ...(pack === undefined ? {} : { contextPack: pack }),
        logPath: `${logsPath}/${taskId.replaceAll(/[^a-zA-Z0-9._-]/g, "_")}.log`
      };
    });
}

function taskEvidenceSort(
  left: string,
  right: string,
  graphIndex: ReadonlyMap<string, number>,
  resultIndex: ReadonlyMap<string, number>
): number {
  const leftRank = graphIndex.get(left) ?? resultIndex.get(left) ?? Number.MAX_SAFE_INTEGER;
  const rightRank = graphIndex.get(right) ?? resultIndex.get(right) ?? Number.MAX_SAFE_INTEGER;
  return leftRank - rightRank || left.localeCompare(right);
}

function renderRunEvidenceText(evidence: RunEvidence): string {
  const lines = [
    `Run ${evidence.runId} (${evidence.pipelineName}/${evidence.jobId}) ${evidence.status}`,
    "",
    "Evidence:",
    `  execution: ${evidence.paths.execution}`,
    `  graph: ${evidence.paths.graph}`,
    `  cache receipts: ${evidence.paths.cache}`,
    `  context packs: ${evidence.paths.context}`,
    `  logs: ${evidence.paths.logs}`,
    "",
    "Tasks:"
  ];

  if (evidence.tasks.length === 0) {
    lines.push("  none recorded");
  }

  for (const task of evidence.tasks) {
    const status = task.status ?? "not-recorded";
    const attempts = task.attempts === undefined ? "" : `, ${task.attempts} attempt${task.attempts === 1 ? "" : "s"}`;
    const cache = task.cache ? `, cache ${task.cache.decision}${task.cache.reason ? ` (${task.cache.reason})` : ""}` : "";
    lines.push(`  ${task.id}: ${status}${attempts}${cache}`);
    if (task.cacheKey) lines.push(`    cache key: ${task.cacheKey}`);
    if (task.graphNodeFingerprint) lines.push(`    graph fingerprint: ${task.graphNodeFingerprint}`);
    if (task.dependsOn.length > 0) lines.push(`    depends on: ${task.dependsOn.join(", ")}`);
    if (task.error) lines.push(`    error: ${task.error}`);
    if (task.contextPack) {
      const pack = task.contextPack;
      if ("baselineMissing" in pack.inputDiff) {
        lines.push("    inputs: no passing baseline recorded");
      } else {
        const diff = pack.inputDiff;
        lines.push(`    inputs vs last pass: ${diff.changed.length} changed, ${diff.added.length} added, ${diff.removed.length} removed`);
        for (const path of diff.changed) lines.push(`      ~ ${path}`);
        for (const path of diff.added) lines.push(`      + ${path}`);
        for (const path of diff.removed) lines.push(`      - ${path}`);
      }
      if (pack.claims?.length) lines.push(`    claims touched: ${pack.claims.join(", ")}`);
      lines.push(`    reproduce: ${pack.reproduce}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function printHelp(program: string): string {
  return `Usage:
  ${program} run <job> [--execution <id>] [--sandbox <id>] [--provider auto|docker|apple-container|lima] [--concurrency <n>] [--force] [--dry-run] [--format text|json]
  ${program} run-task <task> [--execution <id>] [--sandbox <id>] [--provider auto|docker|apple-container|lima] [--concurrency <n>] [--force] [--dry-run] [--format text|json]
  ${program} list
  ${program} graph --format json|dot
  ${program} explain <task> [--diff-inputs] [--format text|json]
  ${program} explain --run <run-id|latest> [--format text|json]
  ${program} mcp [--allow-run]
  ${program} sources list
  ${program} sources sync
  ${program} metadata --format json [--include-sources]
  ${program} matrix <job> --format github
  ${program} publish github <pr|main|release> --package <path> [--registry <url>] [--namespace <scope>] [--no-comment]
  ${program} publish npm --package <path>
  ${program} release ensure --package <path>
  ${program} release doctor --package <path>
  ${program} release sync-descriptions --package <path> [--check]
  ${program} signoff create [context...] [--job <id>] [--run latest|<id>] [--sha <ref>] [--context <name>] [--force] [--no-run] [--dry-run] [--format text|json]
  ${program} signoff status [context...] [--job <id>] [--sha <ref>] [--context <name>] [--local-only|--remote-only] [--format text|json]
  ${program} signoff revoke [context...] [--job <id>] [--sha <ref>] [--context <name>] [--reason <text>] [--dry-run] [--format text|json]
  ${program} signoff check [context...] [--job <id>] [--sha <ref>] [--context <name>] [--local-only|--remote-only] [--format text|json]
  ${program} lifecycle audit [--package <path>] [--format text|json]
  ${program} sync list
  ${program} sync generate
  ${program} sync check
  ${program} sync github list
  ${program} sync github generate [--workflow <path>] [--lock <path>]
  ${program} sync github check [--workflow <path>] [--lock <path>]
  ${program} sync cloudflare list
  ${program} sync cloudflare generate
  ${program} sync cloudflare check
  ${program} sync tasks list
  ${program} sync tasks generate
  ${program} sync tasks check
  ${program} github generate [--workflow <path>] [--lock <path>]
  ${program} github check [--workflow <path>] [--lock <path>]
  ${program} github plan [--job <id>] [--event <name>] [--event-action <action>] [--repository <owner/repo>] [--head-repo <owner/repo>] [--same-repository true|false] [--format text|json] [--check]
  ${program} github run [--job <id>] [--event <name>] [--event-action <action>] [--repository <owner/repo>] [--head-repo <owner/repo>] [--same-repository true|false] [--network mock|deny|allow] [--dry-run] [--format text|json]
  ${program} cloudflare plan [--job <id>] [--source github|cloudflare] [--event push|pull_request|release|schedule|manual] [--repository <owner/repo>] [--head-repo <owner/repo>] [--same-repository true|false] [--format text|json]
  ${program} cloudflare run [--job <id>] [--source github|cloudflare] [--event push|pull_request|release|schedule|manual] [--repository <owner/repo>] [--head-repo <owner/repo>] [--same-repository true|false] [--mode mock] [--dry-run] [--format text|json]
  ${program} cache clear
  ${program} gc [--keep <n>] [--cache-days <n>]
  ${program} doctor\n`;
}

async function handleSyncCommand(args: string[], context: PipelineCliContext): Promise<number> {
  const targetNames = new Set(["github", "tasks", "cloudflare"]);
  const maybeTarget = args[0];
  const target = targetNames.has(maybeTarget ?? "") ? maybeTarget : undefined;
  const subcommand = target ? args[1] ?? "list" : args[0] ?? "list";
  const rest = target ? args.slice(2) : args.slice(1);

  if (target === "github") return handleSyncGitHubCommand(subcommand, rest, context, { requireConfigured: true });
  if (target === "tasks") return handleSyncTasksCommand(subcommand, context, { requireConfigured: true });
  if (target === "cloudflare") return handleSyncCloudflareCommand(subcommand, context, { requireConfigured: true });

  if (subcommand === "list") {
    let listed = false;
    if (context.pipeline.sync.github.enabled) {
      context.stdout(`GitHub workflow: ${context.pipeline.sync.github.workflow}\n`);
      context.stdout(`GitHub lock: ${context.pipeline.sync.github.lock}\n`);
      listed = true;
    }
    if (context.pipeline.sync.tasks.enabled) {
      for (const line of describeTaskSync(await renderTaskSync(context.pipeline, context))) context.stdout(`${line}\n`);
      listed = true;
    }
    if (context.pipeline.sync.cloudflare.enabled) {
      for (const line of describeCloudflareSync(await renderCloudflareSync(context.pipeline, context))) context.stdout(`${line}\n`);
      listed = true;
    }
    if (!listed) context.stdout("No sync targets configured.\n");
    return 0;
  }

  if (subcommand === "generate") {
    let generated = false;
    if (context.pipeline.sync.github.enabled) {
      await handleSyncGitHubCommand("generate", rest, context, { requireConfigured: false });
      generated = true;
    }
    if (context.pipeline.sync.tasks.enabled) {
      await handleSyncTasksCommand("generate", context, { requireConfigured: false });
      generated = true;
    }
    if (context.pipeline.sync.cloudflare.enabled) {
      await handleSyncCloudflareCommand("generate", context, { requireConfigured: false });
      generated = true;
    }
    if (!generated) throw new Error("No sync targets configured.");
    return 0;
  }

  if (subcommand === "check") {
    const issues: string[] = [];
    let checked = false;
    if (context.pipeline.sync.github.enabled) {
      const paths = githubGenerationPaths(rest);
      const rendered = await renderGitHubWorkflow(context.pipeline, { cwd: context.cwd, configPath: context.configPath, ...paths });
      issues.push(...await checkGitHubWorkflow(rendered, context.cwd));
      checked = true;
    }
    if (context.pipeline.sync.tasks.enabled) {
      const rendered = await renderTaskSync(context.pipeline, context);
      issues.push(...await checkTaskSync(rendered, context.cwd));
      checked = true;
    }
    if (context.pipeline.sync.cloudflare.enabled) {
      const rendered = await renderCloudflareSync(context.pipeline, context);
      issues.push(...await checkCloudflareSync(rendered, context.cwd));
      checked = true;
    }
    if (!checked) throw new Error("No sync targets configured.");
    if (issues.length > 0) {
      for (const issue of issues) context.stderr(`${issue}\n`);
      return 1;
    }
    context.stdout("Sync targets are current.\n");
    return 0;
  }

  throw new Error(`Unknown sync command "${subcommand}".`);
}

async function handleSyncGitHubCommand(
  subcommand: string,
  args: string[],
  context: PipelineCliContext,
  options: { requireConfigured: boolean }
): Promise<number> {
  if (options.requireConfigured && !context.pipeline.sync.github.enabled) {
    throw new Error("GitHub sync is not configured. Add sync.github to pipeline.ts.");
  }
  const paths = githubGenerationPaths(args);
  const rendered = await renderGitHubWorkflow(context.pipeline, { cwd: context.cwd, configPath: context.configPath, ...paths });
  if (subcommand === "list") {
    context.stdout(`GitHub workflow: ${rendered.workflowPath}\n`);
    context.stdout(`GitHub lock: ${rendered.lockPath}\n`);
    return 0;
  }
  if (subcommand === "generate") {
    await writeGitHubWorkflow(rendered, context.cwd);
    context.stdout(`Generated ${rendered.workflowPath}\n`);
    context.stdout(`Generated ${rendered.lockPath}\n`);
    return 0;
  }
  if (subcommand === "check") {
    const issues = await checkGitHubWorkflow(rendered, context.cwd);
    if (issues.length > 0) {
      for (const issue of issues) context.stderr(`${issue}\n`);
      return 1;
    }
    context.stdout("GitHub workflow is current.\n");
    return 0;
  }
  throw new Error(`Unknown sync github command "${subcommand}".`);
}

async function handleSyncTasksCommand(
  subcommand: string,
  context: PipelineCliContext,
  options: { requireConfigured: boolean }
): Promise<number> {
  const rendered = await renderTaskSync(context.pipeline, context);
  if (subcommand === "list") {
    for (const line of describeTaskSync(rendered)) context.stdout(`${line}\n`);
    return options.requireConfigured && !rendered.enabled ? 1 : 0;
  }
  if (subcommand === "generate") {
    if (options.requireConfigured && !rendered.enabled) throw new Error("Task sync is not configured. Add sync.tasks to pipeline.ts.");
    await writeTaskSync(rendered, context.cwd);
    for (const manifest of rendered.manifests) context.stdout(`Generated ${manifest.path}\n`);
    context.stdout(`Generated ${rendered.lockPath}\n`);
    return 0;
  }
  if (subcommand === "check") {
    const issues = await checkTaskSync(rendered, context.cwd, { requireConfigured: options.requireConfigured });
    if (issues.length > 0) {
      for (const issue of issues) context.stderr(`${issue}\n`);
      return 1;
    }
    context.stdout("Task sync is current.\n");
    return 0;
  }
  throw new Error(`Unknown sync tasks command "${subcommand}".`);
}

async function handleSyncCloudflareCommand(
  subcommand: string,
  context: PipelineCliContext,
  options: { requireConfigured: boolean }
): Promise<number> {
  const rendered = await renderCloudflareSync(context.pipeline, context);
  if (subcommand === "list") {
    for (const line of describeCloudflareSync(rendered)) context.stdout(`${line}\n`);
    return options.requireConfigured && !rendered.enabled ? 1 : 0;
  }
  if (subcommand === "generate") {
    if (options.requireConfigured && !rendered.enabled) throw new Error("Cloudflare sync is not configured. Add sync.cloudflare to pipeline.ts.");
    await writeCloudflareSync(rendered, context.cwd);
    for (const file of rendered.files) context.stdout(`Generated ${file.path}\n`);
    context.stdout(`Generated ${rendered.lockPath}\n`);
    return 0;
  }
  if (subcommand === "check") {
    const issues = await checkCloudflareSync(rendered, context.cwd, { requireConfigured: options.requireConfigured });
    if (issues.length > 0) {
      for (const issue of issues) context.stderr(`${issue}\n`);
      return 1;
    }
    context.stdout("Cloudflare sync is current.\n");
    return 0;
  }
  throw new Error(`Unknown sync cloudflare command "${subcommand}".`);
}

function parseGlobalOptions(args: string[]): ParsedGlobalOptions {
  const rest: string[] = [];
  let concurrency: number | undefined;
  let sandboxId: string | undefined;
  let executionId: string | undefined;
  let provider: ContainerProvider | undefined;
  let force = false;
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--sandbox") {
      sandboxId = args[index + 1];
      if (!sandboxId) throw new Error("Usage: async-pipeline <command> --sandbox <id>");
      index += 1;
      continue;
    }
    if (arg === "--execution") {
      executionId = args[index + 1];
      if (!executionId) throw new Error("Usage: async-pipeline <command> --execution <id>");
      index += 1;
      continue;
    }
    if (arg === "--provider") {
      const raw = args[index + 1];
      if (!raw || !isContainerProvider(raw)) throw new Error("Usage: async-pipeline <command> --provider auto|docker|apple-container|lima");
      provider = raw;
      index += 1;
      continue;
    }
    if (arg === "--concurrency") {
      const raw = args[index + 1];
      if (!raw) throw new Error("Usage: async-pipeline <command> --concurrency <n>");
      concurrency = Number(raw);
      index += 1;
      continue;
    }
    rest.push(arg);
  }
  return { args: rest, concurrency, sandboxId, executionId, provider, force, dryRun };
}

function isContainerProvider(value: string): value is ContainerProvider {
  return value === "auto" || value === "docker" || value === "apple-container" || value === "lima";
}


function findPipelineConfig(cwd: string): string | null {
  let current = resolve(cwd);
  for (;;) {
    for (const fileName of DEFAULT_PIPELINE_CONFIG_FILES) {
      const configPath = join(current, fileName);
      if (existsSync(configPath)) return configPath;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function formatPipelineConfigList(): string {
  return `${DEFAULT_PIPELINE_CONFIG_FILES.slice(0, -1).join(", ")}, or ${DEFAULT_PIPELINE_CONFIG_FILES[DEFAULT_PIPELINE_CONFIG_FILES.length - 1]}`;
}

function programName(): string {
  const name = basename(process.argv[1] ?? "async-pipeline");
  return name === "cli.js" ? "async-pipeline" : name;
}

// Failed runs must name the reason on the terminal, not only inside
// .async/runs/<id>/execution.json. Task output was already streamed; this
// repeats the recorded per-task error next to the final status line.
function reportFailedTasks(context: PipelineCliContext, tasks: { id: string; status: string; error?: string }[]): void {
  for (const failed of tasks.filter((task) => task.status === "failed")) {
    context.stderr(`Task ${failed.id} failed${failed.error ? `: ${failed.error}` : ""}\n`);
  }
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "function") return "[function]";
  return value;
}

/**
 * The published package's version for MCP serverInfo, falling back to this
 * internal package's own. Best-effort: identity metadata, not behavior.
 */
async function ownPackageVersion(): Promise<string | undefined> {
  for (const candidate of ["../../pipeline/package.json", "../package.json"]) {
    try {
      const manifest = JSON.parse(await readFile(new URL(candidate, import.meta.url), "utf8")) as { version?: string };
      if (typeof manifest.version === "string") return manifest.version;
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

function githubGenerationPaths(args: string[]): { workflowPath?: string; lockPath?: string } {
  const workflowIndex = args.indexOf("--workflow");
  const lockIndex = args.indexOf("--lock");
  const workflowPath = workflowIndex >= 0 ? args[workflowIndex + 1] : undefined;
  const lockPath = lockIndex >= 0 ? args[lockIndex + 1] : undefined;
  if (workflowIndex >= 0 && !workflowPath) throw new Error("Usage: async-pipeline github <generate|check> --workflow <path>");
  if (lockIndex >= 0 && !lockPath) throw new Error("Usage: async-pipeline github <generate|check> --lock <path>");
  return { workflowPath, lockPath };
}

function resolveRepoOutputPath(cwd: string, path: string): string {
  if (!path || path.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(path)) {
    throw new Error(`Output path "${path}" must be repo-relative.`);
  }
  if (path.split(/[\\/]+/u).some((part) => part === "" || part === "..")) {
    throw new Error(`Output path "${path}" cannot contain empty segments or ..`);
  }
  const target = resolve(cwd, path);
  const relativeTarget = relative(cwd, target);
  if (relativeTarget === ".." || relativeTarget.startsWith(`..${sep}`)) {
    throw new Error(`Output path "${path}" resolves outside the repository.`);
  }
  return target;
}

function relativePath(cwd: string, path: string): string {
  return relative(cwd, resolve(path)).split(/[\\/]+/u).join("/");
}

async function loadAvailableSourceGraph(pipeline: NormalizedPipeline, cwd: string, store: Awaited<ReturnType<typeof createStore>>) {
  const sources = await resolveSources(pipeline, cwd, store, { sync: false, loadPipelines: true });
  const sourcePipelines: Parameters<typeof composePipelines>[1] = {};
  for (const [sourceId, resolved] of Object.entries(sources)) {
    if (!resolved.pipeline) continue;
    sourcePipelines[sourceId] = {
      pipeline: resolved.pipeline,
      context: sourceContext(resolved)
    };
  }
  return composePipelines(pipeline, sourcePipelines);
}

function virtualStore(root: string): Awaited<ReturnType<typeof createStore>> {
  return {
    root,
    asyncDir: resolve(root, ".async"),
    runsDir: resolve(root, ".async", "runs"),
    cacheDir: resolve(root, ".async", "cache", "tasks"),
    sourcesDir: resolve(root, ".async", "sources")
  };
}

export function runCliMain(): Promise<void> {
  // When the downstream pipe closes (e.g. `async-pipeline run x | head`),
  // terminate running task process groups, let the run finalize its
  // execution record, and exit 141 (128 + SIGPIPE) instead of crashing
  // with an unhandled EPIPE or orphaning task processes.
  const shutdownOnEpipe = (error: NodeJS.ErrnoException): void => {
    if (error.code === "EPIPE") {
      beginShutdown("SIGTERM", 141);
      return;
    }
    throw error;
  };
  process.stdout.on("error", shutdownOnEpipe);
  process.stderr.on("error", shutdownOnEpipe);

  return runPipelineCli({ args: process.argv.slice(2) }).then((result) => {
    process.exitCode = shutdownExitCode() ?? result.code;
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = shutdownExitCode() ?? 1;
  });
}

// True only when this module is the executed entrypoint. The public package
// bin (`@async/pipeline` dist/cli.js) is a different wrapper module, so it
// cannot rely on this guard; it imports and calls runCliMain() explicitly.
// Realpath the argv path so bin shims and node_modules symlinks still count
// as direct execution of this file.
function isCliEntrypoint(argvPath: string | undefined): boolean {
  if (!argvPath) return false;
  try {
    return pathToFileURL(realpathSync(argvPath)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isCliEntrypoint(process.argv[1])) {
  void runCliMain();
}
