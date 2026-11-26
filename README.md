# MetaRelay

A lightweight, local-first workspace for people who use multiple AI agent harnesses — **Codex**, **Claude Code**, **OpenClaw**, and **Antigravity** — so you can switch agents and keep the same tools, memory, workflows, and conversation continuity.

## Monorepo Architecture

```text
metarelay/
├── config.yml         # Shipped default ports, paths, and harness sync settings
├── cli/               # Cross-platform CLI (Linux/macOS/Windows) + tab completion
│   └── docs/          # Detailed CLI documentation
├── mcp/               # Shared MCP Proxy daemon, OAuth 2.1, harness auto-sync
│   └── docs/          # Detailed MCP Proxy documentation
├── console/           # Web Console (Vite + React + TypeScript, Light/Dark/System)
│   └── docs/          # Detailed Web Console documentation
├── memory/            # 2-tier shared Markdown memory (short-term + fixed long-term templates)
│   └── docs/          # Detailed Memory documentation
├── skills/            # Native harness skill (SKILL.md + global snippet)
│   └── docs/          # Detailed Skills documentation
└── workflows/         # Reusable named Markdown workflows (upcoming)
```

User-authored configuration, secrets, and runtime state live under `~/metarelay/` so they survive repo upgrades.

## Quickstart

```bash
npm install
npm run build:all
npm run start
```

- **Web Console**: `http://127.0.0.1:3847`
- **Unified MCP Endpoint**: `http://127.0.0.1:3847/mcp`
- **Dev mode (Vite HMR)**: run `npm run dev` and `npm run dev:console` (`http://127.0.0.1:5173`)
- **Tests**: `npm test`

## Configuration

Defaults live in [`config.yml`](./config.yml). Override per-user without touching tracked files by creating `~/metarelay/config.yml` or setting `METARELAY_PORT`, `METARELAY_HOST`, `METARELAY_CONSOLE_PORT`, or `METARELAY_HOME`.

When `harnesses.autoSyncOnStart` is enabled, starting MetaRelay automatically updates the `metarelay` MCP URL in all detected harnesses (Codex, Claude Code, OpenClaw, Antigravity) to match the active port.

## Feature Documentation

- [CLI (`cli/docs/README.md`)](./cli/docs/README.md)
- [MCP Proxy (`mcp/docs/README.md`)](./mcp/docs/README.md)
- [Shared Memory (`memory/docs/README.md`)](./memory/docs/README.md)
- [Native Harness Skills (`skills/docs/README.md`)](./skills/docs/README.md)
- [Web Console (`console/docs/README.md`)](./console/docs/README.md)
