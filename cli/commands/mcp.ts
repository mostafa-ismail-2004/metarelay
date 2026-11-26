import { parseArgs } from "node:util";
import type { MetaRelayConfig } from "../../mcp/config.js";
import { KNOWN_MCP_PRESETS, findPresetById } from "../../mcp/presets.js";
import { McpRegistry } from "../../mcp/registry.js";
import { SecretStore } from "../../mcp/secrets.js";
import { tryDaemonJson, type CliIo } from "../client.js";

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

export async function runMcpCommand(
  args: string[],
  ctx: {
    config: MetaRelayConfig;
    baseUrl: string | null;
    fetchImpl: typeof fetch;
    openBrowser: (url: string) => Promise<void>;
    io: CliIo;
  },
): Promise<number> {
  const { config, baseUrl, fetchImpl, openBrowser, io } = ctx;
  const [sub, ...rest] = args;

  if (!sub || sub === "--help" || sub === "-h") {
    io.stdout("Usage: metarelay mcp <list|presets|add|remove|reconnect|auth> [options]\n");
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
    const apiRes = baseUrl
      ? await tryDaemonJson<{
          servers: Array<{
            config: { id: string; name: string; transport: string; enabled: boolean };
            runtime: { status: string; toolCount: number };
          }>;
        }>(fetchImpl, baseUrl, "/api/mcp/servers")
      : { ok: false as const, error: "offline" };

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
      io.stdout(
        `${id.padEnd(18)} ${cfg.transport.padEnd(7)} ${cfg.enabled ? "enabled" : "disabled"} (daemon offline)\n`,
      );
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

    if (baseUrl) {
      const apiRes = await tryDaemonJson(fetchImpl, baseUrl, "/api/mcp/servers", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      if (apiRes.ok) {
        io.stdout(`Added MCP server "${String(payload.id)}" (live daemon updated).\n`);
        return 0;
      }
      io.stderr(`Failed to add server: ${apiRes.error}\n`);
      return 1;
    }

    const secrets = new SecretStore(config.secretsFile);
    const registry = new McpRegistry(config.serversFile, secrets);
    await registry.load();
    await registry.upsertFromForm(payload as Parameters<McpRegistry["upsertFromForm"]>[0]);
    io.stdout(`Added MCP server "${String(payload.id)}" to ${config.serversFile}.\n`);
    return 0;
  }

  if (sub === "remove") {
    const id = rest[0];
    if (!id) {
      io.stderr("Usage: metarelay mcp remove <id>\n");
      return 1;
    }
    if (baseUrl) {
      const apiRes = await tryDaemonJson(
        fetchImpl,
        baseUrl,
        `/api/mcp/servers/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
      if (apiRes.ok) {
        io.stdout(`Removed MCP server "${id}".\n`);
        return 0;
      }
      io.stderr(`Failed to remove server: ${apiRes.error}\n`);
      return 1;
    }

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

  if (sub === "reconnect") {
    const id = rest[0];
    if (!id) {
      io.stderr("Usage: metarelay mcp reconnect <id>\n");
      return 1;
    }
    if (!baseUrl) {
      io.stderr("MetaRelay daemon is not running. Start it with: metarelay start\n");
      return 1;
    }
    const apiRes = await tryDaemonJson(
      fetchImpl,
      baseUrl,
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
    if (!baseUrl) {
      io.stderr("MetaRelay daemon is not running. Start it with: metarelay start\n");
      return 1;
    }
    const apiRes = await tryDaemonJson<{ authorizeUrl: string }>(
      fetchImpl,
      baseUrl,
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
