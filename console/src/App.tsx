import { useCallback, useEffect, useMemo, useState } from "react";
import { ChatView } from "./components/ChatView";
import { Icon } from "./components/Icons";
import {
  metaRelayApi,
  type HealthResponse,
  type KeyValueField,
  type McpPreset,
  type ServerSummary,
} from "./lib/api";

type PageKey = "proxy" | "memory" | "workflows" | "chat";
type ThemePreference = "light" | "dark" | "system";

const THEME_STORAGE_KEY = "metarelay.theme";

function readInitialTheme(): ThemePreference {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === "light" || saved === "dark" || saved === "system") {
      return saved;
    }
  } catch {
    // ignore storage errors
  }
  return "system";
}

interface FormDraft {
  id: string;
  name: string;
  transport: "http" | "sse" | "stdio";
  enabled: boolean;
  url: string;
  authType: "oauth" | "bearer" | "api_key" | "none";
  bearerToken: string;
  apiKey: string;
  apiKeyIn: "header" | "query";
  apiKeyHeaderName: string;
  apiKeyPrefix: string;
  apiKeyQueryParam: string;
  oauthClientId: string;
  oauthClientSecret: string;
  oauthScopes: string;
  headers: KeyValueField[];
  command: string;
  args: string[];
  cwd: string;
  env: KeyValueField[];
  concurrency: string;
  timeoutMs: string;
}

const EMPTY_DRAFT: FormDraft = {
  id: "",
  name: "",
  transport: "http",
  enabled: true,
  url: "",
  authType: "oauth",
  bearerToken: "",
  apiKey: "",
  apiKeyIn: "header",
  apiKeyHeaderName: "X-API-Key",
  apiKeyPrefix: "",
  apiKeyQueryParam: "api_key",
  oauthClientId: "",
  oauthClientSecret: "",
  oauthScopes: "",
  headers: [],
  command: "",
  args: [],
  cwd: "",
  env: [],
  concurrency: "",
  timeoutMs: "60000",
};

const TRANSPORT_LABELS = { http: "HTTP", sse: "SSE", stdio: "Stdio" } as const;
const AUTH_LABELS = { oauth: "OAuth", bearer: "Bearer", api_key: "API Key", none: "None" } as const;
const STATUS_LABELS: Record<ServerSummary["runtime"]["status"], string> = {
  connected: "Connected",
  connecting: "Connecting…",
  needs_auth: "Needs Auth",
  error: "Error",
  disabled: "Disabled",
};

const PREVIEWS: Record<Exclude<PageKey, "proxy" | "chat">, [string, string, string, string]> = {
  memory: [
    "Memory",
    "Shared Markdown notes and decisions under ~/metarelay/memory.",
    "decisions.md",
    "## Workspace decisions\n\nUse the local proxy endpoint across harnesses.\nKeep stateful tools at concurrency 1.",
  ],
  workflows: [
    "Workflows",
    "Named reusable Markdown workflows shared across all harnesses.",
    "secretary.md",
    "Capture incoming notes → extract follow-ups → draft Friday review handoff.",
  ],
};

function draftFromServer(summary: ServerSummary): FormDraft {
  const c = summary.config;
  return {
    id: c.id,
    name: c.name,
    transport: c.transport,
    enabled: c.enabled,
    url: c.url ?? "",
    authType: c.auth?.type ?? "none",
    bearerToken: "",
    apiKey: "",
    apiKeyIn: c.auth?.in ?? "header",
    apiKeyHeaderName: c.auth?.headerName ?? "X-API-Key",
    apiKeyPrefix: c.auth?.prefix ?? "",
    apiKeyQueryParam: c.auth?.queryParam ?? "api_key",
    oauthClientId: c.auth?.clientId ?? "",
    oauthClientSecret: "",
    oauthScopes: (c.auth?.scopes ?? []).join(" "),
    headers: (c.headers ?? []).map((h) => ({ ...h })),
    command: c.command ?? "",
    args: [...(c.args ?? [])],
    cwd: c.cwd ?? "",
    env: (c.env ?? []).map((e) => ({ ...e })),
    concurrency: c.concurrency ? String(c.concurrency) : "",
    timeoutMs: String(c.timeoutMs ?? 60000),
  };
}

export function App() {
  const [page, setPage] = useState<PageKey>("chat");
  const [themePref, setThemePref] = useState<ThemePreference>(readInitialTheme);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [servers, setServers] = useState<ServerSummary[]>([]);
  const [presets, setPresets] = useState<McpPreset[]>([]);
  const [daemonError, setDaemonError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [toast, setToast] = useState<string | null>(null);

  // Inspector drawer
  const [inspectServerId, setInspectServerId] = useState<string | null>(null);
  const [toolSearch, setToolSearch] = useState("");

  // Add/Edit modal
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editorTab, setEditorTab] = useState<"quick" | "custom">("quick");
  const [draft, setDraft] = useState<FormDraft>(EMPTY_DRAFT);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Quick Connect filters
  const [presetQuery, setPresetQuery] = useState("");
  const [presetCategory, setPresetCategory] = useState("");

  // Delete confirm modal
  const [deleteTarget, setDeleteTarget] = useState<ServerSummary | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const resolved =
        themePref === "system" ? (media.matches ? "dark" : "light") : themePref;
      document.documentElement.dataset.theme = resolved;
      document.documentElement.style.colorScheme = resolved;
    };
    apply();
    try {
      localStorage.setItem(THEME_STORAGE_KEY, themePref);
    } catch {
      // ignore
    }
    if (themePref !== "system") return;
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [themePref]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3400);
    return () => clearTimeout(t);
  }, [toast]);

  const refreshAll = useCallback(async () => {
    try {
      const [h, s, p] = await Promise.all([
        metaRelayApi.getHealth(),
        metaRelayApi.getServers(),
        metaRelayApi.getPresets(),
      ]);
      setHealth(h);
      setServers(s.servers);
      setPresets(p.presets);
      setDaemonError(null);
    } catch (err) {
      setDaemonError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refreshAll();
    const params = new URLSearchParams(window.location.search);
    if (params.get("oauth") === "success") {
      const srv = params.get("server");
      setPage("proxy");
      showToast(srv ? `${srv} authorized and connected` : "OAuth connection complete");
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, [refreshAll, showToast]);

  const connectedCount = useMemo(
    () => servers.filter((s) => s.runtime.status === "connected").length,
    [servers],
  );
  const totalTools = useMemo(
    () =>
      servers
        .filter((s) => s.runtime.status === "connected")
        .reduce((sum, s) => sum + s.runtime.toolCount, 0),
    [servers],
  );
  const authIssueCount = useMemo(
    () => servers.filter((s) => s.runtime.status === "needs_auth" || s.runtime.status === "error").length,
    [servers],
  );

  const filteredServers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return servers;
    return servers.filter((s) =>
      `${s.config.name} ${s.config.id} ${s.config.transport}`.toLowerCase().includes(q),
    );
  }, [servers, search]);

  const inspectedServer = useMemo(
    () => servers.find((s) => s.config.id === inspectServerId) ?? null,
    [servers, inspectServerId],
  );

  const presetCategories = useMemo(
    () => [...new Set(presets.map((p) => p.category))].sort(),
    [presets],
  );

  const filteredPresets = useMemo(() => {
    const q = presetQuery.trim().toLowerCase();
    return presets.filter(
      (p) =>
        (!presetCategory || p.category === presetCategory) &&
        `${p.name} ${p.category} ${p.description}`.toLowerCase().includes(q),
    );
  }, [presets, presetCategory, presetQuery]);

  const endpointDisplay = health?.mcpEndpoint ?? "http://127.0.0.1:3847/mcp";

  async function copyEndpoint() {
    try {
      await navigator.clipboard.writeText(endpointDisplay);
      showToast("MCP endpoint copied");
    } catch {
      showToast(`Endpoint: ${endpointDisplay}`);
    }
  }

  function openAddModal() {
    setEditingId(null);
    setDraft(EMPTY_DRAFT);
    setEditorTab("quick");
    setFormError(null);
    setPresetQuery("");
    setPresetCategory("");
    setEditorOpen(true);
  }

  function openEditModal(summary: ServerSummary) {
    setEditingId(summary.config.id);
    setDraft(draftFromServer(summary));
    setEditorTab("custom");
    setFormError(null);
    setEditorOpen(true);
  }

  async function handleStartOAuth(serverId: string) {
    try {
      const { authorizeUrl } = await metaRelayApi.startOAuth(serverId);
      window.open(authorizeUrl, "_blank", "noopener,noreferrer");
      showToast(`Opened OAuth sign-in for ${serverId}`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleQuickConnect(preset: McpPreset) {
    setSaving(true);
    try {
      if (!preset.installed) {
        await metaRelayApi.quickConnectPreset(preset.id);
      }
      await refreshAll();
      if (preset.authType === "oauth") {
        await handleStartOAuth(preset.id);
      } else {
        showToast(`${preset.name} added`);
      }
      setEditorOpen(false);
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveCustom(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    const id = draft.id.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) {
      setFormError("Server ID must be lowercase alphanumeric, hyphens, or underscores.");
      return;
    }

    const payload: Record<string, unknown> = {
      id,
      name: draft.name.trim() || id,
      transport: draft.transport,
      enabled: draft.enabled,
      concurrency: draft.concurrency.trim() ? Number(draft.concurrency) : null,
      timeoutMs: Number(draft.timeoutMs) || 60000,
    };

    if (draft.transport === "stdio") {
      if (!draft.command.trim()) {
        setFormError("Command is required for Local Stdio transport.");
        return;
      }
      payload.command = draft.command.trim();
      payload.args = draft.args.filter((a) => a.length > 0);
      if (draft.cwd.trim()) payload.cwd = draft.cwd.trim();
      payload.env = draft.env.filter((row) => row.key.trim().length > 0);
    } else {
      if (!draft.url.trim()) {
        setFormError("Endpoint URL is required for HTTP/SSE transport.");
        return;
      }
      payload.url = draft.url.trim();
      payload.headers = draft.headers.filter((row) => row.key.trim().length > 0);
      if (draft.authType === "none") {
        payload.auth = { type: "none" };
      } else if (draft.authType === "bearer") {
        payload.auth = {
          type: "bearer",
          ...(draft.bearerToken ? { token: draft.bearerToken } : {}),
        };
      } else if (draft.authType === "api_key") {
        payload.auth = {
          type: "api_key",
          in: draft.apiKeyIn,
          headerName: draft.apiKeyHeaderName.trim() || "X-API-Key",
          prefix: draft.apiKeyPrefix.trim() || undefined,
          queryParam: draft.apiKeyQueryParam.trim() || "api_key",
          ...(draft.apiKey ? { key: draft.apiKey } : {}),
        };
      } else {
        payload.auth = {
          type: "oauth",
          clientId: draft.oauthClientId.trim() || undefined,
          clientSecret: draft.oauthClientSecret.trim() || undefined,
          scopes: draft.oauthScopes
            .split(/[\s,]+/)
            .map((s) => s.trim())
            .filter(Boolean),
        };
      }
    }

    setSaving(true);
    try {
      if (editingId) {
        await metaRelayApi.updateServer(editingId, payload);
        showToast(`${draft.name || id} updated`);
      } else {
        await metaRelayApi.createServer(payload);
        showToast(`${draft.name || id} added`);
      }
      await refreshAll();
      setEditorOpen(false);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleToggle(summary: ServerSummary) {
    const c = summary.config;
    try {
      await metaRelayApi.updateServer(c.id, {
        ...c,
        enabled: !c.enabled,
        concurrency: c.concurrency ?? null,
      });
      await refreshAll();
      showToast(`${c.name} ${!c.enabled ? "enabled" : "disabled"}`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleReconnect(summary: ServerSummary) {
    if (!summary.config.enabled) {
      showToast(`Enable ${summary.config.name} before reconnecting`);
      return;
    }
    if (summary.runtime.status === "needs_auth") {
      await handleStartOAuth(summary.config.id);
      return;
    }
    try {
      await metaRelayApi.reconnectServer(summary.config.id);
      await refreshAll();
      showToast(`${summary.config.name} reconnected`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleConfirmDelete() {
    if (!deleteTarget) return;
    try {
      await metaRelayApi.deleteServer(deleteTarget.config.id);
      if (inspectServerId === deleteTarget.config.id) setInspectServerId(null);
      setDeleteTarget(null);
      await refreshAll();
      showToast(`${deleteTarget.config.name} deleted`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err));
    }
  }

  const crumbTitle =
    page === "proxy"
      ? "MCP Proxy"
      : page === "memory"
        ? "Memory"
        : page === "workflows"
          ? "Workflows"
          : "Chat & Handoffs";

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brandmark">
            <Icon name="relay" />
          </span>
          <div>
            MetaRelay
            <small>LOCAL WORKSPACE</small>
          </div>
        </div>

        <div className="nav-area">
          <p className="eyebrow">Workspace</p>
          <nav aria-label="Workspace">
            <button
              type="button"
              aria-current={page === "chat" ? "page" : undefined}
              onClick={() => setPage("chat")}
            >
              <Icon name="chat" />
              Chat
            </button>
            <button
              type="button"
              aria-current={page === "proxy" ? "page" : undefined}
              onClick={() => setPage("proxy")}
            >
              <Icon name="server" />
              MCP Proxy
            </button>
            <button
              type="button"
              aria-current={page === "memory" ? "page" : undefined}
              onClick={() => setPage("memory")}
            >
              <Icon name="file" />
              Memory
            </button>
            <button
              type="button"
              aria-current={page === "workflows" ? "page" : undefined}
              onClick={() => setPage("workflows")}
            >
              <Icon name="flow" />
              Workflows
            </button>
          </nav>
        </div>

        <div className="sidebar-bottom">
          <div className="harnesses">
            <p className="eyebrow">Harnesses</p>
            <div className="chips">
              <span>Codex</span>
              <span>Claude Code</span>
              <span>OpenClaw</span>
              <span>Antigravity</span>
            </div>
          </div>

          <div className="daemon">
            <div>
              <span className={`status-dot ${daemonError ? "offline" : ""}`} />
              <strong>Local daemon</strong>
              <span className={`online ${daemonError ? "offline-label" : ""}`}>
                {daemonError ? "Offline" : "Online"}
              </span>
            </div>
            <code>{endpointDisplay.replace(/^https?:\/\//, "")}</code>
            <button type="button" className="button" onClick={() => void copyEndpoint()}>
              <Icon name="copy" />
              Copy Endpoint
            </button>
          </div>
        </div>
      </aside>

      <main>
        <header className="topbar">
          <span>
            Workspace <span className="slash">/</span> <strong>{crumbTitle}</strong>
          </span>
          <div className="topbar-right">
            <div className="theme-switcher" role="group" aria-label="Theme">
              {(
                [
                  ["light", "Light", "sun"],
                  ["dark", "Dark", "moon"],
                  ["system", "System", "monitor"],
                ] as const
              ).map(([mode, label, iconName]) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={themePref === mode}
                  title={`Theme: ${label}`}
                  onClick={() => setThemePref(mode)}
                >
                  <Icon name={iconName} />
                  <span>{label}</span>
                </button>
              ))}
            </div>
            <span className="local">
              <Icon name="shield" /> Local-first
            </span>
          </div>
        </header>

        <div className="content">
          <div className="page-enter" key={page}>
            {page === "chat" ? (
              <ChatView totalTools={totalTools} onOpenProxy={() => setPage("proxy")} />
            ) : page === "proxy" ? (
            <section>
              <div className="page-heading">
                <div>
                  <h1>MCP Proxy</h1>
                  <p>Manage the MCP servers and tools shared across all your connected harnesses.</p>
                </div>
                <button type="button" className="button primary" onClick={openAddModal}>
                  <Icon name="plus" />
                  Add MCP Server
                </button>
              </div>

              {daemonError && (
                <div className="error-summary" style={{ marginTop: 16 }} role="alert">
                  Cannot reach local MetaRelay daemon ({daemonError}). Start it with{" "}
                  <code>npm run dev</code>.
                </div>
              )}

              <div className="metrics" aria-live="polite">
                <div className="metric">
                  <div className="metric-top">
                    Connected Servers
                    <span className="metric-icon">
                      <Icon name="server" />
                    </span>
                  </div>
                  <strong>{connectedCount}</strong>
                  <small>Enabled and available</small>
                </div>
                <div className="metric">
                  <div className="metric-top">
                    Total Proxied Tools
                    <span className="metric-icon">
                      <Icon name="tools" />
                    </span>
                  </div>
                  <strong>{totalTools}</strong>
                  <small>Across connected servers</small>
                </div>
                <div className="metric">
                  <div className="metric-top">
                    Attention Needed
                    <span className="metric-icon">
                      <Icon name="key" />
                    </span>
                  </div>
                  <strong>{authIssueCount}</strong>
                  <small>
                    {authIssueCount ? "Auth or connection issues" : "All connections healthy"}
                  </small>
                </div>
              </div>

              <section className="registry" aria-labelledby="registry-title">
                <div className="registry-head">
                  <div>
                    <h2 id="registry-title">
                      Registered servers <span className="count">{servers.length}</span>
                    </h2>
                    <p>Connections exposed through your unified local MCP endpoint.</p>
                  </div>
                  <label className="search">
                    <Icon name="search" />
                    <input
                      aria-label="Search servers"
                      placeholder="Search servers"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </label>
                </div>

                <div className="table-heading" aria-hidden="true">
                  <span>Server</span>
                  <span>Connection</span>
                  <span>Status</span>
                  <span>Tools</span>
                  <span>Actions</span>
                </div>

                <div>
                  {filteredServers.length === 0 ? (
                    <p className="empty">
                      {search
                        ? "No servers match your search."
                        : "No servers registered yet. Click Add MCP Server to connect a known OAuth server or build a custom connection."}
                    </p>
                  ) : (
                    filteredServers.map((s, idx) => {
                      const mark = s.config.name
                        .split(/\s+/)
                        .slice(0, 2)
                        .map((w) => w[0] ?? "")
                        .join("")
                        .toUpperCase();
                      const authBadge =
                        s.config.transport === "stdio"
                          ? s.config.concurrency
                            ? `Concurrency: ${s.config.concurrency}`
                            : "Local"
                          : AUTH_LABELS[s.config.auth?.type ?? "none"];

                      return (
                        <div
                          className="server-row"
                          key={s.config.id}
                          style={{ animationDelay: `${Math.min(idx, 8) * 35}ms` }}
                        >
                          <button
                            type="button"
                            className="identity"
                            onClick={() => {
                              setToolSearch("");
                              setInspectServerId(s.config.id);
                            }}
                          >
                            <span className="server-mark">{mark || "MC"}</span>
                            <span>
                              <strong>{s.config.name}</strong>
                              <code>{s.config.id}</code>
                            </span>
                          </button>

                          <div className="connection">
                            <span className="badge">{TRANSPORT_LABELS[s.config.transport]}</span>
                            <span className="badge">{authBadge}</span>
                          </div>

                          <div>
                            <span
                              className={`status ${s.runtime.status}`}
                              title={s.runtime.error ?? undefined}
                            >
                              {STATUS_LABELS[s.runtime.status]}
                            </span>
                          </div>

                          <div className="tools-count">
                            {s.runtime.toolCount > 0 ? s.runtime.toolCount : "—"}
                          </div>

                          <div className="actions">
                            {s.runtime.status === "needs_auth" && (
                              <button
                                type="button"
                                className="button primary"
                                onClick={() => void handleStartOAuth(s.config.id)}
                              >
                                Connect with OAuth
                              </button>
                            )}
                            <button
                              type="button"
                              className="button"
                              onClick={() => {
                                setToolSearch("");
                                setInspectServerId(s.config.id);
                              }}
                            >
                              Inspect Tools
                            </button>
                            <button
                              type="button"
                              className="switch"
                              role="switch"
                              aria-label={`Enable ${s.config.name}`}
                              aria-checked={s.config.enabled}
                              onClick={() => void handleToggle(s)}
                            />
                            <button
                              type="button"
                              className="icon-button"
                              title="Reconnect"
                              aria-label={`Reconnect ${s.config.name}`}
                              onClick={() => void handleReconnect(s)}
                            >
                              <Icon name="reconnect" />
                            </button>
                            <button
                              type="button"
                              className="icon-button"
                              title="Edit"
                              aria-label={`Edit ${s.config.name}`}
                              onClick={() => openEditModal(s)}
                            >
                              <Icon name="edit" />
                            </button>
                            <button
                              type="button"
                              className="icon-button danger"
                              title="Delete"
                              aria-label={`Delete ${s.config.name}`}
                              onClick={() => setDeleteTarget(s)}
                            >
                              <Icon name="trash" />
                            </button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </section>
            </section>
          ) : (
            <section>
              <h1>{PREVIEWS[page][0]}</h1>
              <div className="hint">{PREVIEWS[page][1]}</div>
              <article className="preview-card">
                <span className="badge">Next roadmap milestone</span>
                <h2 style={{ marginTop: 8 }}>{PREVIEWS[page][2]}</h2>
                <pre>
                  <code>{PREVIEWS[page][3]}</code>
                </pre>
              </article>
            </section>
          )}
          </div>

          <footer className="main-footer">
            <span>MetaRelay workspace</span>
            <span>{health?.serversFile ?? "~/metarelay/mcp/servers.yaml"}</span>
          </footer>
        </div>
      </main>

      {/* Tool Inspector Slide-over Drawer */}
      {inspectedServer && (
        <div
          className="modal-backdrop drawer-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) setInspectServerId(null);
          }}
        >
          <div className="modal-panel drawer" role="dialog" aria-modal="true">
            <header className="panel-head">
              <div>
                <h2>{inspectedServer.config.name} tools</h2>
                <p>
                  {inspectedServer.config.id} · {inspectedServer.runtime.toolCount} tools
                </p>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="Close"
                onClick={() => setInspectServerId(null)}
              >
                <Icon name="close" />
              </button>
            </header>

            <div className="panel-content stack">
              {inspectedServer.runtime.error && (
                <div className="error-summary">{inspectedServer.runtime.error}</div>
              )}

              <label className="search">
                <Icon name="search" />
                <input
                  aria-label="Search tools"
                  placeholder="Filter by tool name or description"
                  value={toolSearch}
                  onChange={(e) => setToolSearch(e.target.value)}
                />
              </label>

              <div className="stack">
                {inspectedServer.runtime.tools
                  .filter((t) =>
                    `${t.namespacedName} ${t.tool.description ?? ""}`
                      .toLowerCase()
                      .includes(toolSearch.trim().toLowerCase()),
                  )
                  .map((t) => {
                    const props = Object.keys(
                      (t.tool.inputSchema?.properties as Record<string, unknown> | undefined) ?? {},
                    );
                    return (
                      <article className="tool" key={t.namespacedName}>
                        <code>{t.namespacedName}</code>
                        <p>{t.tool.description ?? "No description provided."}</p>
                        {props.length > 0 && (
                          <div className="chips">
                            {props.map((p) => (
                              <span key={p}>{p}</span>
                            ))}
                          </div>
                        )}
                      </article>
                    );
                  })}
                {inspectedServer.runtime.tools.length === 0 && (
                  <p className="empty">No tools discovered yet for this connection.</p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Add / Edit MCP Server Modal */}
      {editorOpen && (
        <div
          className="modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) setEditorOpen(false);
          }}
        >
          <div className="modal-panel" role="dialog" aria-modal="true">
            <header className="panel-head">
              <div>
                <h2>{editingId ? "Edit MCP Server" : "Add MCP Server"}</h2>
                <p>Configure a connection for the unified local MCP proxy.</p>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="Close"
                onClick={() => setEditorOpen(false)}
              >
                <Icon name="close" />
              </button>
            </header>

            <div className="panel-content stack">
              {!editingId && (
                <div className="tabs" role="tablist" aria-label="Connection setup">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={editorTab === "quick"}
                    className="ghost"
                    onClick={() => setEditorTab("quick")}
                  >
                    Quick Connect (Known Servers)
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={editorTab === "custom"}
                    className="ghost"
                    onClick={() => setEditorTab("custom")}
                  >
                    Custom Connection
                  </button>
                </div>
              )}

              {editorTab === "quick" && !editingId ? (
                <div className="stack">
                  <div className="filters">
                    <label className="search">
                      <Icon name="search" />
                      <input
                        aria-label="Search known servers"
                        placeholder="Search known servers"
                        value={presetQuery}
                        onChange={(e) => setPresetQuery(e.target.value)}
                      />
                    </label>
                    <select
                      aria-label="Filter by category"
                      value={presetCategory}
                      onChange={(e) => setPresetCategory(e.target.value)}
                    >
                      <option value="">All categories</option>
                      {presetCategories.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="stack">
                    {filteredPresets.map((preset) => (
                      <article className="directory-item" key={preset.id}>
                        <div>
                          <h3>{preset.name}</h3>
                          <p className="hint" style={{ marginBottom: 6 }}>
                            {preset.description}
                          </p>
                          <span className="badge">{preset.category}</span>{" "}
                          <span className="badge">OAuth 2.1</span>
                        </div>
                        <button
                          type="button"
                          className="button primary"
                          disabled={saving}
                          onClick={() => void handleQuickConnect(preset)}
                        >
                          {preset.installed ? "Reconnect" : "Connect"}
                        </button>
                      </article>
                    ))}
                    {filteredPresets.length === 0 && (
                      <p className="empty">No known servers match your filters.</p>
                    )}
                  </div>
                </div>
              ) : (
                <form id="custom-mcp-form" className="stack" onSubmit={(e) => void handleSaveCustom(e)}>
                  {formError && (
                    <div className="error-summary" role="alert">
                      {formError}
                    </div>
                  )}

                  <section className="field-block">
                    <h3>Basic information</h3>
                    <div className="field-grid">
                      <label className="field">
                        Server ID *
                        <input
                          required
                          disabled={Boolean(editingId)}
                          placeholder="my-server"
                          value={draft.id}
                          onChange={(e) => setDraft({ ...draft, id: e.target.value })}
                        />
                      </label>
                      <label className="field">
                        Display name *
                        <input
                          required
                          placeholder="My Server"
                          value={draft.name}
                          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                        />
                      </label>
                    </div>
                    <p className="hint">The server ID prefixes every proxied tool name.</p>
                  </section>

                  <section className="field-block">
                    <h3>Transport</h3>
                    <div className="segment" aria-label="Transport">
                      {(
                        [
                          ["http", "Streamable HTTP"],
                          ["sse", "Legacy SSE"],
                          ["stdio", "Local Stdio"],
                        ] as const
                      ).map(([key, label]) => (
                        <button
                          key={key}
                          type="button"
                          className="ghost"
                          aria-pressed={draft.transport === key}
                          onClick={() => setDraft({ ...draft, transport: key })}
                        >
                          {label}
                        </button>
                      ))}
                    </div>

                    {draft.transport === "stdio" ? (
                      <>
                        <label className="field">
                          Command *
                          <input
                            required
                            placeholder="npx"
                            value={draft.command}
                            onChange={(e) => setDraft({ ...draft, command: e.target.value })}
                          />
                        </label>

                        <div>
                          <div className="repeat-title">
                            <strong>Arguments</strong>
                            <button
                              type="button"
                              className="button"
                              onClick={() => setDraft({ ...draft, args: [...draft.args, ""] })}
                            >
                              <Icon name="plus" /> Add argument
                            </button>
                          </div>
                          {draft.args.map((arg, idx) => (
                            <div className="repeat-row" key={idx}>
                              <input
                                placeholder={`Argument ${idx + 1}`}
                                value={arg}
                                onChange={(e) => {
                                  const next = [...draft.args];
                                  next[idx] = e.target.value;
                                  setDraft({ ...draft, args: next });
                                }}
                              />
                              <button
                                type="button"
                                className="icon-button danger"
                                aria-label="Remove argument"
                                onClick={() =>
                                  setDraft({
                                    ...draft,
                                    args: draft.args.filter((_, i) => i !== idx),
                                  })
                                }
                              >
                                <Icon name="trash" />
                              </button>
                            </div>
                          ))}
                        </div>

                        <label className="field">
                          Working directory (optional)
                          <input
                            placeholder="/path/to/workspace"
                            value={draft.cwd}
                            onChange={(e) => setDraft({ ...draft, cwd: e.target.value })}
                          />
                        </label>

                        <div>
                          <div className="repeat-title">
                            <strong>Environment Variables</strong>
                            <button
                              type="button"
                              className="button"
                              onClick={() =>
                                setDraft({
                                  ...draft,
                                  env: [...draft.env, { key: "", value: "", isSecret: false }],
                                })
                              }
                            >
                              <Icon name="plus" /> Add row
                            </button>
                          </div>
                          {draft.env.map((row, idx) => (
                            <div className="repeat-row" key={idx}>
                              <input
                                placeholder="Variable"
                                value={row.key}
                                onChange={(e) => {
                                  const next = [...draft.env];
                                  next[idx] = { ...row, key: e.target.value };
                                  setDraft({ ...draft, env: next });
                                }}
                              />
                              <input
                                type={row.isSecret ? "password" : "text"}
                                placeholder={row.hasSecret ? "Saved (leave blank to keep)" : "Value"}
                                value={row.value}
                                onChange={(e) => {
                                  const next = [...draft.env];
                                  next[idx] = { ...row, value: e.target.value };
                                  setDraft({ ...draft, env: next });
                                }}
                              />
                              <label className="secret">
                                <input
                                  type="checkbox"
                                  checked={row.isSecret}
                                  onChange={(e) => {
                                    const next = [...draft.env];
                                    next[idx] = { ...row, isSecret: e.target.checked };
                                    setDraft({ ...draft, env: next });
                                  }}
                                />
                                Secret
                              </label>
                              <button
                                type="button"
                                className="icon-button danger"
                                aria-label="Remove variable"
                                onClick={() =>
                                  setDraft({
                                    ...draft,
                                    env: draft.env.filter((_, i) => i !== idx),
                                  })
                                }
                              >
                                <Icon name="trash" />
                              </button>
                            </div>
                          ))}
                        </div>
                      </>
                    ) : (
                      <>
                        <label className="field">
                          Endpoint URL *
                          <input
                            required
                            type="url"
                            placeholder="https://example.com/mcp"
                            value={draft.url}
                            onChange={(e) => setDraft({ ...draft, url: e.target.value })}
                          />
                        </label>

                        <label className="field">
                          Auth mode
                          <select
                            value={draft.authType}
                            onChange={(e) =>
                              setDraft({
                                ...draft,
                                authType: e.target.value as FormDraft["authType"],
                              })
                            }
                          >
                            <option value="oauth">OAuth 2.1</option>
                            <option value="bearer">Bearer Token</option>
                            <option value="api_key">API Key</option>
                            <option value="none">None</option>
                          </select>
                        </label>

                        {draft.authType === "bearer" && (
                          <label className="field">
                            Bearer token
                            <input
                              type="password"
                              autoComplete="off"
                              placeholder={
                                editingId ? "Saved (leave blank to keep)" : "Paste bearer token"
                              }
                              value={draft.bearerToken}
                              onChange={(e) => setDraft({ ...draft, bearerToken: e.target.value })}
                            />
                          </label>
                        )}

                        {draft.authType === "api_key" && (
                          <div className="field-grid">
                            <label className="field">
                              Send API key in
                              <select
                                value={draft.apiKeyIn}
                                onChange={(e) =>
                                  setDraft({
                                    ...draft,
                                    apiKeyIn: e.target.value as "header" | "query",
                                  })
                                }
                              >
                                <option value="header">Header</option>
                                <option value="query">Query parameter</option>
                              </select>
                            </label>
                            {draft.apiKeyIn === "header" ? (
                              <label className="field">
                                Header name *
                                <input
                                  value={draft.apiKeyHeaderName}
                                  onChange={(e) =>
                                    setDraft({ ...draft, apiKeyHeaderName: e.target.value })
                                  }
                                />
                              </label>
                            ) : (
                              <label className="field">
                                Query parameter *
                                <input
                                  value={draft.apiKeyQueryParam}
                                  onChange={(e) =>
                                    setDraft({ ...draft, apiKeyQueryParam: e.target.value })
                                  }
                                />
                              </label>
                            )}
                            <label className="field">
                              API key
                              <input
                                type="password"
                                autoComplete="off"
                                placeholder={
                                  editingId ? "Saved (leave blank to keep)" : "Paste API key"
                                }
                                value={draft.apiKey}
                                onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
                              />
                            </label>
                          </div>
                        )}

                        {draft.authType === "oauth" && (
                          <div className="field-grid">
                            <label className="field">
                              OAuth client ID (optional)
                              <input
                                placeholder="Auto-discovered via DCR"
                                value={draft.oauthClientId}
                                onChange={(e) =>
                                  setDraft({ ...draft, oauthClientId: e.target.value })
                                }
                              />
                            </label>
                            <label className="field">
                              Scopes (optional)
                              <input
                                placeholder="read write"
                                value={draft.oauthScopes}
                                onChange={(e) =>
                                  setDraft({ ...draft, oauthScopes: e.target.value })
                                }
                              />
                            </label>
                          </div>
                        )}

                        <div>
                          <div className="repeat-title">
                            <strong>Custom Headers</strong>
                            <button
                              type="button"
                              className="button"
                              onClick={() =>
                                setDraft({
                                  ...draft,
                                  headers: [
                                    ...draft.headers,
                                    { key: "", value: "", isSecret: false },
                                  ],
                                })
                              }
                            >
                              <Icon name="plus" /> Add row
                            </button>
                          </div>
                          {draft.headers.map((row, idx) => (
                            <div className="repeat-row" key={idx}>
                              <input
                                placeholder="Header"
                                value={row.key}
                                onChange={(e) => {
                                  const next = [...draft.headers];
                                  next[idx] = { ...row, key: e.target.value };
                                  setDraft({ ...draft, headers: next });
                                }}
                              />
                              <input
                                type={row.isSecret ? "password" : "text"}
                                placeholder={row.hasSecret ? "Saved (leave blank to keep)" : "Value"}
                                value={row.value}
                                onChange={(e) => {
                                  const next = [...draft.headers];
                                  next[idx] = { ...row, value: e.target.value };
                                  setDraft({ ...draft, headers: next });
                                }}
                              />
                              <label className="secret">
                                <input
                                  type="checkbox"
                                  checked={row.isSecret}
                                  onChange={(e) => {
                                    const next = [...draft.headers];
                                    next[idx] = { ...row, isSecret: e.target.checked };
                                    setDraft({ ...draft, headers: next });
                                  }}
                                />
                                Secret
                              </label>
                              <button
                                type="button"
                                className="icon-button danger"
                                aria-label="Remove header"
                                onClick={() =>
                                  setDraft({
                                    ...draft,
                                    headers: draft.headers.filter((_, i) => i !== idx),
                                  })
                                }
                              >
                                <Icon name="trash" />
                              </button>
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </section>

                  <details className="field-block">
                    <summary>Execution controls</summary>
                    <div className="field-grid">
                      <label className="field">
                        Max concurrency (optional)
                        <input
                          type="number"
                          min={1}
                          max={64}
                          placeholder="Unlimited (set 1 for stateful)"
                          value={draft.concurrency}
                          onChange={(e) => setDraft({ ...draft, concurrency: e.target.value })}
                        />
                      </label>
                      <label className="field">
                        Timeout (ms)
                        <input
                          type="number"
                          min={1000}
                          max={600000}
                          value={draft.timeoutMs}
                          onChange={(e) => setDraft({ ...draft, timeoutMs: e.target.value })}
                        />
                      </label>
                    </div>
                  </details>
                </form>
              )}
            </div>

            <footer className="panel-footer">
              <button type="button" className="button" onClick={() => setEditorOpen(false)}>
                Cancel
              </button>
              {(editorTab === "custom" || editingId) && (
                <button
                  type="submit"
                  form="custom-mcp-form"
                  className="button primary"
                  disabled={saving}
                >
                  {saving ? "Saving…" : editingId ? "Save changes" : "Add server"}
                </button>
              )}
            </footer>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteTarget && (
        <div
          className="modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) setDeleteTarget(null);
          }}
        >
          <div className="modal-panel confirm" role="dialog" aria-modal="true">
            <header className="panel-head">
              <div>
                <h2>Delete {deleteTarget.config.name}?</h2>
                <p>Remove this server from ~/metarelay/mcp/servers.yaml.</p>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="Close"
                onClick={() => setDeleteTarget(null)}
              >
                <Icon name="close" />
              </button>
            </header>
            <div className="panel-content">
              <p>
                Its tools will be removed from the local proxy and any stored secrets or OAuth
                tokens for <code>{deleteTarget.config.id}</code> will be cleaned up.
              </p>
            </div>
            <footer className="panel-footer">
              <button type="button" className="button" onClick={() => setDeleteTarget(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="button danger"
                onClick={() => void handleConfirmDelete()}
              >
                Delete server
              </button>
            </footer>
          </div>
        </div>
      )}

      {toast && (
        <div id="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
