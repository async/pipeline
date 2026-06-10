import {
  defaultRuntimeCache,
  isCacheDirective,
  parseCacheRef,
  type CacheDirective,
  type CacheRef,
  type CacheRegistryDefinition
} from "./cache.js";
import { AsyncPipelineError, pipelineError } from "./errors.js";

export { defineCache, fileCache, memoryCache } from "./cache.js";
export const cache = defaultRuntimeCache();

export type RuntimeStatus = "idle" | "running" | "passed" | "failed" | "started" | "stopped";
export type RuntimeNext = () => Promise<unknown>;
export type RuntimeNodeKind = "task" | "middleware" | "series" | "parallel" | "branch" | "cache";
export type RuntimeNodeStatus = "passed" | "failed" | "cached";

export interface RuntimeContext<Input = unknown> {
  input: Input;
  state: Record<string, unknown>;
  taskId: string;
  path: string[];
  signal?: AbortSignal;
  output?: unknown;
  cacheHit?: boolean;
}

export type RuntimeMiddleware<Input = unknown> = (context: RuntimeContext<Input>, next: RuntimeNext) => unknown | Promise<unknown>;
export type RuntimeBranchPredicate<Input = unknown> = (context: RuntimeContext<Input>) => boolean | Promise<boolean>;

export interface RuntimeSeriesDefinition<Input = unknown> {
  kind: "async-pipeline.runtime.series";
  items: RuntimeRunItem<Input>[];
}

export interface RuntimeParallelDefinition<Input = unknown> {
  kind: "async-pipeline.runtime.parallel";
  items: RuntimeRunItem<Input>[];
  concurrency?: number;
}

export interface RuntimeParallelOptions {
  concurrency?: number;
}

export interface RuntimeBranchDefinition<Input = unknown> {
  kind: "async-pipeline.runtime.branch";
  predicate: RuntimeBranchPredicate<Input>;
  whenTrue: RuntimeRunItem<Input>[];
  whenFalse?: RuntimeRunItem<Input>[];
}

export type RuntimeFlowDefinition<Input = unknown> =
  | RuntimeSeriesDefinition<Input>
  | RuntimeParallelDefinition<Input>
  | RuntimeBranchDefinition<Input>;

export type RuntimeRunItem<Input = unknown> =
  | RuntimeMiddleware<Input>
  | CacheDirective
  | RuntimeFlowDefinition<Input>
  | readonly RuntimeRunItem<Input>[];
export type RuntimeRunDefinition<Input = unknown> = RuntimeRunItem<Input> | readonly RuntimeRunItem<Input>[];

export interface RuntimeInspectNode {
  kind: RuntimeNodeKind;
  id: string;
  path: string[];
  children: RuntimeInspectNode[];
}

export interface RuntimeTaskConfig<Input = unknown> {
  id?: string;
  description?: string;
  dependsOn?: string[];
  cache?: false | CacheRef;
  run?: RuntimeRunDefinition<Input>;
}

export interface RuntimeTaskDefinition<Input = unknown> extends RuntimeTaskConfig<Input> {
  children: RuntimeTaskDefinition<Input>[];
  flow?: RuntimeInspectNode;
}

export interface RuntimeDefinition<Input = unknown> {
  kind: "runtime-definition";
  tasks: RuntimeTaskDefinition<Input>[];
  cache: CacheRegistryDefinition;
}

export interface RuntimeTaskResult {
  id: string;
  status: "passed" | "failed" | "cached";
  cacheHit: boolean;
  path?: string[];
  error?: string;
  errorCode?: string;
  nodes?: RuntimeNodeResult[];
}

export interface RuntimeNodeResult {
  id: string;
  kind: RuntimeNodeKind;
  path: string[];
  status: RuntimeNodeStatus;
  error?: string;
  errorCode?: string;
}

export interface RuntimeExecution {
  status: "passed" | "failed";
  tasks: RuntimeTaskResult[];
  nodes: RuntimeNodeResult[];
  output?: unknown;
  error?: string;
  errorCode?: string;
}

export interface Runtime<Input = unknown> {
  inspect(): RuntimeDefinition<Input>;
  run(input?: Input, options?: { task?: string; signal?: AbortSignal }): Promise<RuntimeExecution>;
  start(): Promise<void>;
  stop(): Promise<void>;
  close(): Promise<void>;
}

export function compose<Input = unknown>(...items: RuntimeRunDefinition<Input>[]): RuntimeSeriesDefinition<Input> {
  return {
    kind: "async-pipeline.runtime.series",
    items: normalizeVariadicRunItems(items)
  };
}

export function series<Input = unknown>(items: RuntimeRunDefinition<Input>): RuntimeSeriesDefinition<Input> {
  return {
    kind: "async-pipeline.runtime.series",
    items: runItemsFromDefinition(items)
  };
}

export function parallel<Input = unknown>(items: readonly RuntimeRunDefinition<Input>[]): RuntimeParallelDefinition<Input>;
export function parallel<Input = unknown>(options: RuntimeParallelOptions, items: readonly RuntimeRunDefinition<Input>[]): RuntimeParallelDefinition<Input>;
export function parallel<Input = unknown>(
  optionsOrItems: RuntimeParallelOptions | readonly RuntimeRunDefinition<Input>[],
  maybeItems?: readonly RuntimeRunDefinition<Input>[]
): RuntimeParallelDefinition<Input> {
  const itemsFirst = Array.isArray(optionsOrItems);
  if (itemsFirst && maybeItems !== undefined) {
    throw pipelineError("ASYNC_PIPELINE_RUNTIME_PARALLEL_OPTIONS_ORDER", "Pass runtime parallel options first: parallel(options, items).");
  }

  const options: RuntimeParallelOptions = itemsFirst ? {} : optionsOrItems as RuntimeParallelOptions;
  const items = itemsFirst ? optionsOrItems as readonly RuntimeRunDefinition<Input>[] : maybeItems;
  if (!items) {
    throw pipelineError("ASYNC_PIPELINE_RUNTIME_PARALLEL_ITEMS_REQUIRED", "Runtime parallel requires an items array.");
  }

  if (options.concurrency !== undefined && (!Number.isInteger(options.concurrency) || options.concurrency < 1)) {
    throw pipelineError("ASYNC_PIPELINE_RUNTIME_INVALID_CONCURRENCY", "Runtime parallel concurrency must be a positive integer.");
  }

  return {
    kind: "async-pipeline.runtime.parallel",
    items: items.map((item) => Array.isArray(item) ? [...item] as RuntimeRunItem<Input>[] : item as RuntimeRunItem<Input>),
    concurrency: options.concurrency
  };
}

export function branch<Input = unknown>(
  predicate: RuntimeBranchPredicate<Input>,
  whenTrue: RuntimeRunDefinition<Input>,
  whenFalse?: RuntimeRunDefinition<Input>
): RuntimeBranchDefinition<Input> {
  return {
    kind: "async-pipeline.runtime.branch",
    predicate,
    whenTrue: runItemsFromDefinition(whenTrue),
    whenFalse: whenFalse === undefined ? undefined : runItemsFromDefinition(whenFalse)
  };
}

export function task<Input = unknown>(config: RuntimeTaskConfig<Input>): RuntimeTaskDefinition<Input>;
export function task<Input = unknown>(config: RuntimeTaskConfig<Input>, runOrChildren: RuntimeRunDefinition<Input> | readonly RuntimeTaskDefinition<Input>[]): RuntimeTaskDefinition<Input>;
export function task<Input = unknown>(
  config: RuntimeTaskConfig<Input>,
  runOrChildren?: RuntimeRunDefinition<Input> | readonly RuntimeTaskDefinition<Input>[]
): RuntimeTaskDefinition<Input> {
  if (config.run !== undefined && runOrChildren !== undefined) {
    throw pipelineError("ASYNC_PIPELINE_TASK_ARGUMENT_CONFLICT", "Do not pass a second task argument when config.run is defined.");
  }

  if (isRuntimeTaskArray(runOrChildren)) {
    return { ...config, children: [...runOrChildren] };
  }

  return {
    ...config,
    run: runOrChildren === undefined ? config.run : runOrChildren as RuntimeRunDefinition<Input>,
    children: []
  };
}

export function defineRuntime<Input = unknown>(
  definition: readonly RuntimeTaskDefinition<Input>[] | readonly RuntimeRunItem<Input>[] | { tasks: readonly RuntimeTaskDefinition<Input>[] | readonly RuntimeRunItem<Input>[]; cache?: CacheRegistryDefinition }
): RuntimeDefinition<Input> {
  const objectDefinition = definition as { tasks: readonly RuntimeTaskDefinition<Input>[] | readonly RuntimeRunItem<Input>[]; cache?: CacheRegistryDefinition };
  const rawTasks = Array.isArray(definition) ? definition : objectDefinition.tasks;
  const tasks = isRuntimeTaskArray(rawTasks)
    ? rawTasks
    : rawTasks.length === 0 ? [] : [task({ id: "runtime" }, compose(...rawTasks as RuntimeRunItem<Input>[]))];
  const cache = Array.isArray(definition) ? defaultRuntimeCache() : (objectDefinition.cache ?? defaultRuntimeCache());
  return {
    kind: "runtime-definition",
    tasks: normalizeRuntimeTasks(tasks),
    cache
  };
}

export function createRuntime<Input = unknown>(
  definition: RuntimeDefinition<Input> | readonly RuntimeTaskDefinition<Input>[],
  options: { cache?: CacheRegistryDefinition } = {}
): Runtime<Input> {
  const runtimeDefinition: RuntimeDefinition<Input> = Array.isArray(definition)
    ? defineRuntime({ tasks: definition, cache: options.cache })
    : definition as RuntimeDefinition<Input>;
  const memoryCacheEntries = new Map<string, unknown>();
  let status: RuntimeStatus = "idle";

  return {
    inspect() {
      return runtimeDefinition;
    },
    async run(input?: Input, runOptions: { task?: string; signal?: AbortSignal } = {}) {
      status = "running";
      const state: Record<string, unknown> = {};
      const results: RuntimeTaskResult[] = [];
      const nodes: RuntimeNodeResult[] = [];
      const executionState: RuntimeExecutionState = {
        memoryCacheEntries,
        nodes,
        registry: runtimeDefinition.cache
      };
      try {
        const plan = createRuntimePlan(runtimeDefinition.tasks, runOptions.task);
        if (runOptions.task && plan.length === 0) {
          throw pipelineError("ASYNC_PIPELINE_RUNTIME_UNKNOWN_TASK", `Unknown runtime task "${runOptions.task}".`);
        }
        let output: unknown;
        for (const entry of plan) {
          output = await runRuntimeTask(entry.task, {
            input: input as Input,
            state,
            taskId: entry.task.id ?? entry.path.join("."),
            path: entry.path,
            signal: runOptions.signal
          }, executionState, results);
        }
        status = "passed";
        return { status: "passed", tasks: results, nodes, output };
      } catch (error) {
        status = "failed";
        return {
          status: "failed",
          tasks: results,
          nodes,
          output: undefined,
          error: errorMessage(error),
          errorCode: errorCode(error)
        };
      }
    },
    async start() {
      status = "started";
    },
    async stop() {
      status = "stopped";
    },
    async close() {
      status = "stopped";
    }
  };
}

async function runRuntimeTask<Input>(
  taskDefinition: RuntimeTaskDefinition<Input>,
  context: RuntimeContext<Input>,
  executionState: RuntimeExecutionState,
  results: RuntimeTaskResult[]
): Promise<unknown> {
  const nodeStart = executionState.nodes.length;
  try {
    const output = await withRuntimeNodeBoundary(
      { id: context.taskId, kind: "task", path: context.path },
      executionState,
      async () => {
        const items = runtimeRunItems(taskDefinition);
        return executeSeries(items, context, executionState, [...context.path, "run"], async () => context.output);
      },
      () => context.cacheHit ? "cached" : "passed"
    );
    results.push({
      id: context.taskId,
      status: context.cacheHit ? "cached" : "passed",
      cacheHit: context.cacheHit ?? false,
      path: context.path,
      nodes: executionState.nodes.slice(nodeStart)
    });
    return output;
  } catch (error) {
    results.push({
      id: context.taskId,
      status: "failed",
      cacheHit: false,
      path: context.path,
      error: errorMessage(error),
      errorCode: errorCode(error),
      nodes: executionState.nodes.slice(nodeStart)
    });
    throw error;
  }
}

function runtimeRunItems<Input>(taskDefinition: RuntimeTaskDefinition<Input>): RuntimeRunItem<Input>[] {
  const items = taskDefinition.run === undefined
    ? []
    : runItemsFromDefinition(taskDefinition.run);
  const runItems: RuntimeRunItem<Input>[] = [];
  if (taskDefinition.cache) {
    runItems.push(cache.use(taskDefinition.cache));
  }
  runItems.push(...items);
  return runItems;
}

interface RuntimeExecutionState {
  registry: CacheRegistryDefinition;
  memoryCacheEntries: Map<string, unknown>;
  nodes: RuntimeNodeResult[];
}

function cacheMiddleware<Input>(ref: CacheRef, executionState: RuntimeExecutionState): RuntimeMiddleware<Input> {
  const parsed = parseCacheRef(ref);
  return async (context, next) => {
    const cacheKey = JSON.stringify([parsed.store, parsed.strategy, context.taskId, context.input]);
    if (parsed.store === "memory" && executionState.memoryCacheEntries.has(cacheKey)) {
      context.cacheHit = true;
      context.output = executionState.memoryCacheEntries.get(cacheKey);
      return context.output;
    }
    if (!executionState.registry.stores[parsed.store]) {
      throw pipelineError("ASYNC_PIPELINE_UNKNOWN_CACHE_STORE", `Unknown cache store "${parsed.store}" in "${ref}".`);
    }
    const output = await next();
    if (parsed.store === "memory") executionState.memoryCacheEntries.set(cacheKey, output);
    context.output = output;
    return output;
  };
}

async function executeSeries<Input>(
  items: readonly RuntimeRunItem<Input>[],
  context: RuntimeContext<Input>,
  executionState: RuntimeExecutionState,
  path: string[],
  done: RuntimeNext
): Promise<unknown> {
  return withRuntimeNodeBoundary({ id: path.at(-1) ?? "series", kind: "series", path }, executionState, async () => {
    return composeRuntimeItems(items, context, executionState, path, done);
  });
}

async function composeRuntimeItems<Input>(
  items: readonly RuntimeRunItem<Input>[],
  context: RuntimeContext<Input>,
  executionState: RuntimeExecutionState,
  path: string[],
  done: RuntimeNext
): Promise<unknown> {
  let index = -1;
  const dispatch = async (position: number): Promise<unknown> => {
    if (position <= index) {
      throw pipelineError(
        "ASYNC_PIPELINE_RUNTIME_NEXT_CALLED_TWICE",
        `Runtime task "${context.taskId}" called next() more than once.`,
        { path }
      );
    }
    index = position;
    const item = items[position];
    if (!item) return done();
    const output = await executeRunItem(item, context, executionState, [...path, String(position)], () => dispatch(position + 1));
    if (output !== undefined) context.output = output;
    return context.output;
  };
  return dispatch(0);
}

async function executeRunItem<Input>(
  item: RuntimeRunItem<Input>,
  context: RuntimeContext<Input>,
  executionState: RuntimeExecutionState,
  path: string[],
  next: RuntimeNext
): Promise<unknown> {
  if (Array.isArray(item)) {
    return executeSeries(item, context, executionState, path, next);
  }

  if (isRuntimeSeriesDefinition(item)) {
    return executeSeries(item.items, context, executionState, path, next);
  }

  if (isRuntimeParallelDefinition(item)) {
    return executeParallel(item, context, executionState, path, next);
  }

  if (isRuntimeBranchDefinition(item)) {
    return executeBranch(item, context, executionState, path, next);
  }

  if (isCacheDirective(item)) {
    return withRuntimeNodeBoundary(
      { id: item.ref, kind: "cache", path },
      executionState,
      async () => cacheMiddleware(item.ref, executionState)(context, next),
      () => context.cacheHit ? "cached" : "passed"
    );
  }

  if (typeof item === "function") {
    return withRuntimeNodeBoundary({ id: item.name || "middleware", kind: "middleware", path }, executionState, async () => {
      const output = await item(context, next);
      if (output !== undefined) context.output = output;
      return context.output;
    });
  }

  throw pipelineError("ASYNC_PIPELINE_RUNTIME_INVALID_RUN_ITEM", `Invalid runtime run item at ${path.join(".")}.`);
}

async function executeParallel<Input>(
  definition: RuntimeParallelDefinition<Input>,
  context: RuntimeContext<Input>,
  executionState: RuntimeExecutionState,
  path: string[],
  next: RuntimeNext
): Promise<unknown> {
  return withRuntimeNodeBoundary({ id: path.at(-1) ?? "parallel", kind: "parallel", path }, executionState, async () => {
    const concurrency = definition.concurrency ?? Math.max(1, definition.items.length);
    const outputs: unknown[] = new Array(definition.items.length);
    const failures: Array<{ index: number; error: unknown }> = [];
    let nextIndex = 0;

    async function worker(): Promise<void> {
      while (nextIndex < definition.items.length) {
        const branchIndex = nextIndex;
        nextIndex += 1;
        const branchItem = definition.items[branchIndex];
        if (!branchItem) continue;
        const branchContext: RuntimeContext<Input> = {
          ...context,
          output: context.output,
          path: [...path, String(branchIndex)]
        };
        try {
          outputs[branchIndex] = await executeSeries(
            runItemsFromDefinition(branchItem),
            branchContext,
            executionState,
            [...path, String(branchIndex)],
            async () => branchContext.output
          );
        } catch (error) {
          failures.push({ index: branchIndex, error });
        }
      }
    }

    const workerCount = Math.min(concurrency, definition.items.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    if (failures.length > 0) {
      throw pipelineError(
        "ASYNC_PIPELINE_RUNTIME_PARALLEL_FAILED",
        `Runtime parallel node failed in task "${context.taskId}".`,
        { path, failures: failures.map((failure) => ({ index: failure.index, error: describeError(failure.error) })) }
      );
    }

    context.output = outputs;
    return next();
  });
}

async function executeBranch<Input>(
  definition: RuntimeBranchDefinition<Input>,
  context: RuntimeContext<Input>,
  executionState: RuntimeExecutionState,
  path: string[],
  next: RuntimeNext
): Promise<unknown> {
  return withRuntimeNodeBoundary({ id: path.at(-1) ?? "branch", kind: "branch", path }, executionState, async () => {
    let selected: boolean;
    try {
      selected = await definition.predicate(context);
    } catch (error) {
      throw pipelineError(
        "ASYNC_PIPELINE_RUNTIME_BRANCH_PREDICATE_FAILED",
        `Runtime branch predicate failed in task "${context.taskId}".`,
        { path, cause: describeError(error) }
      );
    }

    const items = selected ? definition.whenTrue : definition.whenFalse;
    if (!items) return next();
    return executeSeries(items, context, executionState, [...path, selected ? "true" : "false"], next);
  });
}

async function withRuntimeNodeBoundary<T>(
  node: { id: string; kind: RuntimeNodeKind; path: string[] },
  executionState: RuntimeExecutionState,
  run: () => Promise<T>,
  status: () => RuntimeNodeStatus = () => "passed"
): Promise<T> {
  try {
    const output = await run();
    executionState.nodes.push({ ...node, status: status() });
    return output;
  } catch (error) {
    const wrapped = wrapRuntimeNodeError(node, error);
    executionState.nodes.push({
      ...node,
      status: "failed",
      error: wrapped.message,
      errorCode: errorCode(error) ?? wrapped.code
    });
    throw wrapped;
  }
}

function normalizeRuntimeTasks<Input>(tasks: readonly RuntimeTaskDefinition<Input>[], prefix: string[] = []): RuntimeTaskDefinition<Input>[] {
  return tasks.map((taskDefinition, index) => {
    const id = taskDefinition.id ?? [...prefix, `task-${index + 1}`].join(".");
    const path = [...prefix, id];
    return {
      ...taskDefinition,
      id,
      children: normalizeRuntimeTasks(taskDefinition.children ?? [], path),
      flow: inspectRunDefinition(taskDefinition.run, [...path, "run"])
    };
  });
}

function flattenTasks<Input>(tasks: readonly RuntimeTaskDefinition<Input>[], path: string[] = []): Array<{ task: RuntimeTaskDefinition<Input>; path: string[] }> {
  const flattened: Array<{ task: RuntimeTaskDefinition<Input>; path: string[] }> = [];
  for (const taskDefinition of tasks) {
    const taskPath = [...path, taskDefinition.id ?? String(flattened.length + 1)];
    flattened.push({ task: taskDefinition, path: taskPath });
    flattened.push(...flattenTasks(taskDefinition.children, taskPath));
  }
  return flattened;
}

function createRuntimePlan<Input>(
  tasks: readonly RuntimeTaskDefinition<Input>[],
  target?: string
): Array<{ task: RuntimeTaskDefinition<Input>; path: string[] }> {
  const entries = flattenTasks(tasks);
  const byId = new Map<string, { task: RuntimeTaskDefinition<Input>; path: string[]; index: number; dependsOn: string[] }>();

  entries.forEach((entry, index) => {
    const id = entry.task.id ?? entry.path.join(".");
    if (byId.has(id)) {
      throw pipelineError("ASYNC_PIPELINE_RUNTIME_DUPLICATE_TASK", `Duplicate runtime task id "${id}".`);
    }
    const parentId = entry.path.length > 1 ? entry.path.at(-2) : undefined;
    byId.set(id, {
      ...entry,
      index,
      dependsOn: [...(entry.task.dependsOn ?? []), ...(parentId ? [parentId] : [])]
    });
  });

  const selected = target ? collectRuntimeDependencies(target, byId) : new Set(byId.keys());
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const order: string[] = [];

  const visit = (id: string, path: string[]): void => {
    if (!selected.has(id) || visited.has(id)) return;
    if (visiting.has(id)) {
      const start = path.indexOf(id);
      const cycle = [...path.slice(start), id].join(" -> ");
      throw pipelineError("ASYNC_PIPELINE_RUNTIME_DEPENDENCY_CYCLE", `Runtime task dependency cycle detected: ${cycle}.`);
    }
    const entry = byId.get(id);
    if (!entry) throw pipelineError("ASYNC_PIPELINE_RUNTIME_UNKNOWN_TASK", `Unknown runtime task "${id}".`);
    visiting.add(id);
    for (const dependency of [...entry.dependsOn].sort()) {
      if (!byId.has(dependency)) {
        throw pipelineError("ASYNC_PIPELINE_RUNTIME_MISSING_DEPENDENCY", `Runtime task "${id}" depends on missing task "${dependency}".`);
      }
      visit(dependency, [...path, id]);
    }
    visiting.delete(id);
    visited.add(id);
    order.push(id);
  };

  for (const id of [...selected].sort((left, right) => (byId.get(left)?.index ?? 0) - (byId.get(right)?.index ?? 0))) {
    visit(id, []);
  }

  return order.map((id) => {
    const entry = byId.get(id);
    if (!entry) throw pipelineError("ASYNC_PIPELINE_RUNTIME_UNKNOWN_TASK", `Unknown runtime task "${id}".`);
    return { task: entry.task, path: entry.path };
  });
}

function collectRuntimeDependencies<Input>(
  target: string,
  byId: Map<string, { task: RuntimeTaskDefinition<Input>; path: string[]; index: number; dependsOn: string[] }>
): Set<string> {
  if (!byId.has(target)) return new Set();
  const selected = new Set<string>();
  const visit = (id: string): void => {
    if (selected.has(id)) return;
    const entry = byId.get(id);
    if (!entry) throw pipelineError("ASYNC_PIPELINE_RUNTIME_UNKNOWN_TASK", `Unknown runtime task "${id}".`);
    selected.add(id);
    for (const dependency of entry.dependsOn) visit(dependency);
  };
  visit(target);
  return selected;
}

function isRuntimeTaskArray<Input>(value: unknown): value is readonly RuntimeTaskDefinition<Input>[] {
  return Array.isArray(value) && value.every((entry) => Boolean(entry) && typeof entry === "object" && "children" in entry);
}

function normalizeVariadicRunItems<Input>(items: readonly RuntimeRunDefinition<Input>[]): RuntimeRunItem<Input>[] {
  if (items.length === 1 && Array.isArray(items[0])) {
    return [...items[0] as readonly RuntimeRunItem<Input>[]];
  }
  return items.map((item) => item as RuntimeRunItem<Input>);
}

function runItemsFromDefinition<Input>(definition: RuntimeRunDefinition<Input>): RuntimeRunItem<Input>[] {
  if (isRuntimeSeriesDefinition(definition)) return [...definition.items];
  return Array.isArray(definition) ? [...definition] as RuntimeRunItem<Input>[] : [definition as RuntimeRunItem<Input>];
}

function isRuntimeSeriesDefinition<Input>(value: unknown): value is RuntimeSeriesDefinition<Input> {
  return Boolean(value)
    && typeof value === "object"
    && (value as { kind?: unknown }).kind === "async-pipeline.runtime.series";
}

function isRuntimeParallelDefinition<Input>(value: unknown): value is RuntimeParallelDefinition<Input> {
  return Boolean(value)
    && typeof value === "object"
    && (value as { kind?: unknown }).kind === "async-pipeline.runtime.parallel";
}

function isRuntimeBranchDefinition<Input>(value: unknown): value is RuntimeBranchDefinition<Input> {
  return Boolean(value)
    && typeof value === "object"
    && (value as { kind?: unknown }).kind === "async-pipeline.runtime.branch";
}

function inspectRunDefinition<Input>(definition: RuntimeRunDefinition<Input> | undefined, path: string[]): RuntimeInspectNode {
  const items = definition === undefined ? [] : runItemsFromDefinition(definition);
  return inspectSeries(items, path);
}

function inspectSeries<Input>(items: readonly RuntimeRunItem<Input>[], path: string[]): RuntimeInspectNode {
  return {
    kind: "series",
    id: path.at(-1) ?? "series",
    path,
    children: items.map((item, index) => inspectRunItem(item, [...path, String(index)]))
  };
}

function inspectRunItem<Input>(item: RuntimeRunItem<Input>, path: string[]): RuntimeInspectNode {
  if (Array.isArray(item)) return inspectSeries(item, path);
  if (isRuntimeSeriesDefinition(item)) return inspectSeries(item.items, path);
  if (isRuntimeParallelDefinition(item)) {
    return {
      kind: "parallel",
      id: path.at(-1) ?? "parallel",
      path,
      children: item.items.map((branchItem, index) => inspectSeries(runItemsFromDefinition(branchItem), [...path, String(index)]))
    };
  }
  if (isRuntimeBranchDefinition(item)) {
    const children = [inspectSeries(item.whenTrue, [...path, "true"])];
    if (item.whenFalse) children.push(inspectSeries(item.whenFalse, [...path, "false"]));
    return { kind: "branch", id: path.at(-1) ?? "branch", path, children };
  }
  if (isCacheDirective(item)) return { kind: "cache", id: item.ref, path, children: [] };
  if (typeof item === "function") return { kind: "middleware", id: item.name || "middleware", path, children: [] };
  return { kind: "middleware", id: "middleware", path, children: [] };
}

function wrapRuntimeNodeError(node: { id: string; kind: RuntimeNodeKind; path: string[] }, cause: unknown): AsyncPipelineError {
  const code = runtimeNodeErrorCode(node.kind);
  return pipelineError(
    code,
    `Runtime ${node.kind} "${node.id}" failed at ${node.path.join(".")}.`,
    { path: node.path, kind: node.kind, cause: describeError(cause) }
  );
}

function runtimeNodeErrorCode(kind: RuntimeNodeKind): string {
  switch (kind) {
    case "task":
      return "ASYNC_PIPELINE_RUNTIME_TASK_FAILED";
    case "parallel":
      return "ASYNC_PIPELINE_RUNTIME_PARALLEL_NODE_FAILED";
    case "branch":
      return "ASYNC_PIPELINE_RUNTIME_BRANCH_FAILED";
    case "cache":
      return "ASYNC_PIPELINE_RUNTIME_CACHE_FAILED";
    case "middleware":
      return "ASYNC_PIPELINE_RUNTIME_MIDDLEWARE_FAILED";
    case "series":
      return "ASYNC_PIPELINE_RUNTIME_SERIES_FAILED";
  }
}

function describeError(error: unknown): { code?: string; message: string; details?: unknown } {
  if (error instanceof AsyncPipelineError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  if (error instanceof Error) {
    return { message: error.message };
  }
  return { message: String(error) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  return error instanceof AsyncPipelineError ? error.code : undefined;
}
