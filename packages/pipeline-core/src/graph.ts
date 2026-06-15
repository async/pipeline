import { createHash } from "node:crypto";
import { pipelineError } from "./errors.js";

export type DefinitionGraphNodeKind = "task" | "external-task";
export type GraphEffectKind = "shell" | "deferred-shell" | "agent" | "function" | "unknown";

export interface GraphTaskLike {
  id: string;
  dependsOn?: readonly string[];
  inputs?: readonly string[];
  outputs?: readonly string[];
  steps?: readonly unknown[];
  cache?: unknown;
  source?: { name?: string };
}

export interface GraphJobLike {
  id: string;
  target: readonly string[];
}

export interface GraphPipelineLike {
  name: string;
  tasks: Record<string, GraphTaskLike>;
  jobs: Record<string, GraphJobLike>;
  sources: Record<string, unknown>;
}

export interface GraphEffect {
  index: number;
  kind: GraphEffectKind;
  timing: "runtime";
}

export interface DefinitionGraphNode {
  id: string;
  kind: DefinitionGraphNodeKind;
  fingerprint: string;
  dependsOn: string[];
  dependents: string[];
  inputs: string[];
  outputs: string[];
  effects: GraphEffect[];
  cache?: unknown;
  source?: string;
}

export interface DefinitionGraph {
  pipelineName: string;
  nodes: Record<string, DefinitionGraphNode>;
  executionOrder: string[];
}

export interface ExecutionGraph {
  pipelineName: string;
  nodes: Record<string, DefinitionGraphNode>;
  executionOrder: string[];
}

export interface PipelineGraphProjection {
  tasks: Array<{
    id: string;
    dependsOn: string[];
    dependents: string[];
  }>;
  executionOrder: string[];
}

export interface ExecutionGraphSnapshot {
  schemaVersion: 1;
  pipelineName: string;
  jobId: string;
  executionOrder: string[];
  nodes: ExecutionGraphSnapshotNode[];
}

export interface ExecutionGraphSnapshotNode {
  id: string;
  kind: DefinitionGraphNodeKind;
  fingerprint: string;
  dependsOn: string[];
  dependents: string[];
  inputs: string[];
  outputs: string[];
  effects: GraphEffect[];
  source?: string;
}

export function compileDefinitionGraph(pipeline: GraphPipelineLike): DefinitionGraph {
  return createGraph(pipeline, Object.keys(pipeline.tasks));
}

export function selectExecutionGraph(pipeline: GraphPipelineLike, targets: readonly string[]): ExecutionGraph {
  return createGraph(pipeline, targets);
}

export function selectJobExecutionGraph(pipeline: GraphPipelineLike, jobId: string): ExecutionGraph {
  const selectedJob = pipeline.jobs[jobId];
  if (!selectedJob) throw new Error(`Unknown job "${jobId}".`);
  return selectExecutionGraph(pipeline, selectedJob.target);
}

export function projectPipelineGraph(graph: DefinitionGraph | ExecutionGraph): PipelineGraphProjection {
  return {
    tasks: Object.values(graph.nodes).map((node) => ({
      id: node.id,
      dependsOn: [...node.dependsOn].sort(),
      dependents: [...node.dependents].sort()
    })).sort((left, right) => left.id.localeCompare(right.id)),
    executionOrder: graph.executionOrder
  };
}

export function snapshotExecutionGraph(graph: ExecutionGraph, options: { jobId: string }): ExecutionGraphSnapshot {
  const nodes: ExecutionGraphSnapshotNode[] = [];
  for (const taskId of graph.executionOrder) {
    const node = graph.nodes[taskId];
    if (node) nodes.push(snapshotGraphNode(node));
  }
  return {
    schemaVersion: 1,
    pipelineName: graph.pipelineName,
    jobId: options.jobId,
    executionOrder: [...graph.executionOrder],
    nodes
  };
}

function snapshotGraphNode(node: DefinitionGraphNode): ExecutionGraphSnapshotNode {
  return {
    id: node.id,
    kind: node.kind,
    fingerprint: node.fingerprint,
    dependsOn: [...node.dependsOn],
    dependents: [...node.dependents],
    inputs: [...node.inputs],
    outputs: [...node.outputs],
    effects: node.effects.map((effect) => ({ ...effect })),
    ...(node.source === undefined ? {} : { source: node.source })
  };
}

function createGraph(pipeline: GraphPipelineLike, targets: readonly string[]): DefinitionGraph {
  const selected = collectRequiredNodes(pipeline, targets);
  const nodes = new Map<string, DefinitionGraphNode>();

  for (const id of selected) {
    const task = pipeline.tasks[id];
    if (!task && !isKnownExternalTaskRef(pipeline, id)) {
      throw new Error(`Cannot build graph for missing task "${id}".`);
    }
    nodes.set(id, createNode(pipeline, id, task, selected));
  }

  for (const node of nodes.values()) {
    for (const dependency of node.dependsOn) {
      nodes.get(dependency)?.dependents.push(node.id);
    }
  }

  return {
    pipelineName: pipeline.name,
    nodes: Object.fromEntries([...nodes.entries()].sort(([left], [right]) => left.localeCompare(right))),
    executionOrder: orderNodes(nodes)
  };
}

function createNode(
  pipeline: GraphPipelineLike,
  id: string,
  task: GraphTaskLike | undefined,
  selected: Set<string>
): DefinitionGraphNode {
  if (!task) {
    return withFingerprint({
      id,
      kind: "external-task",
      dependsOn: [],
      dependents: [],
      inputs: [],
      outputs: [],
      effects: [],
      source: parseTaskRef(id).source
    });
  }

  return withFingerprint({
    id,
    kind: "task",
    dependsOn: [...(task.dependsOn ?? [])].filter((dependency) => selected.has(dependency)),
    dependents: [],
    inputs: [...(task.inputs ?? [])],
    outputs: [...(task.outputs ?? [])],
    effects: classifyEffects(task.steps ?? []),
    cache: task.cache,
    source: task.source?.name ?? parseTaskRef(id).source
  });
}

function classifyEffects(steps: readonly unknown[]): GraphEffect[] {
  return steps.map((step, index) => ({
    index,
    kind: classifyEffect(step),
    timing: "runtime"
  }));
}

function classifyEffect(step: unknown): GraphEffectKind {
  if (typeof step === "function") return "function";
  if (!isObjectRecord(step)) return "unknown";
  const kind = step.kind;
  if (kind === "shell") return "shell";
  if (kind === "deferred-shell") return "deferred-shell";
  if (kind === "agent") return "agent";
  return "unknown";
}

function collectRequiredNodes(pipeline: GraphPipelineLike, targets: readonly string[]): Set<string> {
  const selected = new Set<string>();
  const visit = (id: string): void => {
    if (selected.has(id)) return;
    const task = pipeline.tasks[id];
    if (!task) {
      if (isKnownExternalTaskRef(pipeline, id)) {
        selected.add(id);
        return;
      }
      throw new Error(`Missing task "${id}".`);
    }
    selected.add(id);
    for (const dependency of task.dependsOn ?? []) {
      visit(dependency);
    }
  };

  for (const target of targets) {
    visit(target);
  }
  return selected;
}

function orderNodes(nodes: Map<string, DefinitionGraphNode>): string[] {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const order: string[] = [];

  const visit = (id: string, path: string[]): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      const start = path.indexOf(id);
      const cycle = [...path.slice(start), id].join(" -> ");
      throw pipelineError("ASYNC_PIPELINE_TASK_CYCLE", `Task dependency cycle detected: ${cycle}.`);
    }
    visiting.add(id);
    const node = nodes.get(id);
    if (!node) return;
    for (const dependency of [...node.dependsOn].sort()) {
      visit(dependency, [...path, id]);
    }
    visiting.delete(id);
    visited.add(id);
    order.push(id);
  };

  for (const id of [...nodes.keys()].sort()) {
    visit(id, []);
  }
  return order;
}

function isKnownExternalTaskRef(pipeline: GraphPipelineLike, taskRef: string): boolean {
  const parsed = parseTaskRef(taskRef);
  return parsed.source !== undefined
    && Boolean(pipeline.sources[parsed.source])
    && parsed.taskId.length > 0;
}

function parseTaskRef(taskRef: string): { source?: string; taskId: string } {
  const delimiterIndex = taskRef.indexOf(":");
  if (delimiterIndex < 0) return { taskId: taskRef };
  return {
    source: taskRef.slice(0, delimiterIndex),
    taskId: taskRef.slice(delimiterIndex + 1)
  };
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withFingerprint(node: Omit<DefinitionGraphNode, "fingerprint">): DefinitionGraphNode {
  return {
    ...node,
    fingerprint: fingerprintGraphNode(node)
  };
}

function fingerprintGraphNode(node: Omit<DefinitionGraphNode, "fingerprint">): string {
  const material = {
    id: node.id,
    kind: node.kind,
    dependsOn: node.dependsOn,
    inputs: node.inputs,
    outputs: node.outputs,
    effects: node.effects,
    cache: toStableJsonValue(node.cache),
    source: node.source
  };
  return createHash("sha256")
    .update(stableSerialize(material))
    .digest("hex");
}

function stableSerialize(value: unknown): string {
  return JSON.stringify(toStableJsonValue(value));
}

function toStableJsonValue(value: unknown): unknown {
  if (value === undefined) return "[undefined]";
  if (typeof value === "function") return "[function]";
  if (typeof value === "symbol") return value.toString();
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) return value.map((item) => toStableJsonValue(item));
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    result[key] = toStableJsonValue((value as Record<string, unknown>)[key]);
  }
  return result;
}
