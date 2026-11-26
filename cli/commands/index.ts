import { resolveConfig } from "../../mcp/config.js";
import { McpRegistry } from "../../mcp/registry.js";
import { SecretStore } from "../../mcp/secrets.js";
import { resolveVerifiedBaseUrl, type CliIo } from "../client.js";
import {
  SUPPORTED_SHELLS,
  completeArgs,
  generateCompletionScript,
} from "../completion.js";
import {
  currentPlatformContext,
  detectShell,
  getCompletionInstallHint,
  openUrlInBrowser,
  type SupportedShell,
} from "../platform.js";
import { runStartCommand, runStatusCommand, runSyncCommand } from "./daemon.js";
import { runMcpCommand } from "./mcp.js";
import { runMemoryCommand } from "./memory.js";

export { resolveVerifiedBaseUrl, type CliIo } from "../client.js";

const HELP_TEXT = `MetaRelay CLI — local-first workspace & unified MCP proxy

Usage:
  metarelay <command> [options]

Commands:
  start                    Start the MetaRelay daemon (Console + /mcp + harness sync)
  status [--json]          Check daemon health, endpoint, servers, and harnesses
  sync [--json]            Sync the metarelay MCP URL into detected harnesses
  mcp list [--json]        List registered MCP servers and live status
  mcp presets [--json]     List built-in known OAuth MCP presets
  mcp add [options]        Add a preset (--preset <id>) or custom MCP server
  mcp remove <id>          Remove a registered MCP server
  mcp reconnect <id>       Reconnect an upstream MCP server
  mcp auth <id>            Start OAuth 2.1 sign-in for a server and open browser
  memory brief [--json]    Show USER.md, short-term highlights, and long-term catalog
  memory list [--json]     List shared memory files and summaries
  memory search <query>    Search shared memories
  memory read <path>       Read a shared memory file
  memory log <text>        Append a timestamped highlight to short-term.md
  completion [shell]       Print shell tab-completion script (bash|zsh|fish|powershell)
  help                     Show this help message
`;

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const fetchImpl = io.fetchImpl ?? fetch;
  const platformCtx = io.platformCtx ?? currentPlatformContext();
  const openBrowser =
    io.openBrowser ?? ((url: string) => openUrlInBrowser(url, platformCtx.platform));
  const config = resolveConfig(io.configOverrides);

  const [cmd, ...rest] = argv;

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    io.stdout(HELP_TEXT);
    return 0;
  }

  if (cmd === "__complete") {
    const completions = await completeArgs(rest, {
      getServerIds: async () => {
        const secrets = new SecretStore(config.secretsFile);
        const registry = new McpRegistry(config.serversFile, secrets);
        try {
          const all = await registry.load();
          return Array.from(all.keys()).sort();
        } catch {
          return [];
        }
      },
    });
    if (completions.length > 0) {
      io.stdout(completions.join("\n") + "\n");
    }
    return 0;
  }

  if (cmd === "completion") {
    const requested = rest[0] as SupportedShell | undefined;
    if (requested === ("--help" as unknown as SupportedShell)) {
      const detected = detectShell(platformCtx);
      const hint = getCompletionInstallHint(detected, platformCtx);
      io.stdout(
        `Usage: metarelay completion [bash|zsh|fish|powershell]\n\nDetected shell: ${detected}\nInstall:\n  ${hint.instructions}\n`,
      );
      return 0;
    }
    const shell = requested ?? detectShell(platformCtx);
    if (!SUPPORTED_SHELLS.includes(shell)) {
      io.stderr(
        `Unsupported shell "${shell}". Supported shells: ${SUPPORTED_SHELLS.join(", ")}\n`,
      );
      return 1;
    }
    io.stdout(generateCompletionScript(shell));
    return 0;
  }

  switch (cmd) {
    case "start":
      return runStartCommand(rest, io);
    case "status":
      return runStatusCommand(rest, { config, fetchImpl, io });
    case "sync":
      return runSyncCommand(rest, { config, fetchImpl, io });
    case "mcp": {
      const baseUrl = await resolveVerifiedBaseUrl(config, fetchImpl);
      return runMcpCommand(rest, { config, baseUrl, fetchImpl, openBrowser, io });
    }
    case "memory":
      return runMemoryCommand(rest, { config, io });
    default:
      io.stderr(`Unknown command "${cmd}". Run "metarelay help" for usage.\n`);
      return 1;
  }
}
