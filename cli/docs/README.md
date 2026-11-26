# MetaRelay CLI (`cli/`)

The `cli/` module provides the cross-platform `metarelay` terminal workflow for **Linux**, **macOS**, and **Windows**, including dynamic tab completion for `bash`, `zsh`, `fish`, and `powershell`.

---

## Module Map

| File | Responsibility |
| --- | --- |
| `cli/index.ts` | Executable entrypoint (`bin.metarelay` in `package.json`). |
| `cli/client.ts` | Shared HTTP client + verified `runtime.json` daemon discovery (`resolveVerifiedBaseUrl`). |
| `cli/commands/index.ts` | Top-level CLI router (`help`, `completion`, `__complete`, and command dispatch). |
| `cli/commands/daemon.ts` | Daemon lifecycle commands (`start`, `status`, `sync`). |
| `cli/commands/mcp.ts` | MCP proxy commands (`mcp list`, `presets`, `add`, `remove`, `reconnect`, `auth`). |
| `cli/commands/memory.ts` | Full shared memory CLI (`brief`, `templates`, `list`, `search`, `read`, `write`, `delete`, `log`, `clear-short-term`). |
| `cli/commands/skills.ts` | Full shared skills CLI (`list`, `search`, `load`, `read-file`, `write`, `delete`, `import`). |
| `cli/completion.ts` | Dynamic tab-completion engine (`completeArgs`) and native script generators for `bash`, `zsh`, `fish`, and `powershell`. |
| `cli/platform.ts` | OS-specific helpers for Linux, macOS (`darwin`), and Windows (`win32`): browser launch, shell detection, completion profile paths, and home path resolution. |

---

## Commands

```bash
# Start daemon (Console UI + /mcp + automatic harness sync)
metarelay start [--host 127.0.0.1] [--port 3847] [--no-sync]

# Check daemon health, endpoint, server/tool counts
metarelay status [--json]

# Sync the active metarelay MCP URL across Codex, Claude Code, OpenClaw, and Antigravity
metarelay sync [--json]

# Manage MCP servers
metarelay mcp list [--json]
metarelay mcp presets [--json]
metarelay mcp add --preset linear
metarelay mcp add --id my-api --transport http --url https://example.com/mcp --auth bearer --token "$TOKEN"
metarelay mcp add --id local-tool --transport stdio --command npx --arg -y --arg @example/mcp --concurrency 1
metarelay mcp reconnect <id>
metarelay mcp auth <id> [--no-open]
metarelay mcp remove <id>
```

When the daemon is running, `mcp` commands hit the live REST API (`/api/mcp/*`); when offline, `list`, `add`, and `remove` fall back directly to `~/metarelay/mcp/servers.yaml`.

---

## Cross-Platform Support

| Capability | Linux | macOS (`darwin`) | Windows (`win32`) |
| --- | --- | --- | --- |
| Browser launch (OAuth) | `xdg-open <url>` | `open <url>` | `cmd /c start "" <escaped-url>` |
| Default shell detection | `$SHELL` → `bash` | `$SHELL` → `zsh` | `powershell` |
| Completion profile path | `~/.bashrc` / `~/.config/fish/completions/metarelay.fish` | `~/.zshrc` / `~/.bash_profile` | `%USERPROFILE%\Documents\PowerShell\Microsoft.PowerShell_profile.ps1` |

---

## Tab Completion

Dynamic tab completion resolves commands, subcommands, flags, built-in `--preset` names, `--transport` / `--auth` enums, and **live server IDs** from `~/metarelay/mcp/servers.yaml`.

```bash
# Bash (Linux / macOS)
eval "$(metarelay completion bash)"

# Zsh (macOS / Linux)
eval "$(metarelay completion zsh)"

# Fish
metarelay completion fish > ~/.config/fish/completions/metarelay.fish
```

```powershell
# PowerShell (Windows)
metarelay completion powershell | Out-File -Append -Encoding utf8 $PROFILE
```

---

## Testing

```bash
npm test
```

`cli/__tests__/cli.test.ts` runs dedicated unit tests for **Linux**, **macOS**, and **Windows** platform behavior, URL protocol validation & Windows `&` escaping, dynamic tab completion, completion script generation for all 4 shells, and CLI command flows.
