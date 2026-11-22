export interface HealthResponse {
  ok: boolean;
  service: string;
  version: string;
  mcpEndpoint: string;
  serversFile: string;
  connectedServers: number;
  totalServers: number;
  totalTools: number;
  activeSessions: number;
}

export interface McpPreset {
  id: string;
  name: string;
  category: string;
  description: string;
  transport: "http" | "sse";
  url: string;
  authType: "oauth" | "bearer" | "api_key";
  defaultScopes?: string[];
  docsUrl: string;
  installed: boolean;
}

export interface KeyValueField {
  key: string;
  value: string;
  isSecret: boolean;
  hasSecret?: boolean;
}

export interface ServerConfigView {
  id: string;
  name: string;
  presetId?: string;
  transport: "stdio" | "http" | "sse";
  enabled: boolean;
  concurrency?: number;
  timeoutMs: number;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: KeyValueField[];
  url?: string;
  auth?: {
    type: "none" | "bearer" | "api_key" | "oauth";
    hasSecret?: boolean;
    in?: "header" | "query";
    headerName?: string;
    prefix?: string;
    queryParam?: string;
    clientId?: string;
    hasClientSecret?: boolean;
    scopes?: string[];
  };
  headers?: KeyValueField[];
}

export interface ProxiedTool {
  serverId: string;
  originalName: string;
  namespacedName: string;
  tool: {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  };
}

export interface ServerSummary {
  config: ServerConfigView;
  runtime: {
    id: string;
    status: "connected" | "connecting" | "needs_auth" | "error" | "disabled";
    error?: string;
    toolCount: number;
    tools: ProxiedTool[];
    hasOAuthTokens: boolean;
    lastConnectedAt?: number;
  };
}

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) {
    throw new Error(data.error ?? `Request failed (${res.status})`);
  }
  return data;
}

export const metaRelayApi = {
  getHealth: () => jsonFetch<HealthResponse>("/api/health"),
  getPresets: () => jsonFetch<{ presets: McpPreset[] }>("/api/mcp/presets"),
  getServers: () => jsonFetch<{ servers: ServerSummary[] }>("/api/mcp/servers"),
  quickConnectPreset: (presetId: string) =>
    jsonFetch<{ server: ServerSummary }>("/api/mcp/servers", {
      method: "POST",
      body: JSON.stringify({ presetId }),
    }),
  createServer: (payload: Record<string, unknown>) =>
    jsonFetch<{ server: ServerSummary }>("/api/mcp/servers", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  updateServer: (id: string, payload: Record<string, unknown>) =>
    jsonFetch<{ server: ServerSummary }>(`/api/mcp/servers/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    }),
  deleteServer: (id: string) =>
    jsonFetch<{ ok: boolean }>(`/api/mcp/servers/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  reconnectServer: (id: string) =>
    jsonFetch<{ ok: boolean }>(`/api/mcp/servers/${encodeURIComponent(id)}/reconnect`, {
      method: "POST",
      body: "{}",
    }),
  startOAuth: (id: string) =>
    jsonFetch<{ authorizeUrl: string }>(
      `/api/mcp/servers/${encodeURIComponent(id)}/oauth/start`,
      { method: "POST", body: "{}" },
    ),
  revokeOAuth: (id: string) =>
    jsonFetch<{ ok: boolean }>(`/api/mcp/servers/${encodeURIComponent(id)}/oauth/revoke`, {
      method: "POST",
      body: "{}",
    }),
};
