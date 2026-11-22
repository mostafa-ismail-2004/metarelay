# Shared MCP Proxy (`mcp/`)

The `mcp/` module is MetaRelay's local hub-and-spoke MCP proxy daemon. Register each upstream MCP server once — local `stdio`, remote Streamable `http`, or legacy `sse` — and every connected AI harness discovers and invokes all tools through **one unified MCP endpoint** (`http://127.0.0.1:3847/mcp`).

---

## Architecture

```text
Codex / Claude Code / OpenClaw / Antigravity
                 │  (1 Streamable HTTP MCP connection each)
                 ▼
       ┌─────────────────────────┐
       │   MetaRelay Daemon      │  mcp/server.ts (Fastify)
       │  • /mcp                 │  mcp/proxy-server.ts (per-session Server + Transport)
       │  • /api/*               │  mcp/api.ts (UI-first REST + OAuth callback)
       │  • UpstreamManager      │  mcp/upstream-manager.ts (<server>__<tool> router)
       └────────────┬────────────┘
                    │  @modelcontextprotocol/client
        ┌───────────┼───────────┐
        ▼           ▼           ▼
    [stdio]      [http]       [sse]
  (local cmd)  (OAuth/Key)  (legacy)
```

### Module Map

| File | Responsibility |
| --- | --- |
| `mcp/config.ts` | Layered config loader (`config.yml` → `~/metarelay/config.yml` → `METARELAY_*` env vars). |
| `mcp/presets.ts` | Built-in catalog of known official MCP servers for 1-click Quick Connect. |
| `mcp/secrets.ts` | `0600` file-backed secret store (`~/metarelay/.state/secrets.json`) and `${secret:*}` / `${ENV_VAR}` resolver. |
| `mcp/registry.ts` | Zod-validated YAML registry (`~/metarelay/mcp/servers.yaml`), atomic saves, UI secret masking, and debounced `fs.watch` hot-reload. |
| `mcp/oauth.ts` | MCP OAuth 2.1 `OAuthClientProvider` with discovery, Dynamic Client Registration (DCR), PKCE, CSRF state verification, and `0600` token persistence. |
| `mcp/upstream-manager.ts` | Upstream client lifecycle, tool disambiguation (`<serverId>__<toolName>`), single-flight connect locks, per-server concurrency semaphores, and timeouts. |
| `mcp/proxy-server.ts` | Per-session `WebStandardStreamableHTTPServerTransport` + `Server` on `/mcp`, `notifications/tools/list_changed` broadcast, and built-in tool provider hook. |
| `mcp/harness-sync.ts` | Auto-detects Codex, Claude Code, OpenClaw, and Antigravity configs and surgically updates only the `metarelay` MCP URL on boot/port change. |
| `mcp/api.ts` | Structured REST API for the Web Console and OAuth start/callback/revoke flows. |
| `mcp/server.ts` | Fastify daemon entrypoint (DNS rebinding & Origin protection via `@modelcontextprotocol/fastify`). |

---

## Configuration & Data Layout

### Config Precedence (`mcp/config.ts`)
1. Programmatic overrides (used in tests)
2. Environment variables (`METARELAY_HOST`, `METARELAY_PORT`, `METARELAY_CONSOLE_HOST`, `METARELAY_CONSOLE_PORT`, `METARELAY_HOME`, `METARELAY_AUTO_SYNC_HARNESSES`)
3. User override file: `~/metarelay/config.yml`
4. Shipped defaults: repo root `config.yml`

### User Data (`~/metarelay/`)
- `~/metarelay/mcp/servers.yaml` — Canonical upstream registry. Managed via Web Console fillable forms; safe to edit manually in a terminal (hot-reloads automatically).
- `~/metarelay/.state/secrets.json` — API keys, bearer tokens, secret headers, and secret env vars (`0600` permissions). Referenced in YAML as `${secret:<key>}` and never returned raw over `/api`.
- `~/metarelay/.state/oauth/<serverId>.json` — Persisted OAuth 2.1 tokens, DCR client metadata, and PKCE verifier (`0600` permissions).
- `~/metarelay/.state/runtime.json` — Active daemon PID, bound host/port, MCP URL, and harness sync status.

---

## Transports & Authentication

- **`stdio`**: `command`, `args[]`, optional `cwd`, and `env` map (supports `${secret:*}` and `${ENV_VAR}`).
- **`http` (Streamable HTTP)** and **`sse` (legacy SSE)**: `url`, custom `headers` map, and `auth`:
  - `none` — unauthenticated
  - `bearer` — `Authorization: Bearer <token>`
  - `api_key` — custom header (`headerName`, optional `prefix`) or query parameter (`queryParam`)
  - `oauth` — ChatGPT-style OAuth 2.1 (auto-discovery + DCR + PKCE; optional manual `clientId`, `clientSecret`, `scopes`)

---

## Concurrency & Reliability Safeguards

1. **Per-session downstream transports**: Every harness session gets its own `Server` + `WebStandardStreamableHTTPServerTransport` instance on `/mcp`, preventing cross-talk when multiple agents call tools simultaneously.
2. **Single-flight connection locks**: Concurrent calls during startup or reconnect share a single in-flight connection promise so duplicate child processes are never spawned.
3. **Optional per-server `concurrency` limit**: Stateful local servers (e.g., browser automation MCPs) can set `concurrency: 1` to serialize calls cleanly via an internal semaphore while stateless remote servers run fully parallel.
4. **Per-call timeouts & crash isolation**: Each server enforces `timeoutMs` (default `60000`ms); a crashed or unreachable upstream transitions to `error` without affecting other upstreams or the daemon.

---

## Automatic Harness Sync (`mcp/harness-sync.ts`)

When `harnesses.autoSyncOnStart` is `true`, starting the daemon detects installed harnesses and updates only the `metarelay` entry to the active `http://<host>:<port>/mcp` endpoint:

| Harness | Config File | Managed Entry |
| --- | --- | --- |
| **Codex** | `~/.codex/config.toml` | `[mcp_servers.metarelay]` → `url = "<mcpUrl>"` |
| **Claude Code** | `~/.claude.json` | `mcpServers.metarelay` → `{ type: "http", url }` |
| **OpenClaw** | `~/.openclaw/openclaw.json` | `mcp.servers.metarelay` → `{ transport: "streamable-http", url }` |
| **Antigravity** | `~/.gemini/config/mcp_config.json` | `mcpServers.metarelay` → `{ serverUrl }` |

All writes are atomic (`temp file → rename`) and preserve existing file permissions and all other servers/settings.

---

## REST API Reference (`mcp/api.ts`)

| Method & Path | Purpose |
| --- | --- |
| `GET /api/health` | Daemon status, active MCP endpoint, tool/server counts, and harness sync summary. |
| `GET /api/harnesses` | List detected harnesses and sync status. |
| `POST /api/harnesses/sync` | Trigger an immediate harness config sync. |
| `GET /api/mcp/presets` | Built-in catalog of known MCP servers (with `installed` flag). |
| `GET /api/mcp/servers` | All registered servers with masked config views and live runtime status/tools. |
| `POST /api/mcp/servers` | Create a server from structured form JSON or `{ presetId }` Quick Connect shorthand. |
| `PUT /api/mcp/servers/:id` | Update a server (blank secret fields preserve existing stored secrets). |
| `DELETE /api/mcp/servers/:id` | Disconnect, remove from `servers.yaml`, and delete associated secrets. |
| `POST /api/mcp/servers/:id/reconnect` | Reconnect and refresh discovered tools. |
| `POST /api/mcp/servers/:id/oauth/start` | Start OAuth 2.1 PKCE flow; returns `{ authorizeUrl }`. |
| `GET /api/mcp/servers/:id/oauth/callback` | Exchange authorization code, store tokens (`0600`), connect upstream, and redirect to console. |
| `POST /api/mcp/servers/:id/oauth/revoke` | Clear stored OAuth tokens and disconnect. |

---

## Testing

```bash
npm test
```

Runs `mcp/__tests__/proxy.test.ts` covering:
- Tool name disambiguation (`<server>__<tool>`)
- `0600` secret & OAuth token persistence and CSRF state verification
- Registry secret masking & preservation on updates
- `config.yml` default loading and `~/metarelay/config.yml` overrides
- Automatic harness sync across all 4 native config formats (Codex TOML, Claude/OpenClaw/Antigravity JSON)
- End-to-end multi-client MCP proxy with local `stdio` (`concurrency: 1`) + bearer-authenticated remote HTTP MCP servers
