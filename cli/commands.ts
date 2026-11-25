import { parseArgs } from "node:util";
import { resolveConfig, type MetaRelayConfig } from "../mcp/config.js";
import { syncAllHarnesses } from "../mcp/harness-sync.js";
import { KNOWN_MCP_PRESETS, findPresetById } from "../mcp/presets.js";
import { McpRegistry } from "../mcp/registry.js";
import { SecretStore } from "../mcp/secrets.js";
import { createMetaRelayDaemon } from "../mcp/server.js";
import {
  SUPPORTED_SHELLS,
  completeArgs,
  generateCompletionScript,
} from "./completion.js";
import {
  currentPlatformContext,
  detectShell,
  getCompletionInstallHint,
  openUrlInBrowser,
  type PlatformContext,
  type SupportedShell,
} from "./platform.js";

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fetchImpl?: typeof fetch;
  openBrowser?: (url: string) => Promise<void>;
  platformCtx?: PlatformContext;
  configOverrides?: Parameters<typeof resolveConfig>[0];
}

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
  completion [shell]       Print shell tab-completion script (bash|zsh|fish|powershell)
  help                     Show this help message
`;

function parseKeyValuePairs(items: string[] | undefined): Array<{
  key: string;
  value: string;
  isSecret: boolean;
}> {
  const out: Array<{ key: string; value: string; isSecret: boolean }> = [];
  for (const raw of items ?? []) {
    const eq = raw.indexOf("=");
    if (eq <= 0) {
      throw new Error(`Invalid KEY=VALUE pair: "${raw}"`);
    }
    const key = raw.slice(0, eq).trim();
    const value = raw.slice(eq + 1);
    out.push({ key, value, isSecret: false });
  }
  return out;
}

async function tryDaemonJson<T>(
  fetchImpl: typeof fetch,
  config: MetaRelayConfig,
  pathname: string,
  init?: RequestInit,
): Promise<{ ok: true; data: T } | { ok: false; status?: number; error: string }> {
  try {
    const res = await fetchImpl(`${config.baseUrl}${pathname}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    const body = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) {
      return { ok: false, status: res.status, error: body.error ?? `HTTP ${res.status}` };
    }
    return { ok: true, data: body };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

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

  if (cmd === "start") {
    const parsed = parseArgs({
      args: rest,
      options: {
        host: { type: "string" },
        port: { type: "string" },
        "no-sync": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: false,
    });
    if (parsed.values.help) {
      io.stdout("Usage: metarelay start [--host 127.0.0.1] [--port 3847] [--no-sync]\n");
      return 0;
    }
    const daemon = await createMetaRelayDaemon({
      ...io.configOverrides,
      ...(parsed.values.host ? { host: parsed.values.host } : {}),
      ...(parsed.values.port ? { port: Number(parsed.values.port) } : {}),
      ...(parsed.values["no-sync"] ? { syncHarnesses: false } : {}),
    });
    await daemon.start();
    io.stdout(`MetaRelay daemon listening on ${daemon.config.baseUrl}\n`);
    io.stdout(`  Console UI:   ${daemon.config.baseUrl}\n`);
    io.stdout(`  MCP endpoint: ${daemon.config.baseUrl}/mcp\n`);
    io.stdout(`  Registry:     ${daemon.config.serversFile}\n`);

    await new Promise<void>((resolve) => {
      const shutdown = async () => {
        await daemon.stop();
        resolve();
      };
      process.once("SIGINT", () => void shutdown());
      process.once("SIGTERM", () => void shutdown());
    });
    return 0;
  }

  if (cmd === "status") {
    const parsed = parseArgs({
      args: rest,
      options: {
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: false,
    });
    if (parsed.values.help) {
      io.stdout("Usage: metarelay status [--json]\n");
      return 0;
    }
    const res = await tryDaemonJson<Record<string, unknown>>(fetchImpl, config, "/api/health");
    if (!res.ok) {
      if (parsed.values.json) {
        io.stdout(
          JSON.stringify(
            {
              ok: false,
              online: false,
              mcpEndpoint: `${config.baseUrl}/mcp`,
              configFile: config.repoConfigFile,
              error: res.error,
            },
            null,
            2,
          ) + "\n",
        );
      } else {
        io.stdout(`MetaRelay daemon: offline (${config.baseUrl})\n`);
        io.stdout(`Config: ${config.repoConfigFile}\n`);
        io.stdout(`Start with: metarelay start\n`);
      }
      return 1;
    }

    if (parsed.values.json) {
      io.stdout(JSON.stringify(res.data, null, 2) + "\n");
      return 0;
    }
    const h = res.data as {
      mcpEndpoint: string;
      connectedServers: number;
      totalServers: number;
      totalTools: number;
      activeSessions: number;
    };
    io.stdout(`MetaRelay daemon: online\n`);
    io.stdout(`  MCP endpoint: ${h.mcpEndpoint}\n`);
    io.stdout(`  Servers:      ${h.connectedServers}/${h.totalServers} connected\n`);
    io.stdout(`  Tools:        ${h.totalTools} proxied\n`);
    io.stdout(`  Sessions:     ${h.activeSessions} active\n`);
    return 0;
  }

  if (cmd === "sync") {
    const parsed = parseArgs({
      args: rest,
      options: {
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: false,
    });
    if (parsed.values.help) {
      io.stdout("Usage: metarelay sync [--json]\n");
      return 0;
    }
    const mcpUrl = `${config.baseUrl}/mcp`;
    const apiRes = await tryDaemonJson<{ harnesses: unknown[] }>(
      fetchImpl,
      config,
      "/api/harnesses/sync",
      { method: "POST", body: "{}" },
    );
    const harnesses = apiRes.ok ? apiRes.data.harnesses : await syncAllHarnesses(mcpUrl);
    if (parsed.values.json) {
      io.stdout(JSON.stringify({ mcpEndpoint: mcpUrl, harnesses }, null, 2) + "\n");
      return 0;
    }
    io.stdout(`Synced MetaRelay endpoint (${mcpUrl}):\n`);
    for (const h of harnesses as Array<{
      name: string;
      detected: boolean;
      synced: boolean;
      changed: boolean;
      error?: string;
    }>) {
      const state = !h.detected
        ? "not installed"
        : h.error
          ? `error: ${h.error}`
          : h.changed
            ? "updated"
            : "up to date";
      io.stdout(`  - ${h.name}: ${state}\n`);
    }
    return 0;
  }

  if (cmd === "mcp") {
    return runMcpCommand(rest, { config, fetchImpl, openBrowser, io });
  }

  io.stderr(`Unknown command "${cmd}". Run "metarelay help" for usage.\n`);
  return 1;
}

async function runMcpCommand(
  args: string[],
  ctx: {
    config: MetaRelayConfig;
    fetchImpl: typeof fetch;
    openBrowser: (url: string) => Promise<void>;
    io: CliIo;
  },
): Promise<number> {
  const { config, fetchImpl, openBrowser, io } = ctx;
  const [sub, ...rest] = args;

  if (!sub || sub === "--help" || sub === "-h") {
    io.stdout(
      "Usage: metarelay mcp <list|presets|add|remove|reconnect|auth> [options]\n",
    );
    return 0;
  }

  if (sub === "presets") {
    const parsed = parseArgs({
      args: rest,
      options: { json: { type: "boolean", default: false } },
      allowPositionals: false,
    });
    if (parsed.values.json) {
      io.stdout(JSON.stringify({ presets: KNOWN_MCP_PRESETS }, null, 2) + "\n");
      return 0;
    }
    for (const p of KNOWN_MCP_PRESETS) {
      io.stdout(`${p.id.padEnd(14)} ${p.name.padEnd(28)} [${p.authType}] ${p.url}\n`);
    }
    return 0;
  }

  if (sub === "list") {
    const parsed = parseArgs({
      args: rest,
      options: { json: { type: "boolean", default: false } },
      allowPositionals: false,
    });
    const apiRes = await tryDaemonJson<{
      servers: Array<{
        config: { id: string; name: string; transport: string; enabled: boolean };
        runtime: { status: string; toolCount: number };
      }>;
    }>(fetchImpl, config, "/api/mcp/servers");

    if (apiRes.ok) {
      if (parsed.values.json) {
        io.stdout(JSON.stringify(apiRes.data, null, 2) + "\n");
        return 0;
      }
      if (apiRes.data.servers.length === 0) {
        io.stdout("No MCP servers registered.\n");
        return 0;
      }
      for (const s of apiRes.data.servers) {
        io.stdout(
          `${s.config.id.padEnd(18)} ${s.config.transport.padEnd(7)} ${s.runtime.status.padEnd(12)} ${String(s.runtime.toolCount).padStart(3)} tools\n`,
        );
      }
      return 0;
    }

    // Fallback to reading local servers.yaml directly when daemon is offline
    const secrets = new SecretStore(config.secretsFile);
    const registry = new McpRegistry(config.serversFile, secrets);
    const all = await registry.load();
    if (parsed.values.json) {
      const views = [];
      for (const [id, cfg] of all.entries()) {
        views.push(await registry.toView(id, cfg));
      }
      io.stdout(JSON.stringify({ online: false, servers: views }, null, 2) + "\n");
      return 0;
    }
    if (all.size === 0) {
      io.stdout("No MCP servers registered (daemon offline).\n");
      return 0;
    }
    for (const [id, cfg] of all.entries()) {
      io.stdout(`${id.padEnd(18)} ${cfg.transport.padEnd(7)} ${cfg.enabled ? "enabled" : "disabled"} (daemon offline)\n`);
    }
    return 0;
  }

  if (sub === "add") {
    const parsed = parseArgs({
      args: rest,
      options: {
        preset: { type: "string" },
        id: { type: "string" },
        name: { type: "string" },
        transport: { type: "string" },
        url: { type: "string" },
        command: { type: "string" },
        arg: { type: "string", multiple: true },
        cwd: { type: "string" },
        auth: { type: "string" },
        token: { type: "string" },
        "api-key": { type: "string" },
        "header-name": { type: "string" },
        "query-param": { type: "string" },
        header: { type: "string", multiple: true },
        env: { type: "string", multiple: true },
        concurrency: { type: "string" },
        timeout: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: false,
    });
    if (parsed.values.help) {
      io.stdout(
        "Usage:\n  metarelay mcp add --preset <id>\n  metarelay mcp add --id <id> --transport <http|sse|stdio> [--url <url> | --command <cmd>] [options]\n",
      );
      return 0;
    }

    let payload: Record<string, unknown>;
    if (parsed.values.preset) {
      const preset = findPresetById(parsed.values.preset);
      if (!preset) {
        io.stderr(`Unknown preset "${parsed.values.preset}". Run "metarelay mcp presets".\n`);
        return 1;
      }
      payload = {
        id: parsed.values.id ?? preset.id,
        name: parsed.values.name ?? preset.name,
        presetId: preset.id,
        transport: preset.transport,
        url: preset.url,
        auth: { type: preset.authType, scopes: preset.defaultScopes },
        enabled: true,
      };
    } else {
      const id = parsed.values.id;
      const transport = parsed.values.transport ?? (parsed.values.command ? "stdio" : "http");
      if (!id) {
        io.stderr("Missing --id (or use --preset <id>).\n");
        return 1;
      }
      payload = {
        id,
        name: parsed.values.name ?? id,
        transport,
        enabled: true,
        ...(parsed.values.concurrency ? { concurrency: Number(parsed.values.concurrency) } : {}),
        ...(parsed.values.timeout ? { timeoutMs: Number(parsed.values.timeout) } : {}),
      };
      if (transport === "stdio") {
        payload.command = parsed.values.command;
        payload.args = parsed.values.arg ?? [];
        if (parsed.values.cwd) payload.cwd = parsed.values.cwd;
        payload.env = parseKeyValuePairs(parsed.values.env);
      } else {
        payload.url = parsed.values.url;
        payload.headers = parseKeyValuePairs(parsed.values.header);
        const authType = parsed.values.auth ?? "none";
        if (authType === "bearer") {
          payload.auth = { type: "bearer", token: parsed.values.token };
        } else if (authType === "api_key") {
          payload.auth = {
            type: "api_key",
            key: parsed.values["api-key"],
            in: parsed.values["query-param"] ? "query" : "header",
            headerName: parsed.values["header-name"] ?? "X-API-Key",
            queryParam: parsed.values["query-param"] ?? "api_key",
          };
        } else if (authType === "oauth") {
          payload.auth = { type: "oauth" };
        } else {
          payload.auth = { type: "none" };
        }
      }
    }

    const apiRes = await tryDaemonJson(fetchImpl, config, "/api/mcp/servers", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    if (apiRes.ok) {
      io.stdout(`Added MCP server "${String(payload.id)}" (live daemon updated).\n`);
      return 0;
    }
    // If daemon is offline (no HTTP status), write directly to servers.yaml
    if (apiRes.status === undefined) {
      const secrets = new SecretStore(config.secretsFile);
      const registry = new McpRegistry(config.serversFile, secrets);
      await registry.load();
      await registry.upsertFromForm(payload as Parameters<McpRegistry["upsertFromForm"]>[0]);
      io.stdout(`Added MCP server "${String(payload.id)}" to ${config.serversFile}.\n`);
      return 0;
    }
    io.stderr(`Failed to add server: ${apiRes.error}\n`);
    return 1;
  }

  if (sub === "remove") {
    const id = rest[0];
    if (!id) {
      io.stderr("Usage: metarelay mcp remove <id>\n");
      return 1;
    }
    const apiRes = await tryDaemonJson(
      fetchImpl,
      config,
      `/api/mcp/servers/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
    if (apiRes.ok) {
      io.stdout(`Removed MCP server "${id}".\n`);
      return 0;
    }
    if (apiRes.status === undefined) {
      const secrets = new SecretStore(config.secretsFile);
      const registry = new McpRegistry(config.serversFile, secrets);
      await registry.load();
      const removed = await registry.delete(id);
      if (!removed) {
        io.stderr(`Server "${id}" not found.\n`);
        return 1;
      }
      io.stdout(`Removed MCP server "${id}" from ${config.serversFile}.\n`);
      return 0;
    }
    io.stderr(`Failed to remove server: ${apiRes.error}\n`);
    return 1;
  }

  if (sub === "reconnect") {
    const id = rest[0];
    if (!id) {
      io.stderr("Usage: metarelay mcp reconnect <id>\n");
      return 1;
    }
    const apiRes = await tryDaemonJson(
      fetchImpl,
      config,
      `/api/mcp/servers/${encodeURIComponent(id)}/reconnect`,
      { method: "POST", body: "{}" },
    );
    if (!apiRes.ok) {
      io.stderr(`Reconnect failed: ${apiRes.error}\n`);
      return 1;
    }
    io.stdout(`Reconnected "${id}".\n`);
    return 0;
  }

  if (sub === "auth") {
    const parsed = parseArgs({
      args: rest,
      options: { "no-open": { type: "boolean", default: false } },
      allowPositionals: true,
    });
    const id = parsed.positionals[0];
    if (!id) {
      io.stderr("Usage: metarelay mcp auth <id> [--no-open]\n");
      return 1;
    }
    const apiRes = await tryDaemonJson<{ authorizeUrl: string }>(
      fetchImpl,
      config,
      `/api/mcp/servers/${encodeURIComponent(id)}/oauth/start`,
      { method: "POST", body: "{}" },
    );
    if (!apiRes.ok) {
      io.stderr(`OAuth start failed: ${apiRes.error}\n`);
      return 1;
    }
    io.stdout(`Authorize URL: ${apiRes.data.authorizeUrl}\n`);
    if (!parsed.values["no-open"]) {
      await openBrowser(apiRes.data.authorizeUrl);
      io.stdout("Opened browser for OAuth sign-in.\n");
    }
    return 0;
  }

  io.stderr(`Unknown mcp subcommand "${sub}".\n`);
  return 1;
}
