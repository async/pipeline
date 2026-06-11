import { pipelineError } from "./errors.js";

export type CachePolicy = "local" | "session";
export type CacheRef = `${string}:${CachePolicy}` | string;

export interface CacheStoreDefinition {
  kind: "cache-store";
  type: "memory" | "file" | "custom";
  root?: string;
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
  return { kind: "cache-store", type: "memory" };
}

export function fileCache(options: { root?: string } = {}): CacheStoreDefinition {
  return { kind: "cache-store", type: "file", root: options.root };
}

export function customCache(config: Record<string, unknown> = {}): CacheStoreDefinition {
  return { kind: "cache-store", type: "custom", config };
}

export function redisCache(config: Record<string, unknown> = {}): CacheStoreDefinition {
  return { kind: "cache-store", type: "custom", config: { ...config, adapter: "redis" } };
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
    && (value as { kind?: unknown }).kind === "async-pipeline.directive.cache";
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
  return {
    kind: "cache-registry",
    default: defaultRef,
    stores,
    use(ref: CacheRef = defaultRef, options?: CacheUseOptions): CacheDirective {
      return {
        kind: "async-pipeline.directive.cache",
        ref,
        options
      };
    }
  };
}

export function defaultCachePolicyForStore(store: string): CachePolicy {
  return store === "memory" ? "session" : "local";
}
