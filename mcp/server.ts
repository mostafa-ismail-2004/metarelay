import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMcpFastifyApp } from "@modelcontextprotocol/fastify";
import type { FastifyInstance } from "fastify";
import { mountMemoryApi } from "../memory/api.js";
import { createMemoryMcpProvider } from "../memory/mcp-provider.js";
import { MemoryStore } from "../memory/store.js";
import { mountSkillsApi } from "../skills/api.js";
import { createSkillsMcpProvider } from "../skills/mcp-provider.js";
import { SkillStore } from "../skills/store.js";
import { mountManagementApi } from "./api.js";
import { resolveConfig, type MetaRelayConfig } from "./config.js";
import {
  removeRuntimeState,
  syncAllHarnesses,
  writeRuntimeState,
  type HarnessSyncResult,
} from "./harness-sync.js";
import { MetaRelayProxyServer } from "./proxy-server.js";
import { McpRegistry } from "./registry.js";
import { SecretStore } from "./secrets.js";
import { UpstreamManager } from "./upstream-manager.js";

export interface MetaRelayDaemon {
  app: FastifyInstance;
  config: MetaRelayConfig;
  registry: McpRegistry;
  secrets: SecretStore;
  upstreams: UpstreamManager;
  proxy: MetaRelayProxyServer;
  memory: MemoryStore;
  skills: SkillStore;
  start(): Promise<string>;
  stop(): Promise<void>;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function mountStaticConsole(app: FastifyInstance, consoleDistDir: string): void {
  if (!fs.existsSync(consoleDistDir)) return;

  app.get("/*", async (req, reply) => {
    const reqPath = (req.raw.url ?? "/").split("?")[0] ?? "/";
    if (reqPath.startsWith("/api/") || reqPath === "/mcp") {
      return reply.status(404).send({ error: "Not found" });
    }
    const safeRel = reqPath === "/" ? "index.html" : reqPath.replace(/^\/+/, "");
    const resolved = path.resolve(consoleDistDir, safeRel);
    const target =
      resolved.startsWith(consoleDistDir) && fs.existsSync(resolved) && fs.statSync(resolved).isFile()
        ? resolved
        : path.join(consoleDistDir, "index.html");

    const ext = path.extname(target);
    const body = await fsp.readFile(target);
    return reply.type(CONTENT_TYPES[ext] ?? "application/octet-stream").send(body);
  });
}

export async function createMetaRelayDaemon(options?: {
  configFile?: string;
  homeDir?: string;
  host?: string;
  port?: number;
  consoleUrl?: string;
  watchRegistry?: boolean;
  serveConsole?: boolean;
  syncHarnesses?: boolean;
}): Promise<MetaRelayDaemon> {
  const config = resolveConfig({
    ...options,
    ...(options?.syncHarnesses !== undefined
      ? { autoSyncHarnesses: options.syncHarnesses }
      : {}),
  });
  const secrets = new SecretStore(config.secretsFile);
  const registry = new McpRegistry(config.serversFile, secrets);
  await registry.load();

  const upstreams = new UpstreamManager(config, registry, secrets);
  const proxy = new MetaRelayProxyServer(upstreams);
  const memory = new MemoryStore(config.memoryDir);
  const skills = new SkillStore(config.skillsDir);
  proxy.registerBuiltInProvider(createMemoryMcpProvider(memory));
  proxy.registerBuiltInProvider(createSkillsMcpProvider(skills));
  const instanceId = crypto.randomUUID();
  let lastHarnessSync: HarnessSyncResult[] = [];

  const app = createMcpFastifyApp({
    host: config.host,
  });

  proxy.mount(app);
  mountMemoryApi(app, memory);
  mountSkillsApi(app, skills);
  mountManagementApi(app, {
    config,
    instanceId,
    registry,
    upstreams,
    proxy,
    getHarnesses: () => lastHarnessSync,
    syncHarnessesNow: async () => {
      lastHarnessSync = await syncAllHarnesses(`${config.baseUrl}/mcp`);
      await writeRuntimeState(config.runtimeFile, {
        instanceId,
        pid: process.pid,
        host: config.host,
        port: config.port,
        mcpEndpoint: `${config.baseUrl}/mcp`,
        harnesses: lastHarnessSync,
      });
      return lastHarnessSync;
    },
  });

  if (options?.serveConsole !== false) {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(currentDir, "..", "..");
    mountStaticConsole(app, path.join(repoRoot, "console", "dist"));
  }

  let started = false;

  return {
    app,
    config,
    registry,
    secrets,
    upstreams,
    proxy,
    memory,
    skills,
    async start(): Promise<string> {
      if (started) return config.baseUrl;
      const address = await app.listen({ host: config.host, port: config.port });
      const addrObj = app.server.address();
      if (addrObj && typeof addrObj === "object") {
        config.port = addrObj.port;
        config.baseUrl = `http://${config.host}:${addrObj.port}`;
      }
      started = true;
      await upstreams.syncAll();
      if (config.autoSyncHarnesses) {
        lastHarnessSync = await syncAllHarnesses(`${config.baseUrl}/mcp`);
      }
      await writeRuntimeState(config.runtimeFile, {
        instanceId,
        pid: process.pid,
        host: config.host,
        port: config.port,
        mcpEndpoint: `${config.baseUrl}/mcp`,
        harnesses: lastHarnessSync,
      });
      if (options?.watchRegistry !== false) {
        await registry.startWatching();
      }
      return address;
    },
    async stop(): Promise<void> {
      registry.stopWatching();
      await proxy.close();
      await upstreams.close();
      app.server.closeIdleConnections?.();
      app.server.closeAllConnections?.();
      await app.close();
      await removeRuntimeState(config.runtimeFile);
      started = false;
    },
  };
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  const daemon = await createMetaRelayDaemon();
  await daemon.start();
  console.log(`MetaRelay daemon listening on ${daemon.config.baseUrl}`);
  console.log(`  MCP endpoint: ${daemon.config.baseUrl}/mcp`);
  console.log(`  Registry:     ${daemon.config.serversFile}`);

  const shutdown = async () => {
    await daemon.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
