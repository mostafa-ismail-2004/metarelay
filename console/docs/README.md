# Web Console (`console/`)

The `console/` workspace is MetaRelay's local-first browser UI, built with **Vite + React + TypeScript** and served directly by the MetaRelay daemon (`http://127.0.0.1:3847`) or via Vite HMR during development (`http://127.0.0.1:5173`).

---

## Structure

```text
console/
├── index.html                   # Pre-paint theme bootstrap script + font links
├── vite.config.ts               # Reads root config.yml (and ~/metarelay/config.yml) for port & proxy
├── src/
│   ├── main.tsx                 # React entry
│   ├── styles.css               # Blue + cool-grey design tokens, dark mode, spring motion system
│   ├── App.tsx                  # Product shell, navigation, theme switcher, MCP Proxy views & modals
│   ├── components/
│   │   ├── ChatView.tsx         # Default Chat & Handoffs landing page
│   │   └── Icons.tsx            # Inline SVG icon primitives
│   └── lib/
│       └── api.ts               # Typed client for /api/health, /api/mcp/*, and OAuth actions
└── docs/
    └── README.md                # This document
```

---

## Views & Capabilities

### 1. Chat & Handoffs (Default Landing Page)
- **Session Bar**: Active conversation title, **+ New Chat**, **Harness** selector (`Codex`, `Claude Code`, `OpenClaw`, `Antigravity`), dynamic **Model** picker per harness, and a live **`<N> proxied tools active ↗`** link to MCP Proxy.
- **Transcript & Empty State**: Multi-harness handoff thread preview with expandable tool-call chips, approval status, handoff dividers, and starter prompts on new chats.
- **Composer**: Auto-growing textarea, `/` Workflows shortcut popover, active harness/model indicator, and Enter-to-send (wired for Phase 2 harness adapters).

### 2. MCP Proxy Management
- **Live Metrics & Registry**: Real-time counts for Connected Servers, Total Proxied Tools, and Attention Needed, plus searchable server table with status pills (`Connected`, `Needs Auth`, `Connecting`, `Error`, `Disabled`), enable/disable toggle, Reconnect, Edit, Delete, and one-click **Connect with OAuth**.
- **Two-Path Server Setup** (zero raw YAML editing):
  1. **Quick Connect (Known Servers)**: Searchable, category-filterable catalog backed by `GET /api/mcp/presets` for 1-click OAuth connection.
  2. **Custom Connection (Fillable Blocks)**: Structured form for `Streamable HTTP`, `Legacy SSE`, or `Local Stdio`; auth mode selector (`OAuth 2.1`, `Bearer Token`, `API Key` in header/query, `None`); dynamic rows for arguments, environment variables, and custom headers with per-row secret masking; and collapsible execution controls (`concurrency`, `timeoutMs`).
- **Tool Inspector Drawer**: Slide-over panel showing every discovered `<server>__<tool>` name, description, and input schema parameters with live filtering.

### 3. Workspace Navigation Shell
- Sidebar navigation for **Chat**, **MCP Proxy**, **Memory**, and **Workflows**, plus connected harness pills and a live **Local daemon** status card with one-click **Copy Endpoint**.

---

## Theme & Motion System

- **Light / Dark / System Switcher**: Compact topbar control persisted in `localStorage` (`metarelay.theme`). Defaults to `System`, automatically detecting the host machine's `prefers-color-scheme` before first paint (zero FOUC) and reacting live to OS theme changes.
- **Palette**: Cobalt blue primary accent paired with layered cool architectural greys in light mode and deep graphite/slate greys in dark mode.
- **Motion**: Spring-curve micro-interactions, staggered list/card entrances, pulsing online status dots, modal pop-ins, and right-edge drawer slides — automatically disabled when `prefers-reduced-motion: reduce` is enabled.

---

## Development & Build

```bash
# Development (with HMR proxying /api and /mcp to the daemon port from config.yml)
npm run dev:console

# Production build (output to console/dist, served automatically by npm run start)
npm --workspace console run build
```
