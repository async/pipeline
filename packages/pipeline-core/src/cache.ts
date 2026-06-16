import { brandDeclaration, hasDeclarationKind } from "./declaration.js";
import { pipelineError } from "./errors.js";

export type CachePolicy = "local" | "session";
export type CacheRef = `${string}:${CachePolicy}` | string;
export type CacheBlob = Uint8Array | string | AsyncIterable<Uint8Array>;

export interface CacheStoreContext {
  rootDir: string;
  asyncDir: string;
  storeName: string;
  policy: CachePolicy;
  runId: string;
  taskId: string;
  signal?: AbortSignal;
}

export interface CacheStoreEntry {
  key: string;
  sizeBytes?: number;
  createdAt?: string;
  lastUsedAt?: string;
}

export interface CachePruneOptions {
  prefix?: string;
  maxAgeMs?: number;
  maxSizeBytes?: number;
}

export interface CachePruneResult {
  removed: number;
  bytesRemoved?: number;
}

export interface CacheStoreAdapter {
  readonly name?: string;
  get(key: string, context: CacheStoreContext): Promise<CacheBlob | null>;
  put(key: string, value: CacheBlob, context: CacheStoreContext): Promise<void>;
  touch?(key: string, context: CacheStoreContext): Promise<void>;
  delete?(key: string, context: CacheStoreContext): Promise<void>;
  list?(prefix: string, context: CacheStoreContext): AsyncIterable<CacheStoreEntry>;
  prune?(options: CachePruneOptions, context: CacheStoreContext): Promise<CachePruneResult>;
}

export type CacheStoreErrorCode =
  | "ASYNC_PIPELINE_CACHE_UNAVAILABLE"
  | "ASYNC_PIPELINE_CACHE_CORRUPT"
  | "ASYNC_PIPELINE_CACHE_UNSUPPORTED"
  | "ASYNC_PIPELINE_CACHE_PERMISSION";

export class CacheStoreError extends Error {
  code: CacheStoreErrorCode;
  retryable?: boolean;

  constructor(code: CacheStoreErrorCode, message: string, options: { retryable?: boolean; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = "CacheStoreError";
    this.code = code;
    this.retryable = options.retryable;
  }
}

export interface CacheStoreDefinition {
  kind: "cache-store";
  type: "memory" | "file" | "custom";
  root?: string;
  adapter?: CacheStoreAdapter;
  config?: Record<string, unknown>;
}

export interface CacheUseOptions {
  ttlMs?: number;
  key?: unknown;
}

export interface CacheDirective {
  kind: "async-pipeline.directive.cache";
  ref: CacheRef;
  options?: CacheUseOptions;
}

export interface CacheRegistryInput {
  default?: CacheRef;
  stores?: Record<string, CacheStoreDefinition>;
}

export interface CacheRegistryDefinition {
  kind: "cache-registry";
  default: CacheRef;
  stores: Record<string, CacheStoreDefinition>;
  use(ref?: CacheRef, options?: CacheUseOptions): CacheDirective;
}

export interface ParsedCacheRef {
  ref: CacheRef;
  store: string;
  policy: CachePolicy;
}

const knownPolicies = new Set<CachePolicy>(["local", "session"]);

export function memoryCache(): CacheStoreDefinition {
  return brandDeclaration({ kind: "cache-store", type: "memory" }, "cache.store.memory");
}

export function fileCache(options: { root?: string } = {}): CacheStoreDefinition {
  return brandDeclaration({ kind: "cache-store", type: "file", root: options.root }, "cache.store.file");
}

export function customCache(config: Record<string, unknown> & { adapter?: CacheStoreAdapter } = {}): CacheStoreDefinition {
  const { adapter, ...metadata } = config;
  if (adapter !== undefined && !isCacheStoreAdapter(adapter)) {
    throw pipelineError("ASYNC_PIPELINE_INVALID_CACHE_ADAPTER", "customCache({ adapter }) requires get(key, context) and put(key, value, context) functions.");
  }
  return brandDeclaration({
    kind: "cache-store",
    type: "custom",
    config: metadata,
    ...(adapter ? { adapter } : {})
  }, "cache.store.custom");
}

export function redisCache(config: Record<string, unknown> = {}): CacheStoreDefinition {
  return brandDeclaration({ kind: "cache-store", type: "custom", config: { ...config, adapter: "redis" } }, "cache.store.redis");
}

export function defineCache(input: CacheRegistryInput | Record<string, CacheStoreDefinition> = {}): CacheRegistryDefinition {
  const hasStoresEnvelope = "stores" in input || "default" in input;
  const stores = hasStoresEnvelope
    ? { ...((input as CacheRegistryInput).stores ?? {}) }
    : { ...(input as Record<string, CacheStoreDefinition>) };
  const defaultRef = hasStoresEnvelope ? ((input as CacheRegistryInput).default ?? "memory:session") : "memory:session";

  return makeCacheRegistry(defaultRef, stores);
}

export function defaultPipelineCache(): CacheRegistryDefinition {
  return makeCacheRegistry("file:local", {
    memory: memoryCache(),
    file: fileCache({ root: ".async/cache/tasks" })
  });
}

export function defaultRuntimeCache(): CacheRegistryDefinition {
  return makeCacheRegistry("memory:session", {
    memory: memoryCache(),
    file: fileCache({ root: ".async/cache/runtime" })
  });
}

export const cache = defaultPipelineCache();

export function parseCacheRef(ref: CacheRef): ParsedCacheRef {
  const parts = String(ref).split(":");
  const store = parts[0] ?? "";
  const policyToken = parts[1] ?? defaultCachePolicyForStore(store);
  const extra = parts[2];
  if (!store || extra !== undefined) {
    throw pipelineError("ASYNC_PIPELINE_INVALID_CACHE_REF", `Invalid cache reference "${ref}". Use "store:policy".`, { ref });
  }
  if (knownPolicies.has(policyToken as CachePolicy)) {
    return { ref, store, policy: policyToken as CachePolicy };
  }
  throw pipelineError("ASYNC_PIPELINE_UNKNOWN_CACHE_POLICY", `Unknown cache policy "${policyToken}" in "${ref}".`, { ref, policy: policyToken });
}

export function isCacheDirective(value: unknown): value is CacheDirective {
  return Boolean(value)
    && typeof value === "object"
    && ((value as { kind?: unknown }).kind === "async-pipeline.directive.cache" || hasDeclarationKind(value, "directive.cache"));
}

export function assertCacheStore(registry: CacheRegistryDefinition, ref: ParsedCacheRef): void {
  if (!registry.stores[ref.store]) {
    throw pipelineError("ASYNC_PIPELINE_UNKNOWN_CACHE_STORE", `Unknown cache store "${ref.store}" in "${ref.ref}".`, {
      ref: ref.ref,
      store: ref.store,
      availableStores: Object.keys(registry.stores).sort()
    });
  }
}

export function mergeWithDefaultCacheStores(registry: CacheRegistryDefinition): CacheRegistryDefinition {
  return makeCacheRegistry(registry.default, {
    memory: memoryCache(),
    file: fileCache({ root: ".async/cache/tasks" }),
    ...registry.stores
  });
}

function makeCacheRegistry(defaultRef: CacheRef, stores: Record<string, CacheStoreDefinition>): CacheRegistryDefinition {
  for (const [name, store] of Object.entries(stores)) {
    if (store.adapter !== undefined && !isCacheStoreAdapter(store.adapter)) {
      throw pipelineError("ASYNC_PIPELINE_INVALID_CACHE_ADAPTER", `Cache store "${name}" adapter requires get(key, context) and put(key, value, context) functions; optional lifecycle methods must also be functions.`);
    }
  }
  return brandDeclaration({
    kind: "cache-registry",
    default: defaultRef,
    stores,
    use(ref: CacheRef = defaultRef, options?: CacheUseOptions): CacheDirective {
      return brandDeclaration({
        kind: "async-pipeline.directive.cache",
        ref,
        options
      }, "directive.cache");
    }
  }, "cache.registry");
}

export function defaultCachePolicyForStore(store: string): CachePolicy {
  return store === "memory" ? "session" : "local";
}

function isCacheStoreAdapter(value: unknown): value is CacheStoreAdapter {
  if (!value || typeof value !== "object") return false;
  const adapter = value as Record<string, unknown>;
  return typeof adapter.get === "function"
    && typeof adapter.put === "function"
    && optionalCacheStoreMethodIsValid(adapter.touch)
    && optionalCacheStoreMethodIsValid(adapter.delete)
    && optionalCacheStoreMethodIsValid(adapter.list)
    && optionalCacheStoreMethodIsValid(adapter.prune);
}

function optionalCacheStoreMethodIsValid(value: unknown): boolean {
  return value === undefined || typeof value === "function";
}
