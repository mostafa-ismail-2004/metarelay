import { resolveConfig } from "../../mcp/config.js";
import { McpRegistry } from "../../mcp/registry.js";
import { SecretStore } from "../../mcp/secrets.js";
import { MemoryStore } from "../../memory/store.js";
import { SkillStore } from "../../skills/store.js";
import { resolveVerifiedBaseUrl, type CliIo } from "../client.js";
import {
  SUPPORTED_SHELLS,
  completeArgs,
  generateCompletionScript,
} from "../completion.js";
import { formatCliError } from "../errors.js";
import { renderHelp } from "../help.js";
import {
  currentPlatformContext,
  detectShell,
  openUrlInBrowser,
  type SupportedShell,
} from "../platform.js";
import { runStartCommand, runStatusCommand, runSyncCommand } from "./daemon.js";
import { runMcpCommand } from "./mcp.js";
import { runMemoryCommand } from "./memory.js";
import { runSkillsCommand } from "./skills.js";

export { resolveVerifiedBaseUrl, type CliIo } from "../client.js";

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  try {
    return await dispatchCli(argv, io);
  } catch (err) {
    io.stderr(`Error: ${formatCliError(err)}\n`);
    return 1;
  }
}

async function dispatchCli(argv: string[], io: CliIo): Promise<number> {
  const fetchImpl = io.fetchImpl ?? fetch;
  const platformCtx = io.platformCtx ?? currentPlatformContext();
  const openBrowser =
    io.openBrowser ?? ((url: string) => openUrlInBrowser(url, platformCtx.platform));
  const config = resolveConfig(io.configOverrides);

  const [cmd, ...rest] = argv;

  if (!cmd) {
    io.stdout(renderHelp([])!);
    return 0;
  }

  if (cmd === "help") {
    const rendered = renderHelp(rest);
    if (!rendered) {
      io.stderr(`Unknown command "${rest.join(" ")}". Run "metarelay --help" for usage.\n`);
      return 1;
    }
    io.stdout(rendered);
    return 0;
  }

  // Intercept --help / -h at any depth in the command tree (except __complete)
  if (cmd !== "__complete" && (argv.includes("--help") || argv.includes("-h"))) {
    const pathTokens = argv.filter((token) => token !== "--help" && token !== "-h");
    const rendered = renderHelp(pathTokens);
    if (!rendered) {
      io.stderr(`Unknown command "${pathTokens.join(" ")}". Run "metarelay --help" for usage.\n`);
      return 1;
    }
    io.stdout(rendered);
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
      getSkillNames: async () => {
        try {
          const store = new SkillStore(config.skillsDir);
          const list = await store.list();
          return list.map((s) => s.name);
        } catch {
          return [];
        }
      },
      getMemoryPaths: async () => {
        try {
          const store = new MemoryStore(config.memoryDir);
          const list = await store.list({ includeShortTerm: true });
          return list.map((m) => m.path);
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
    case "skills":
      return runSkillsCommand(rest, { config, io });
    default:
      io.stderr(`Unknown command "${cmd}". Run "metarelay --help" for usage.\n`);
      return 1;
  }
}
