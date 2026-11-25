import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import type { MetaRelayConfig } from "./config.js";
import type { HarnessSyncResult } from "./harness-sync.js";
import { KNOWN_MCP_PRESETS, findPresetById } from "./presets.js";
import {
  upsertServerInputSchema,
  type McpRegistry,
  type ServerConfigView,
} from "./registry.js";
import type { MetaRelayProxyServer } from "./proxy-server.js";
import type { UpstreamManager, UpstreamSnapshot } from "./upstream-manager.js";

export interface ServerSummaryResponse {
  config: ServerConfigView;
  runtime: UpstreamSnapshot;
}

function formatError(err: unknown): { statusCode: number; error: string } {
  if (err instanceof ZodError) {
    return {
      statusCode: 400,
      error: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    };
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/not found|unknown mcp server/i.test(msg)) {
    return { statusCode: 404, error: msg };
  }
  if (/required|invalid/i.test(msg)) {
    return { statusCode: 400, error: msg };
  }
  return { statusCode: 500, error: msg };
}

export function mountManagementApi(
  app: FastifyInstance,
  deps: {
    config: MetaRelayConfig;
    instanceId: string;
    registry: McpRegistry;
    upstreams: UpstreamManager;
    proxy: MetaRelayProxyServer;
    getHarnesses: () => HarnessSyncResult[];
    syncHarnessesNow: () => Promise<HarnessSyncResult[]>;
  },
): void {
  const { config, instanceId, registry, upstreams, proxy, getHarnesses, syncHarnessesNow } = deps;

  app.get("/api/health", async () => {
    const snapshots = await upstreams.getAllSnapshots();
    const connectedServers = snapshots.filter((s) => s.status === "connected").length;
    const totalTools = snapshots.reduce((sum, s) => sum + s.toolCount, 0);
    return {
      ok: true,
      service: "metarelay",
      instanceId,
      version: "0.1.0",
      mcpEndpoint: `${config.baseUrl}/mcp`,
      configFile: config.repoConfigFile,
      serversFile: config.serversFile,
      connectedServers,
      totalServers: snapshots.length,
      totalTools,
      activeSessions: proxy.activeSessionCount,
      harnesses: getHarnesses(),
    };
  });

  app.get("/api/harnesses", async () => ({
    mcpEndpoint: `${config.baseUrl}/mcp`,
    harnesses: getHarnesses(),
  }));

  app.post("/api/harnesses/sync", async () => {
    const harnesses = await syncHarnessesNow();
    return {
      ok: true,
      mcpEndpoint: `${config.baseUrl}/mcp`,
      harnesses,
    };
  });

  app.get("/api/mcp/presets", async () => {
    const configured = registry.getAll();
    return {
      presets: KNOWN_MCP_PRESETS.map((preset) => ({
        ...preset,
        installed: configured.has(preset.id),
      })),
    };
  });

  app.get("/api/mcp/servers", async () => {
    const entries = registry.getAll();
    const items: ServerSummaryResponse[] = [];
    for (const [id, cfg] of entries.entries()) {
      const configView = await registry.toView(id, cfg);
      const runtime = (await upstreams.getSnapshot(id)) ?? {
        id,
        status: cfg.enabled ? "connecting" : "disabled",
        toolCount: 0,
        tools: [],
        hasOAuthTokens: false,
      };
      items.push({ config: configView, runtime });
    }
    return { servers: items };
  });

  app.post("/api/mcp/servers", async (req, reply) => {
    try {
      const body = req.body as Record<string, unknown>;
      // Allow quick-connect shorthand: { presetId: "linear" }
      let payload: Record<string, unknown> = body;
      if (typeof body?.presetId === "string" && !body.transport) {
        const preset = findPresetById(body.presetId);
        if (!preset) {
          return reply.status(404).send({ error: `Unknown preset "${body.presetId}"` });
        }
        payload = {
          id: typeof body.id === "string" ? body.id : preset.id,
          name: typeof body.name === "string" ? body.name : preset.name,
          presetId: preset.id,
          transport: preset.transport,
          url: preset.url,
          auth: {
            type: preset.authType,
            scopes: preset.defaultScopes,
          },
          enabled: true,
        };
      }

      const parsed = upsertServerInputSchema.parse(payload);
      if (registry.get(parsed.id)) {
        return reply
          .status(409)
          .send({ error: `Server "${parsed.id}" already exists. Use PUT to update.` });
      }

      const saved = await registry.upsertFromForm(parsed);
      await upstreams.reconcile(registry.getAll());
      const view = await registry.toView(parsed.id, saved);
      const runtime = await upstreams.getSnapshot(parsed.id);
      return reply.status(201).send({ server: { config: view, runtime } });
    } catch (err) {
      const { statusCode, error } = formatError(err);
      return reply.status(statusCode).send({ error });
    }
  });

  app.put<{ Params: { id: string } }>("/api/mcp/servers/:id", async (req, reply) => {
    try {
      const { id } = req.params;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const parsed = upsertServerInputSchema.parse({ ...body, id });
      const saved = await registry.upsertFromForm(parsed);
      await upstreams.reconcile(registry.getAll());
      const view = await registry.toView(id, saved);
      const runtime = await upstreams.getSnapshot(id);
      return reply.send({ server: { config: view, runtime } });
    } catch (err) {
      const { statusCode, error } = formatError(err);
      return reply.status(statusCode).send({ error });
    }
  });

  app.delete<{ Params: { id: string } }>("/api/mcp/servers/:id", async (req, reply) => {
    const { id } = req.params;
    const existed = await registry.delete(id);
    if (!existed) {
      return reply.status(404).send({ error: `Server "${id}" not found` });
    }
    await upstreams.reconcile(registry.getAll());
    return reply.send({ ok: true, id });
  });

  app.post<{ Params: { id: string } }>(
    "/api/mcp/servers/:id/reconnect",
    async (req, reply) => {
      try {
        const { id } = req.params;
        await upstreams.connectServer(id);
        const runtime = await upstreams.getSnapshot(id);
        return reply.send({ ok: true, runtime });
      } catch (err) {
        const { statusCode, error } = formatError(err);
        return reply.status(statusCode).send({ error });
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/mcp/servers/:id/oauth/start",
    async (req, reply) => {
      try {
        const { id } = req.params;
        const result = await upstreams.startOAuth(id);
        return reply.send(result);
      } catch (err) {
        const { statusCode, error } = formatError(err);
        return reply.status(statusCode).send({ error });
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/mcp/servers/:id/oauth/callback",
    async (req, reply) => {
      const { id } = req.params;
      const url = new URL(req.raw.url ?? "/", config.baseUrl);
      const oauthError = url.searchParams.get("error");
      if (oauthError) {
        const desc = url.searchParams.get("error_description") ?? oauthError;
        return reply
          .status(400)
          .type("text/html")
          .send(
            `<!doctype html><html><body><h2>OAuth Failed</h2><p>${desc}</p><p>You can close this tab and return to MetaRelay.</p></body></html>`,
          );
      }

      try {
        await upstreams.finishOAuth(id, url.searchParams);
        const redirectTarget = `${config.consoleUrl}/?oauth=success&server=${encodeURIComponent(id)}`;
        return reply.redirect(redirectTarget);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply
          .status(400)
          .type("text/html")
          .send(
            `<!doctype html><html><body><h2>OAuth Error</h2><p>${msg}</p></body></html>`,
          );
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/mcp/servers/:id/oauth/revoke",
    async (req, reply) => {
      try {
        const { id } = req.params;
        await upstreams.revokeOAuth(id);
        const runtime = await upstreams.getSnapshot(id);
        return reply.send({ ok: true, runtime });
      } catch (err) {
        const { statusCode, error } = formatError(err);
        return reply.status(statusCode).send({ error });
      }
    },
  );
}
