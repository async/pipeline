import { createConnection, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { CacheBlob, CachePruneOptions, CachePruneResult, CacheStoreAdapter, CacheStoreEntry, EnvVarRef } from "@async/pipeline-core";

interface RedisTarget {
  tls: boolean;
  host: string;
  port: number;
  username?: string;
  password?: string;
  database?: number;
}

type RedisBuffer = Buffer<ArrayBufferLike>;
type RedisReply = string | number | RedisBuffer | null | RedisReply[];

interface RedisCacheMetadata {
  version: 1;
  key: string;
  sizeBytes: number;
  createdAt: string;
  lastUsedAt: string;
}

export function createRedisCacheStoreAdapter(config: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = process.env): CacheStoreAdapter {
  const target = parseRedisUrl(resolveRedisUrl(config.url, env));
  const keyPrefix = stringOption(config, "keyPrefix", "async:pipeline:cache:");
  const connectTimeoutMs = numberOption(config, "connectTimeoutMs", 5_000);
  const commandTimeoutMs = numberOption(config, "commandTimeoutMs", 5_000);

  return {
    name: "redis",
    async get(key) {
      const client = await RedisClient.open(target, { connectTimeoutMs, commandTimeoutMs });
      try {
        const reply = await client.command(["GET", redisDataKey(keyPrefix, key)]);
        if (reply === null) return null;
        if (!Buffer.isBuffer(reply)) throw new Error("Redis GET returned an unexpected reply.");
        return reply;
      } finally {
        client.close();
      }
    },
    async put(key, value) {
      const client = await RedisClient.open(target, { connectTimeoutMs, commandTimeoutMs });
      try {
        const bytes = await cacheBlobToUint8Array(value);
        const now = new Date().toISOString();
        const dataReply = await client.command(["SET", redisDataKey(keyPrefix, key), bytes]);
        if (dataReply !== "OK") throw new Error("Redis SET returned an unexpected reply.");
        await writeRedisMetadata(client, keyPrefix, {
          version: 1,
          key,
          sizeBytes: bytes.byteLength,
          createdAt: now,
          lastUsedAt: now
        });
      } finally {
        client.close();
      }
    },
    async touch(key) {
      const client = await RedisClient.open(target, { connectTimeoutMs, commandTimeoutMs });
      try {
        const metadata = await readRedisMetadata(client, keyPrefix, key);
        if (metadata) {
          await writeRedisMetadata(client, keyPrefix, { ...metadata, lastUsedAt: new Date().toISOString() });
          return;
        }
        const blob = await client.command(["GET", redisDataKey(keyPrefix, key)]);
        if (blob === null) return;
        if (!Buffer.isBuffer(blob)) throw new Error("Redis GET returned an unexpected reply.");
        const now = new Date().toISOString();
        await writeRedisMetadata(client, keyPrefix, {
          version: 1,
          key,
          sizeBytes: blob.byteLength,
          createdAt: now,
          lastUsedAt: now
        });
      } finally {
        client.close();
      }
    },
    async delete(key) {
      const client = await RedisClient.open(target, { connectTimeoutMs, commandTimeoutMs });
      try {
        await client.command(["DEL", redisDataKey(keyPrefix, key), redisMetadataKey(keyPrefix, key)]);
      } finally {
        client.close();
      }
    },
    async *list(prefix) {
      const client = await RedisClient.open(target, { connectTimeoutMs, commandTimeoutMs });
      try {
        yield* listRedisEntries(client, keyPrefix, prefix);
      } finally {
        client.close();
      }
    },
    async prune(options) {
      const client = await RedisClient.open(target, { connectTimeoutMs, commandTimeoutMs });
      try {
        return await pruneRedisEntries(client, keyPrefix, options);
      } finally {
        client.close();
      }
    }
  };
}

class RedisClient {
  private buffer: RedisBuffer = Buffer.alloc(0);

  private constructor(private readonly socket: Socket, private readonly commandTimeoutMs: number) {}

  static async open(target: RedisTarget, options: { connectTimeoutMs: number; commandTimeoutMs: number }): Promise<RedisClient> {
    const socket = await connectRedisSocket(target, options.connectTimeoutMs);
    const client = new RedisClient(socket, options.commandTimeoutMs);
    try {
      if (target.password) {
        const auth = target.username ? ["AUTH", target.username, target.password] : ["AUTH", target.password];
        const reply = await client.command(auth);
        if (reply !== "OK") throw new Error("Redis AUTH returned an unexpected reply.");
      }
      if (target.database !== undefined && target.database !== 0) {
        const reply = await client.command(["SELECT", String(target.database)]);
        if (reply !== "OK") throw new Error("Redis SELECT returned an unexpected reply.");
      }
    } catch (error) {
      client.close();
      throw error;
    }
    return client;
  }

  command(parts: Array<string | Uint8Array>): Promise<RedisReply> {
    const payload = encodeRedisCommand(parts);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Redis command timed out."));
      }, this.commandTimeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.socket.off("data", onData);
        this.socket.off("error", onError);
        this.socket.off("close", onClose);
      };
      const finish = (reply: RedisReply) => {
        cleanup();
        resolve(reply);
      };
      const fail = (error: Error) => {
        cleanup();
        reject(error);
      };
      const tryParse = () => {
        try {
          const parsed = parseRedisReply(this.buffer);
          if (!parsed) return;
          this.buffer = parsed.rest;
          finish(parsed.reply);
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      };
      const onData = (chunk: Buffer) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        tryParse();
      };
      const onError = (error: Error) => fail(error);
      const onClose = () => fail(new Error("Redis connection closed before a reply was received."));

      this.socket.on("data", onData);
      this.socket.once("error", onError);
      this.socket.once("close", onClose);
      this.socket.write(payload, (error) => {
        if (error) fail(error);
      });
    });
  }

  close(): void {
    this.socket.end();
  }
}

function connectRedisSocket(target: RedisTarget, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const onConnect = () => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.setNoDelay(true);
      resolve(socket);
    };
    const socket = target.tls
      ? tlsConnect({ host: target.host, port: target.port, servername: target.host }, onConnect)
      : createConnection({ host: target.host, port: target.port }, onConnect);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(new Error("Redis connection timed out."));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("error", onError);
    };
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    socket.once("error", onError);
  });
}

function parseRedisUrl(urlText: string): RedisTarget {
  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    throw new Error("Redis cache store received an invalid URL.");
  }
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
    throw new Error("Redis cache store URL must use redis:// or rediss://.");
  }
  const port = url.port ? Number(url.port) : 6379;
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("Redis cache store URL has an invalid port.");
  }
  const databaseText = url.pathname.replace(/^\//, "");
  const database = databaseText ? Number(databaseText) : undefined;
  if (database !== undefined && (!Number.isInteger(database) || database < 0)) {
    throw new Error("Redis cache store URL has an invalid database index.");
  }
  if (url.username && !url.password) {
    throw new Error("Redis cache store URL username requires a password.");
  }
  return {
    tls: url.protocol === "rediss:",
    host: url.hostname || "localhost",
    port,
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    ...(database === undefined ? {} : { database })
  };
}

function resolveRedisUrl(source: unknown, env: NodeJS.ProcessEnv): string {
  if (source === undefined) {
    const value = env.REDIS_URL;
    if (value) return value;
    throw new Error("Redis cache store requires `url` or REDIS_URL.");
  }
  if (typeof source === "string" && source.length > 0) return source;
  if (isEnvVarRef(source)) {
    const value = resolveEnvVar(source, env);
    if (value) return value;
    throw new Error(`Redis cache store requires variable "${source.name}".`);
  }
  if (isRecord(source) && typeof source.env === "string") {
    const value = env[source.env] ?? (typeof source.default === "string" ? source.default : undefined);
    if (value) return value;
    throw new Error(`Redis cache store requires variable "${source.env}".`);
  }
  throw new Error("Redis cache store `url` must be a string, env.var(...), or { env: string }.");
}

function resolveEnvVar(ref: EnvVarRef, env: NodeJS.ProcessEnv): string | undefined {
  const selector = env[ref.name] ?? ref.default;
  if (selector === undefined || selector === "") return undefined;
  return ref.values ? ref.values[selector] : selector;
}

function stringOption(config: Record<string, unknown>, key: string, fallback: string): string {
  const value = config[key];
  if (value === undefined) return fallback;
  if (typeof value !== "string") throw new Error(`Redis cache store option "${key}" must be a string.`);
  return value;
}

function numberOption(config: Record<string, unknown>, key: string, fallback: number): number {
  const value = config[key];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Redis cache store option "${key}" must be a positive number.`);
  }
  return value;
}

function redisDataKey(keyPrefix: string, key: string): string {
  return `${keyPrefix}${key}`;
}

function redisMetadataPrefix(keyPrefix: string): string {
  return `${keyPrefix}__async_pipeline_meta__:`;
}

function redisMetadataKey(keyPrefix: string, key: string): string {
  return `${redisMetadataPrefix(keyPrefix)}${Buffer.from(key, "utf8").toString("base64url")}`;
}

async function writeRedisMetadata(client: RedisClient, keyPrefix: string, metadata: RedisCacheMetadata): Promise<void> {
  const reply = await client.command(["SET", redisMetadataKey(keyPrefix, metadata.key), JSON.stringify(metadata)]);
  if (reply !== "OK") throw new Error("Redis SET metadata returned an unexpected reply.");
}

async function readRedisMetadata(client: RedisClient, keyPrefix: string, key: string): Promise<RedisCacheMetadata | null> {
  const reply = await client.command(["GET", redisMetadataKey(keyPrefix, key)]);
  if (reply === null) return null;
  if (!Buffer.isBuffer(reply)) throw new Error("Redis GET metadata returned an unexpected reply.");
  try {
    return validateRedisMetadata(JSON.parse(reply.toString("utf8")));
  } catch {
    return null;
  }
}

function validateRedisMetadata(value: unknown): RedisCacheMetadata | null {
  if (!isRecord(value)) return null;
  if (value.version !== 1) return null;
  if (typeof value.key !== "string") return null;
  if (typeof value.sizeBytes !== "number" || !Number.isFinite(value.sizeBytes) || value.sizeBytes < 0) return null;
  if (typeof value.createdAt !== "string" || typeof value.lastUsedAt !== "string") return null;
  return {
    version: 1,
    key: value.key,
    sizeBytes: value.sizeBytes,
    createdAt: value.createdAt,
    lastUsedAt: value.lastUsedAt
  };
}

async function* listRedisEntries(client: RedisClient, keyPrefix: string, prefix: string): AsyncIterable<CacheStoreEntry> {
  const metadataPrefix = redisMetadataPrefix(keyPrefix);
  let cursor = "0";
  do {
    const reply = await client.command(["SCAN", cursor, "MATCH", `${escapeRedisGlob(keyPrefix)}${escapeRedisGlob(prefix)}*`, "COUNT", "100"]);
    const scan = parseRedisScanReply(reply);
    cursor = scan.cursor;
    for (const key of scan.keys.sort((left, right) => left.localeCompare(right))) {
      if (key.startsWith(metadataPrefix)) continue;
      if (!key.startsWith(keyPrefix)) continue;
      const logicalKey = key.slice(keyPrefix.length);
      const metadata = await readRedisMetadata(client, keyPrefix, logicalKey);
      if (metadata) {
        yield {
          key: metadata.key,
          sizeBytes: metadata.sizeBytes,
          createdAt: metadata.createdAt,
          lastUsedAt: metadata.lastUsedAt
        };
        continue;
      }
      const sizeReply = await client.command(["STRLEN", key]);
      if (typeof sizeReply !== "number") throw new Error("Redis STRLEN returned an unexpected reply.");
      yield { key: logicalKey, sizeBytes: sizeReply };
    }
  } while (cursor !== "0");
}

async function pruneRedisEntries(client: RedisClient, keyPrefix: string, options: CachePruneOptions): Promise<CachePruneResult> {
  const entries: CacheStoreEntry[] = [];
  for await (const entry of listRedisEntries(client, keyPrefix, options.prefix ?? "")) {
    entries.push(entry);
  }
  const keys = selectPrunedRedisKeys(entries, options);
  let bytesRemoved = 0;
  for (const key of keys) {
    const entry = entries.find((candidate) => candidate.key === key);
    bytesRemoved += entry?.sizeBytes ?? 0;
    await client.command(["DEL", redisDataKey(keyPrefix, key), redisMetadataKey(keyPrefix, key)]);
  }
  return { removed: keys.length, bytesRemoved };
}

function selectPrunedRedisKeys(entries: CacheStoreEntry[], options: CachePruneOptions): string[] {
  const removed = new Set<string>();
  if (options.maxAgeMs !== undefined && Number.isFinite(options.maxAgeMs) && options.maxAgeMs >= 0) {
    const cutoff = Date.now() - options.maxAgeMs;
    for (const entry of entries) {
      if (cacheEntryLastUsedMs(entry) <= cutoff) removed.add(entry.key);
    }
  }

  if (options.maxSizeBytes !== undefined && Number.isFinite(options.maxSizeBytes) && options.maxSizeBytes >= 0) {
    const retained = entries
      .filter((entry) => !removed.has(entry.key))
      .sort((left, right) => cacheEntryLastUsedMs(left) - cacheEntryLastUsedMs(right) || left.key.localeCompare(right.key));
    let totalBytes = retained.reduce((sum, entry) => sum + (entry.sizeBytes ?? 0), 0);
    for (const entry of retained) {
      if (totalBytes <= options.maxSizeBytes) break;
      removed.add(entry.key);
      totalBytes -= entry.sizeBytes ?? 0;
    }
  }

  return [...removed].sort((left, right) => left.localeCompare(right));
}

function cacheEntryLastUsedMs(entry: CacheStoreEntry): number {
  const parsed = entry.lastUsedAt ? Date.parse(entry.lastUsedAt) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseRedisScanReply(reply: RedisReply): { cursor: string; keys: string[] } {
  if (!Array.isArray(reply) || reply.length !== 2) throw new Error("Redis SCAN returned an unexpected reply.");
  const [cursorReply, keysReply] = reply as [RedisReply, RedisReply];
  const cursor = redisReplyToString(cursorReply);
  if (!Array.isArray(keysReply)) throw new Error("Redis SCAN keys returned an unexpected reply.");
  return { cursor, keys: keysReply.map(redisReplyToString) };
}

function redisReplyToString(reply: RedisReply): string {
  if (typeof reply === "string") return reply;
  if (Buffer.isBuffer(reply)) return reply.toString("utf8");
  throw new Error("Redis returned an unexpected string reply.");
}

function escapeRedisGlob(value: string): string {
  return value.replaceAll(/[\\*?\[\]]/g, (match) => `\\${match}`);
}

async function cacheBlobToUint8Array(blob: CacheBlob): Promise<Uint8Array> {
  if (typeof blob === "string") return new TextEncoder().encode(blob);
  if (blob instanceof Uint8Array) return blob;
  const chunks: Uint8Array[] = [];
  for await (const chunk of blob) {
    chunks.push(chunk);
  }
  const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function encodeRedisCommand(parts: Array<string | Uint8Array>): Buffer {
  const chunks = [Buffer.from(`*${parts.length}\r\n`, "utf8")];
  for (const part of parts) {
    const bytes = typeof part === "string" ? Buffer.from(part, "utf8") : Buffer.from(part);
    chunks.push(Buffer.from(`$${bytes.byteLength}\r\n`, "utf8"), bytes, Buffer.from("\r\n", "utf8"));
  }
  return Buffer.concat(chunks);
}

function parseRedisReply(buffer: RedisBuffer): { reply: RedisReply; rest: RedisBuffer } | null {
  if (buffer.length === 0) return null;
  const prefix = buffer[0];
  if (prefix === undefined) return null;
  const type = String.fromCharCode(prefix);
  if (type === "+") {
    const line = readRedisLine(buffer, 1);
    if (!line) return null;
    return { reply: line.text, rest: buffer.subarray(line.next) };
  }
  if (type === "-") {
    const line = readRedisLine(buffer, 1);
    if (!line) return null;
    throw new Error(`Redis error: ${line.text}`);
  }
  if (type === ":") {
    const line = readRedisLine(buffer, 1);
    if (!line) return null;
    return { reply: Number(line.text), rest: buffer.subarray(line.next) };
  }
  if (type === "$") {
    const line = readRedisLine(buffer, 1);
    if (!line) return null;
    const length = Number(line.text);
    if (length === -1) return { reply: null, rest: buffer.subarray(line.next) };
    if (!Number.isInteger(length) || length < 0) throw new Error("Redis returned an invalid bulk string length.");
    const start = line.next;
    const end = start + length;
    if (buffer.length < end + 2) return null;
    if (buffer[end] !== 13 || buffer[end + 1] !== 10) throw new Error("Redis returned a malformed bulk string.");
    return { reply: Buffer.from(buffer.subarray(start, end)), rest: buffer.subarray(end + 2) };
  }
  if (type === "*") {
    const line = readRedisLine(buffer, 1);
    if (!line) return null;
    const length = Number(line.text);
    if (length === -1) return { reply: null, rest: buffer.subarray(line.next) };
    if (!Number.isInteger(length) || length < 0) throw new Error("Redis returned an invalid array length.");
    const replies: RedisReply[] = [];
    let rest = buffer.subarray(line.next);
    for (let index = 0; index < length; index += 1) {
      const parsed = parseRedisReply(rest);
      if (!parsed) return null;
      replies.push(parsed.reply);
      rest = parsed.rest;
    }
    return { reply: replies, rest };
  }
  throw new Error(`Redis returned unsupported reply type "${type}".`);
}

function readRedisLine(buffer: RedisBuffer, offset: number): { text: string; next: number } | null {
  const end = buffer.indexOf("\r\n", offset);
  if (end === -1) return null;
  return { text: buffer.toString("utf8", offset, end), next: end + 2 };
}

function isEnvVarRef(value: unknown): value is EnvVarRef {
  return isRecord(value) && value.kind === "async-pipeline.env.var" && typeof value.name === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
