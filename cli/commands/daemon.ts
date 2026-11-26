import { parseArgs } from "node:util";
import type { MetaRelayConfig } from "../../mcp/config.js";
import { syncAllHarnesses } from "../../mcp/harness-sync.js";
import { createMetaRelayDaemon } from "../../mcp/server.js";
import { resolveVerifiedBaseUrl, tryDaemonJson, type CliIo } from "../client.js";

export async function runStartCommand(
  args: string[],
  io: CliIo,
): Promise<number> {
  const parsed = parseArgs({
    args,
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

export async function runStatusCommand(
  args: string[],
  ctx: { config: MetaRelayConfig; fetchImpl: typeof fetch; io: CliIo },
): Promise<number> {
  const { config, fetchImpl, io } = ctx;
  const parsed = parseArgs({
    args,
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

  const baseUrl = await resolveVerifiedBaseUrl(config, fetchImpl);
  const res = baseUrl
    ? await tryDaemonJson<Record<string, unknown>>(fetchImpl, baseUrl, "/api/health")
    : { ok: false as const, error: "Daemon not running" };

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
      io.stdout(`MetaRelay daemon: offline\n`);
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

export async function runSyncCommand(
  args: string[],
  ctx: { config: MetaRelayConfig; fetchImpl: typeof fetch; io: CliIo },
): Promise<number> {
  const { config, fetchImpl, io } = ctx;
  const parsed = parseArgs({
    args,
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

  const baseUrl = await resolveVerifiedBaseUrl(config, fetchImpl);
  const mcpUrl = `${baseUrl ?? config.baseUrl}/mcp`;
  const apiRes = baseUrl
    ? await tryDaemonJson<{ harnesses: unknown[] }>(
        fetchImpl,
        baseUrl,
        "/api/harnesses/sync",
        { method: "POST", body: "{}" },
      )
    : { ok: false as const, error: "offline" };

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
