import { EventEmitter } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { extractSecretKey, makeSecretRef, type SecretStore } from "./secrets.js";

export const SERVER_ID_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const keyValueEntrySchema = z.object({
  key: z.string().min(1),
  value: z.string(),
  isSecret: z.boolean().optional(),
});

export const authConfigSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("none"),
  }),
  z.object({
    type: z.literal("bearer"),
    token: z.string().min(1),
  }),
  z.object({
    type: z.literal("api_key"),
    key: z.string().min(1),
    in: z.enum(["header", "query"]).default("header"),
    headerName: z.string().min(1).default("X-API-Key"),
    prefix: z.string().optional(),
    queryParam: z.string().min(1).default("api_key"),
  }),
  z.object({
    type: z.literal("oauth"),
    clientId: z.string().min(1).optional(),
    clientSecret: z.string().min(1).optional(),
    scopes: z.array(z.string().min(1)).optional(),
  }),
]);

const baseServerSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  presetId: z.string().min(1).optional(),
  enabled: z.boolean().default(true),
  concurrency: z.number().int().min(1).max(64).optional(),
  timeoutMs: z.number().int().min(1000).max(600_000).default(60_000),
});

export const stdioServerSchema = baseServerSchema.extend({
  transport: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).default({}),
});

export const remoteServerSchema = baseServerSchema.extend({
  transport: z.enum(["http", "sse"]),
  url: z.string().url(),
  auth: authConfigSchema.default({ type: "none" }),
  headers: z.record(z.string(), z.string()).default({}),
});

export const serverConfigSchema = z.discriminatedUnion("transport", [
  stdioServerSchema,
  remoteServerSchema,
]);

export const registryFileSchema = z.object({
  servers: z.record(z.string(), serverConfigSchema).default({}),
});

export type AuthConfig = z.infer<typeof authConfigSchema>;
export type StdioServerConfig = z.infer<typeof stdioServerSchema>;
export type RemoteServerConfig = z.infer<typeof remoteServerSchema>;
export type ServerConfig = z.infer<typeof serverConfigSchema>;
export type RegistryFile = z.infer<typeof registryFileSchema>;

/**
 * UI-friendly structured payload (fillable blocks, never raw YAML, secrets masked).
 */
export interface KeyValueFieldView {
  key: string;
  value: string;
  isSecret: boolean;
  hasSecret?: boolean;
}

export interface AuthView {
  type: "none" | "bearer" | "api_key" | "oauth";
  hasSecret?: boolean;
  in?: "header" | "query";
  headerName?: string;
  prefix?: string;
  queryParam?: string;
  clientId?: string;
  hasClientSecret?: boolean;
  scopes?: string[];
}

export interface ServerConfigView {
  id: string;
  name: string;
  presetId?: string;
  transport: "stdio" | "http" | "sse";
  enabled: boolean;
  concurrency?: number;
  timeoutMs: number;
  // stdio fields
  command?: string;
  args?: string[];
  cwd?: string;
  env?: KeyValueFieldView[];
  // remote fields
  url?: string;
  auth?: AuthView;
  headers?: KeyValueFieldView[];
}

export const upsertServerInputSchema = z.object({
  id: z.string().regex(SERVER_ID_REGEX, "Server ID must be lowercase alphanumeric, hyphens, or underscores"),
  name: z.string().min(1).max(120).optional(),
  presetId: z.string().min(1).optional(),
  transport: z.enum(["stdio", "http", "sse"]),
  enabled: z.boolean().default(true),
  concurrency: z.number().int().min(1).max(64).nullable().optional(),
  timeoutMs: z.number().int().min(1000).max(600_000).default(60_000),
  // stdio
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  env: z.array(keyValueEntrySchema).optional(),
  // remote
  url: z.string().url().optional(),
  auth: z
    .object({
      type: z.enum(["none", "bearer", "api_key", "oauth"]),
      token: z.string().optional(),
      key: z.string().optional(),
      in: z.enum(["header", "query"]).optional(),
      headerName: z.string().optional(),
      prefix: z.string().optional(),
      queryParam: z.string().optional(),
      clientId: z.string().optional(),
      clientSecret: z.string().optional(),
      scopes: z.array(z.string()).optional(),
    })
    .optional(),
  headers: z.array(keyValueEntrySchema).optional(),
});

export type UpsertServerInput = z.infer<typeof upsertServerInputSchema>;

function secretKeyFor(serverId: string, field: string): string {
  return `mcp.${serverId}.${field}`;
}

export class McpRegistry extends EventEmitter {
  private readonly filePath: string;
  private readonly secrets: SecretStore;
  private servers: Map<string, ServerConfig> = new Map();
  private watcher: fs.FSWatcher | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;
  private suppressWatchUntil = 0;

  constructor(filePath: string, secrets: SecretStore) {
    super();
    this.filePath = filePath;
    this.secrets = secrets;
  }

  async load(): Promise<Map<string, ServerConfig>> {
    try {
      const raw = await fsp.readFile(this.filePath, "utf8");
      const parsedYaml = YAML.parse(raw) ?? {};
      const validated = registryFileSchema.parse(parsedYaml);
      const next = new Map<string, ServerConfig>();
      for (const [id, cfg] of Object.entries(validated.servers)) {
        if (!SERVER_ID_REGEX.test(id)) {
          throw new Error(`Invalid MCP server id "${id}" in ${this.filePath}`);
        }
        next.set(id, cfg);
      }
      this.servers = next;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.servers = new Map();
      } else {
        throw err;
      }
    }
    return new Map(this.servers);
  }

  getAll(): Map<string, ServerConfig> {
    return new Map(this.servers);
  }

  get(id: string): ServerConfig | undefined {
    return this.servers.get(id);
  }

  async save(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fsp.mkdir(dir, { recursive: true });
    const obj: RegistryFile = {
      servers: Object.fromEntries(this.servers.entries()),
    };
    const yamlText =
      "# MetaRelay MCP Server Registry\n" +
      "# Managed via the MetaRelay Web Console (safe to edit manually).\n\n" +
      YAML.stringify(obj, { lineWidth: 100 });
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    this.suppressWatchUntil = Date.now() + 500;
    await fsp.writeFile(tmp, yamlText, "utf8");
    await fsp.rename(tmp, this.filePath);
  }

  /**
   * Upserts a server from structured UI form blocks, storing any secrets in the 0600 SecretStore
   * and writing clean ${secret:...} references into servers.yaml.
   */
  async upsertFromForm(input: UpsertServerInput): Promise<ServerConfig> {
    const parsed = upsertServerInputSchema.parse(input);
    const existing = this.servers.get(parsed.id);
    const concurrency = parsed.concurrency ?? undefined;

    let config: ServerConfig;

    if (parsed.transport === "stdio") {
      if (!parsed.command) {
        throw new Error("command is required for stdio transport");
      }
      const envRecord: Record<string, string> = {};
      const existingEnv = existing?.transport === "stdio" ? existing.env : {};

      for (const row of parsed.env ?? []) {
        const key = row.key.trim();
        if (!key) continue;
        if (row.isSecret) {
          const secKey = secretKeyFor(parsed.id, `env.${key}`);
          if (row.value.length > 0) {
            await this.secrets.set(secKey, row.value);
            envRecord[key] = makeSecretRef(secKey);
          } else if (existingEnv[key]) {
            envRecord[key] = existingEnv[key];
          }
        } else {
          envRecord[key] = row.value;
        }
      }

      config = stdioServerSchema.parse({
        transport: "stdio",
        name: parsed.name,
        presetId: parsed.presetId,
        enabled: parsed.enabled,
        concurrency,
        timeoutMs: parsed.timeoutMs,
        command: parsed.command,
        args: parsed.args ?? [],
        cwd: parsed.cwd?.trim() || undefined,
        env: envRecord,
      });
    } else {
      if (!parsed.url) {
        throw new Error(`url is required for ${parsed.transport} transport`);
      }

      const headersRecord: Record<string, string> = {};
      const existingHeaders = existing && existing.transport !== "stdio" ? existing.headers : {};

      for (const row of parsed.headers ?? []) {
        const key = row.key.trim();
        if (!key) continue;
        if (row.isSecret) {
          const secKey = secretKeyFor(parsed.id, `header.${key.toLowerCase()}`);
          if (row.value.length > 0) {
            await this.secrets.set(secKey, row.value);
            headersRecord[key] = makeSecretRef(secKey);
          } else if (existingHeaders[key]) {
            headersRecord[key] = existingHeaders[key];
          }
        } else {
          headersRecord[key] = row.value;
        }
      }

      const existingAuth = existing && existing.transport !== "stdio" ? existing.auth : undefined;
      const authInput = parsed.auth ?? { type: "none" as const };
      let auth: AuthConfig;

      if (authInput.type === "none") {
        auth = { type: "none" };
      } else if (authInput.type === "bearer") {
        const secKey = secretKeyFor(parsed.id, "auth.bearer");
        if (authInput.token && authInput.token.length > 0) {
          await this.secrets.set(secKey, authInput.token);
          auth = { type: "bearer", token: makeSecretRef(secKey) };
        } else if (existingAuth?.type === "bearer") {
          auth = existingAuth;
        } else {
          throw new Error("Bearer token is required");
        }
      } else if (authInput.type === "api_key") {
        const secKey = secretKeyFor(parsed.id, "auth.api_key");
        let keyRef: string;
        if (authInput.key && authInput.key.length > 0) {
          await this.secrets.set(secKey, authInput.key);
          keyRef = makeSecretRef(secKey);
        } else if (existingAuth?.type === "api_key") {
          keyRef = existingAuth.key;
        } else {
          throw new Error("API key is required");
        }
        auth = {
          type: "api_key",
          key: keyRef,
          in: authInput.in ?? "header",
          headerName: authInput.headerName?.trim() || "X-API-Key",
          prefix: authInput.prefix?.trim() || undefined,
          queryParam: authInput.queryParam?.trim() || "api_key",
        };
      } else {
        let clientSecretRef: string | undefined;
        const secKey = secretKeyFor(parsed.id, "auth.oauth_client_secret");
        if (authInput.clientSecret && authInput.clientSecret.length > 0) {
          await this.secrets.set(secKey, authInput.clientSecret);
          clientSecretRef = makeSecretRef(secKey);
        } else if (existingAuth?.type === "oauth" && existingAuth.clientSecret) {
          clientSecretRef = existingAuth.clientSecret;
        }
        auth = {
          type: "oauth",
          clientId: authInput.clientId?.trim() || undefined,
          clientSecret: clientSecretRef,
          scopes: authInput.scopes?.filter((s) => s.trim().length > 0),
        };
      }

      config = remoteServerSchema.parse({
        transport: parsed.transport,
        name: parsed.name,
        presetId: parsed.presetId,
        enabled: parsed.enabled,
        concurrency,
        timeoutMs: parsed.timeoutMs,
        url: parsed.url,
        auth,
        headers: headersRecord,
      });
    }

    this.servers.set(parsed.id, config);
    await this.save();
    this.emit("changed", this.getAll());
    return config;
  }

  async delete(id: string): Promise<boolean> {
    const existed = this.servers.delete(id);
    if (!existed) return false;
    await this.secrets.deleteByPrefix(`mcp.${id}.`);
    await this.save();
    this.emit("changed", this.getAll());
    return true;
  }

  /**
   * Produces a UI-safe view of a server config where stored secrets are never leaked.
   */
  async toView(id: string, cfg: ServerConfig): Promise<ServerConfigView> {
    const base = {
      id,
      name: cfg.name ?? id,
      presetId: cfg.presetId,
      transport: cfg.transport,
      enabled: cfg.enabled,
      concurrency: cfg.concurrency,
      timeoutMs: cfg.timeoutMs,
    };

    if (cfg.transport === "stdio") {
      const env: KeyValueFieldView[] = [];
      for (const [key, rawVal] of Object.entries(cfg.env)) {
        const secKey = extractSecretKey(rawVal);
        if (secKey) {
          env.push({
            key,
            value: "",
            isSecret: true,
            hasSecret: await this.secrets.has(secKey),
          });
        } else {
          env.push({ key, value: rawVal, isSecret: false });
        }
      }
      return {
        ...base,
        command: cfg.command,
        args: cfg.args,
        cwd: cfg.cwd,
        env,
      };
    }

    const headers: KeyValueFieldView[] = [];
    for (const [key, rawVal] of Object.entries(cfg.headers)) {
      const secKey = extractSecretKey(rawVal);
      if (secKey) {
        headers.push({
          key,
          value: "",
          isSecret: true,
          hasSecret: await this.secrets.has(secKey),
        });
      } else {
        headers.push({ key, value: rawVal, isSecret: false });
      }
    }

    let auth: AuthView;
    if (cfg.auth.type === "none") {
      auth = { type: "none" };
    } else if (cfg.auth.type === "bearer") {
      const secKey = extractSecretKey(cfg.auth.token);
      auth = {
        type: "bearer",
        hasSecret: secKey ? await this.secrets.has(secKey) : cfg.auth.token.length > 0,
      };
    } else if (cfg.auth.type === "api_key") {
      const secKey = extractSecretKey(cfg.auth.key);
      auth = {
        type: "api_key",
        hasSecret: secKey ? await this.secrets.has(secKey) : cfg.auth.key.length > 0,
        in: cfg.auth.in,
        headerName: cfg.auth.headerName,
        prefix: cfg.auth.prefix,
        queryParam: cfg.auth.queryParam,
      };
    } else {
      const secKey = cfg.auth.clientSecret ? extractSecretKey(cfg.auth.clientSecret) : null;
      auth = {
        type: "oauth",
        clientId: cfg.auth.clientId,
        hasClientSecret: secKey
          ? await this.secrets.has(secKey)
          : Boolean(cfg.auth.clientSecret),
        scopes: cfg.auth.scopes,
      };
    }

    return {
      ...base,
      url: cfg.url,
      auth,
      headers,
    };
  }

  /**
   * Watches ~/metarelay/mcp/ for manual terminal edits to servers.yaml.
   */
  async startWatching(): Promise<void> {
    if (this.watcher) return;
    const dir = path.dirname(this.filePath);
    const targetName = path.basename(this.filePath);
    await fsp.mkdir(dir, { recursive: true });

    this.watcher = fs.watch(dir, (_eventType, filename) => {
      if (filename && filename !== targetName) return;
      if (Date.now() < this.suppressWatchUntil) return;
      if (this.reloadTimer) clearTimeout(this.reloadTimer);
      this.reloadTimer = setTimeout(() => {
        this.load()
          .then((updated) => this.emit("changed", updated))
          .catch((err) => this.emit("error", err));
      }, 150);
    });
  }

  stopWatching(): void {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }
}
