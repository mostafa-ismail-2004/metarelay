import { EventEmitter } from "node:events";
import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { MetaRelayConfig } from "./config.js";
import { MetaRelayOAuthProvider } from "./oauth.js";
import type { McpRegistry, RemoteServerConfig, ServerConfig } from "./registry.js";
import type { SecretStore } from "./secrets.js";

export type UpstreamStatus = "connected" | "connecting" | "needs_auth" | "error" | "disabled";

export interface ProxiedTool {
  serverId: string;
  originalName: string;
  namespacedName: string;
  tool: Tool;
}

export interface UpstreamSnapshot {
  id: string;
  status: UpstreamStatus;
  error?: string;
  toolCount: number;
  tools: ProxiedTool[];
  hasOAuthTokens: boolean;
  lastConnectedAt?: number;
}

class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  private readonly max: number;

  constructor(max: number) {
    this.max = Math.max(1, max);
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

interface ManagedUpstream {
  id: string;
  config: ServerConfig;
  status: UpstreamStatus;
  error?: string;
  client?: Client;
  transport?: StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport;
  oauthProvider?: MetaRelayOAuthProvider;
  tools: ProxiedTool[];
  semaphore?: Semaphore;
  connectingPromise?: Promise<void>;
  lastConnectedAt?: number;
}

export const TOOL_NAMESPACE_SEPARATOR = "__";

export function namespaceToolName(serverId: string, toolName: string): string {
  return `${serverId}${TOOL_NAMESPACE_SEPARATOR}${toolName}`;
}

export function splitNamespacedToolName(
  namespacedName: string,
): { serverId: string; toolName: string } | null {
  const idx = namespacedName.indexOf(TOOL_NAMESPACE_SEPARATOR);
  if (idx <= 0) return null;
  const serverId = namespacedName.slice(0, idx);
  const toolName = namespacedName.slice(idx + TOOL_NAMESPACE_SEPARATOR.length);
  if (!toolName) return null;
  return { serverId, toolName };
}

function isAuthError(err: unknown): boolean {
  if (err instanceof UnauthorizedError) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /\b401\b|unauthorized|authentication required|invalid_token/i.test(msg);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Timed out after ${timeoutMs}ms (${label})`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class UpstreamManager extends EventEmitter {
  private readonly config: MetaRelayConfig;
  private readonly registry: McpRegistry;
  private readonly secrets: SecretStore;
  private readonly upstreams = new Map<string, ManagedUpstream>();
  private readonly onRegistryChanged: (servers: Map<string, ServerConfig>) => void;

  constructor(config: MetaRelayConfig, registry: McpRegistry, secrets: SecretStore) {
    super();
    this.config = config;
    this.registry = registry;
    this.secrets = secrets;
    this.onRegistryChanged = (servers) => {
      void this.reconcile(servers);
    };
    this.registry.on("changed", this.onRegistryChanged);
  }

  async syncAll(): Promise<void> {
    await this.reconcile(this.registry.getAll());
  }

  async reconcile(desired: Map<string, ServerConfig>): Promise<void> {
    const tasks: Promise<void>[] = [];

    // Remove deleted servers
    for (const id of Array.from(this.upstreams.keys())) {
      if (!desired.has(id)) {
        tasks.push(this.removeUpstream(id));
      }
    }

    // Add or update existing servers
    for (const [id, cfg] of desired.entries()) {
      const existing = this.upstreams.get(id);
      if (!existing) {
        const entry = this.createEntry(id, cfg);
        this.upstreams.set(id, entry);
        if (cfg.enabled) {
          tasks.push(this.connectServer(id));
        }
      } else if (JSON.stringify(existing.config) !== JSON.stringify(cfg)) {
        tasks.push(
          this.disconnectEntry(existing).then(() => {
            const next = this.createEntry(id, cfg);
            this.upstreams.set(id, next);
            if (cfg.enabled) {
              return this.connectServer(id);
            }
            this.emit("toolsChanged");
          }),
        );
      } else if (existing.connectingPromise) {
        tasks.push(existing.connectingPromise);
      }
    }

    await Promise.allSettled(tasks);
  }

  private createEntry(id: string, cfg: ServerConfig): ManagedUpstream {
    return {
      id,
      config: cfg,
      status: cfg.enabled ? "connecting" : "disabled",
      tools: [],
      semaphore: cfg.concurrency ? new Semaphore(cfg.concurrency) : undefined,
    };
  }

  private async removeUpstream(id: string): Promise<void> {
    const entry = this.upstreams.get(id);
    if (!entry) return;
    await this.disconnectEntry(entry);
    this.upstreams.delete(id);
    this.emit("toolsChanged");
  }

  private async disconnectEntry(entry: ManagedUpstream): Promise<void> {
    const client = entry.client;
    const transport = entry.transport;
    entry.client = undefined;
    entry.transport = undefined;
    entry.tools = [];
    entry.connectingPromise = undefined;
    try {
      await client?.close();
    } catch {
      // Ignore shutdown errors
    }
    try {
      await transport?.close();
    } catch {
      // Ignore shutdown errors
    }
  }

  private async buildOAuthProvider(
    id: string,
    cfg: RemoteServerConfig,
  ): Promise<MetaRelayOAuthProvider> {
    let clientSecret: string | undefined;
    if (cfg.auth.type === "oauth" && cfg.auth.clientSecret) {
      clientSecret = await this.secrets.resolveString(cfg.auth.clientSecret);
    }
    const redirectUrl = `${this.config.baseUrl}/api/mcp/servers/${encodeURIComponent(id)}/oauth/callback`;
    return new MetaRelayOAuthProvider({
      serverId: id,
      oauthDir: this.config.oauthDir,
      redirectUrl,
      clientId: cfg.auth.type === "oauth" ? cfg.auth.clientId : undefined,
      clientSecret,
      scopes: cfg.auth.type === "oauth" ? cfg.auth.scopes : undefined,
    });
  }

  private async buildRemoteConnection(
    id: string,
    cfg: RemoteServerConfig,
  ): Promise<{
    transport: StreamableHTTPClientTransport | SSEClientTransport;
    oauthProvider?: MetaRelayOAuthProvider;
  }> {
    const url = new URL(cfg.url);
    const headers: Record<string, string> = {};

    for (const [k, v] of Object.entries(cfg.headers)) {
      headers[k] = await this.secrets.resolveString(v);
    }

    let oauthProvider: MetaRelayOAuthProvider | undefined;

    if (cfg.auth.type === "bearer") {
      const token = await this.secrets.resolveString(cfg.auth.token);
      headers["Authorization"] = `Bearer ${token}`;
    } else if (cfg.auth.type === "api_key") {
      const apiKey = await this.secrets.resolveString(cfg.auth.key);
      if (cfg.auth.in === "query") {
        url.searchParams.set(cfg.auth.queryParam, apiKey);
      } else {
        const value = cfg.auth.prefix ? `${cfg.auth.prefix} ${apiKey}` : apiKey;
        headers[cfg.auth.headerName] = value;
      }
    } else if (cfg.auth.type === "oauth") {
      oauthProvider = await this.buildOAuthProvider(id, cfg);
    }

    const requestInit: RequestInit | undefined =
      Object.keys(headers).length > 0 ? { headers } : undefined;

    const transport =
      cfg.transport === "sse"
        ? new SSEClientTransport(url, { requestInit, authProvider: oauthProvider })
        : new StreamableHTTPClientTransport(url, { requestInit, authProvider: oauthProvider });

    return { transport, oauthProvider };
  }

  /**
   * Single-flight connection per server ID so concurrent callers never spawn duplicate processes.
   */
  async connectServer(id: string): Promise<void> {
    const entry = this.upstreams.get(id);
    if (!entry) {
      throw new Error(`Unknown MCP server "${id}"`);
    }
    if (!entry.config.enabled) {
      entry.status = "disabled";
      entry.error = undefined;
      return;
    }
    if (entry.connectingPromise) {
      return entry.connectingPromise;
    }

    const promise = this.doConnect(entry).finally(() => {
      if (entry.connectingPromise === promise) {
        entry.connectingPromise = undefined;
      }
    });
    entry.connectingPromise = promise;
    return promise;
  }

  private async doConnect(entry: ManagedUpstream): Promise<void> {
    await this.disconnectEntry(entry);
    entry.status = "connecting";
    entry.error = undefined;

    const client = new Client(
      { name: "metarelay-proxy", version: "0.1.0" },
      { capabilities: {} },
    );

    let transport: StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport;

    try {
      if (entry.config.transport === "stdio") {
        const resolvedEnv: Record<string, string> = {};
        for (const [k, v] of Object.entries(process.env)) {
          if (typeof v === "string") resolvedEnv[k] = v;
        }
        for (const [k, v] of Object.entries(entry.config.env)) {
          resolvedEnv[k] = await this.secrets.resolveString(v);
        }
        transport = new StdioClientTransport({
          command: entry.config.command,
          args: entry.config.args,
          cwd: entry.config.cwd,
          env: resolvedEnv,
          stderr: "pipe",
        });
      } else {
        const built = await this.buildRemoteConnection(entry.id, entry.config);
        transport = built.transport;
        entry.oauthProvider = built.oauthProvider;
      }

      entry.client = client;
      entry.transport = transport;

      transport.onclose = () => {
        if (entry.transport === transport && entry.status === "connected") {
          entry.status = "error";
          entry.error = "Upstream transport closed unexpectedly";
          entry.tools = [];
          this.emit("toolsChanged");
        }
      };

      await withTimeout(
        client.connect(transport),
        entry.config.timeoutMs,
        `connect ${entry.id}`,
      );

      const listResult = await withTimeout(
        client.listTools(),
        entry.config.timeoutMs,
        `listTools ${entry.id}`,
      );

      entry.tools = listResult.tools.map((tool) => {
        const namespacedName = namespaceToolName(entry.id, tool.name);
        return {
          serverId: entry.id,
          originalName: tool.name,
          namespacedName,
          tool: {
            ...tool,
            name: namespacedName,
            description: tool.description
              ? `[${entry.config.name ?? entry.id}] ${tool.description}`
              : `[${entry.config.name ?? entry.id}] ${tool.name}`,
          },
        };
      });
      entry.status = "connected";
      entry.error = undefined;
      entry.lastConnectedAt = Date.now();
      this.emit("toolsChanged");
    } catch (err) {
      if (entry.config.transport !== "stdio" && entry.config.auth.type === "oauth" && isAuthError(err)) {
        entry.status = "needs_auth";
        entry.error = "OAuth authorization required";
      } else {
        entry.status = "error";
        entry.error = err instanceof Error ? err.message : String(err);
      }
      entry.tools = [];
      // Keep transport around if OAuth redirect is pending so finishAuth can complete on it
      if (entry.status !== "needs_auth") {
        await this.disconnectEntry(entry);
      }
      this.emit("toolsChanged");
    }
  }

  /**
   * Starts a ChatGPT-style OAuth 2.1 authorization flow and returns the provider URL to open.
   */
  async startOAuth(id: string): Promise<{ authorizeUrl: string }> {
    const entry = this.upstreams.get(id);
    if (!entry) {
      throw new Error(`Unknown MCP server "${id}"`);
    }
    if (entry.config.transport === "stdio" || entry.config.auth.type !== "oauth") {
      throw new Error(`Server "${id}" is not configured for OAuth`);
    }

    await this.disconnectEntry(entry);
    const { transport, oauthProvider } = await this.buildRemoteConnection(id, entry.config);
    if (!oauthProvider) {
      throw new Error(`Failed to initialize OAuth provider for "${id}"`);
    }
    oauthProvider.clearPendingAuthorizationUrl();
    entry.transport = transport;
    entry.oauthProvider = oauthProvider;

    const client = new Client(
      { name: "metarelay-proxy", version: "0.1.0" },
      { capabilities: {} },
    );
    entry.client = client;

    try {
      await withTimeout(client.connect(transport), 20_000, `oauth start ${id}`);
      // Already had valid tokens!
      await this.connectServer(id);
      throw new Error("Server is already authorized and connected");
    } catch (err) {
      const authorizeUrl = oauthProvider.pendingAuthorizationUrl;
      if (authorizeUrl) {
        entry.status = "needs_auth";
        entry.error = "Waiting for OAuth approval in browser";
        return { authorizeUrl: authorizeUrl.toString() };
      }
      throw err;
    }
  }

  /**
   * Completes the OAuth callback, persists tokens (0600), and connects the upstream.
   */
  async finishOAuth(id: string, callbackParams: URLSearchParams): Promise<void> {
    const entry = this.upstreams.get(id);
    if (!entry) {
      throw new Error(`Unknown MCP server "${id}"`);
    }
    if (entry.config.transport === "stdio" || entry.config.auth.type !== "oauth") {
      throw new Error(`Server "${id}" is not configured for OAuth`);
    }

    const oauthProvider = entry.oauthProvider ?? (await this.buildOAuthProvider(id, entry.config));
    const stateValid = await oauthProvider.verifyState(callbackParams.get("state"));
    if (!stateValid) {
      throw new Error("Invalid OAuth state parameter");
    }

    let transport = entry.transport;
    if (!transport || transport instanceof StdioClientTransport) {
      const built = await this.buildRemoteConnection(id, entry.config);
      transport = built.transport;
      entry.transport = transport;
      entry.oauthProvider = built.oauthProvider;
    }

    await transport.finishAuth(callbackParams);
    await this.connectServer(id);
  }

  async revokeOAuth(id: string): Promise<void> {
    const entry = this.upstreams.get(id);
    if (!entry) {
      throw new Error(`Unknown MCP server "${id}"`);
    }
    if (entry.config.transport !== "stdio" && entry.config.auth.type === "oauth") {
      const provider = entry.oauthProvider ?? (await this.buildOAuthProvider(id, entry.config));
      await provider.clear();
    }
    await this.disconnectEntry(entry);
    entry.status = entry.config.enabled ? "needs_auth" : "disabled";
    entry.error = entry.config.enabled ? "OAuth tokens revoked" : undefined;
    this.emit("toolsChanged");
  }

  listAllTools(): Tool[] {
    const out: Tool[] = [];
    for (const entry of this.upstreams.values()) {
      if (entry.status !== "connected") continue;
      for (const item of entry.tools) {
        out.push(item.tool);
      }
    }
    return out;
  }

  async callTool(
    namespacedName: string,
    args: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const split = splitNamespacedToolName(namespacedName);
    if (!split) {
      throw new Error(`Invalid proxied tool name "${namespacedName}"`);
    }

    const entry = this.upstreams.get(split.serverId);
    if (!entry) {
      throw new Error(`MCP server "${split.serverId}" is not registered`);
    }
    if (!entry.config.enabled) {
      throw new Error(`MCP server "${split.serverId}" is disabled`);
    }
    if (entry.status === "needs_auth") {
      throw new Error(
        `MCP server "${split.serverId}" requires OAuth sign-in in the MetaRelay console`,
      );
    }

    if (entry.status !== "connected" || !entry.client) {
      await this.connectServer(entry.id);
    }

    const client = entry.client;
    if (!client || entry.status !== "connected") {
      throw new Error(
        `MCP server "${split.serverId}" is unavailable: ${entry.error ?? entry.status}`,
      );
    }

    const invoke = () =>
      withTimeout(
        client.callTool({
          name: split.toolName,
          arguments: args ?? {},
        }),
        entry.config.timeoutMs,
        `callTool ${namespacedName}`,
      ) as Promise<CallToolResult>;

    if (entry.semaphore) {
      return entry.semaphore.run(invoke);
    }
    return invoke();
  }

  async getSnapshot(id: string): Promise<UpstreamSnapshot | undefined> {
    const entry = this.upstreams.get(id);
    if (!entry) return undefined;
    let hasOAuthTokens = false;
    if (entry.config.transport !== "stdio" && entry.config.auth.type === "oauth") {
      const provider = entry.oauthProvider ?? (await this.buildOAuthProvider(id, entry.config));
      hasOAuthTokens = await provider.hasTokens();
    }
    return {
      id: entry.id,
      status: entry.status,
      error: entry.error,
      toolCount: entry.tools.length,
      tools: entry.tools,
      hasOAuthTokens,
      lastConnectedAt: entry.lastConnectedAt,
    };
  }

  async getAllSnapshots(): Promise<UpstreamSnapshot[]> {
    const list: UpstreamSnapshot[] = [];
    for (const id of this.upstreams.keys()) {
      const snap = await this.getSnapshot(id);
      if (snap) list.push(snap);
    }
    return list;
  }

  async close(): Promise<void> {
    this.registry.off("changed", this.onRegistryChanged);
    await Promise.allSettled(
      Array.from(this.upstreams.values()).map((entry) => this.disconnectEntry(entry)),
    );
    this.upstreams.clear();
  }
}
