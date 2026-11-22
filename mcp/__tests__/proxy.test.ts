import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpFastifyApp } from "@modelcontextprotocol/fastify";
import {
  Server,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { resolveConfig } from "../config.js";
import { syncAllHarnesses } from "../harness-sync.js";
import { MetaRelayOAuthProvider } from "../oauth.js";
import { McpRegistry } from "../registry.js";
import { SecretStore } from "../secrets.js";
import { createMetaRelayDaemon } from "../server.js";
import { namespaceToolName, splitNamespacedToolName } from "../upstream-manager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_STDIO_SCRIPT = path.join(__dirname, "mock-stdio-server.js");

async function makeTempHome(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "metarelay-test-"));
}

/**
 * Spins up an in-process mock remote HTTP MCP server that enforces a bearer token or API key.
 */
async function startMockRemoteMcp(expectedAuth: {
  headerName: string;
  headerValue: string;
}): Promise<{ url: string; close: () => Promise<void> }> {
  const app = createMcpFastifyApp({ host: "127.0.0.1" });

  app.post("/mcp", async (req, reply) => {
    const actual = req.headers[expectedAuth.headerName.toLowerCase()];
    if (actual !== expectedAuth.headerValue) {
      return reply.status(401).send({ error: "Unauthorized" });
    }

    const server = new Server(
      { name: "mock-remote-mcp", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler("tools/list", async () => ({
      tools: [
        {
          name: "ping",
          description: "Remote ping tool",
          inputSchema: {
            type: "object",
            properties: {
              tag: { type: "string" },
            },
          },
        },
      ],
    }));
    server.setRequestHandler("tools/call", async (callReq) => {
      if (callReq.params.name === "ping") {
        const tag = String((callReq.params.arguments as Record<string, unknown> | undefined)?.tag ?? "ok");
        return { content: [{ type: "text", text: `remote-pong:${tag}` }] };
      }
      return { isError: true, content: [{ type: "text", text: "Unknown tool" }] };
    });

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);

    const webReq = new Request(`http://${req.headers.host ?? "127.0.0.1"}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(req.body),
    });
    const webRes = await transport.handleRequest(webReq, { parsedBody: req.body });
    reply.status(webRes.status);
    webRes.headers.forEach((v, k) => reply.header(k, v));
    return reply.send(await webRes.text());
  });

  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address();
  assert(addr && typeof addr === "object");
  return {
    url: `http://127.0.0.1:${addr.port}/mcp`,
    close: async () => {
      await app.close();
    },
  };
}

test("tool name disambiguation round-trips cleanly", () => {
  const ns = namespaceToolName("linear", "create_issue");
  assert.equal(ns, "linear__create_issue");
  assert.deepEqual(splitNamespacedToolName(ns), {
    serverId: "linear",
    toolName: "create_issue",
  });
  assert.equal(splitNamespacedToolName("no_separator"), null);
});

test("SecretStore enforces 0600 permissions and resolves ${secret:*} + ${ENV_VAR}", async () => {
  const home = await makeTempHome();
  try {
    const file = path.join(home, ".state", "secrets.json");
    const store = new SecretStore(file);
    await store.set("mcp.demo.token", "super-secret-value");

    const stat = await fs.stat(file);
    assert.equal(stat.mode & 0o777, 0o600);

    const resolved = await store.resolveString(
      "Bearer ${secret:mcp.demo.token}:${TEST_ENV_VAL}",
      { TEST_ENV_VAL: "from-env" },
    );
    assert.equal(resolved, "Bearer super-secret-value:from-env");
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("OAuth provider persists tokens with 0600 permissions and verifies CSRF state", async () => {
  const home = await makeTempHome();
  try {
    const oauthDir = path.join(home, ".state", "oauth");
    const provider = new MetaRelayOAuthProvider({
      serverId: "linear",
      oauthDir,
      redirectUrl: "http://127.0.0.1:3847/api/mcp/servers/linear/oauth/callback",
    });

    const st = await provider.state();
    assert.equal(await provider.verifyState(st), true);
    assert.equal(await provider.verifyState("wrong-state"), false);

    await provider.saveTokens(
      { access_token: "tok-123", token_type: "Bearer" },
      { issuer: "https://linear.app" },
    );
    assert.equal(await provider.hasTokens(), true);
    assert.equal((await provider.tokens())?.access_token, "tok-123");

    const stat = await fs.stat(path.join(oauthDir, "linear.json"));
    assert.equal(stat.mode & 0o777, 0o600);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("Registry masks secrets in UI view and preserves them on update", async () => {
  const home = await makeTempHome();
  try {
    const secrets = new SecretStore(path.join(home, ".state", "secrets.json"));
    const registry = new McpRegistry(path.join(home, "mcp", "servers.yaml"), secrets);

    await registry.upsertFromForm({
      id: "custom-api",
      name: "Custom API",
      transport: "http",
      url: "https://example.com/mcp",
      enabled: true,
      timeoutMs: 30_000,
      auth: {
        type: "api_key",
        key: "raw-api-key-999",
        in: "header",
        headerName: "X-Custom-Key",
      },
      headers: [{ key: "X-Secret-Header", value: "shh", isSecret: true }],
    });

    const yamlText = await fs.readFile(path.join(home, "mcp", "servers.yaml"), "utf8");
    assert.equal(yamlText.includes("raw-api-key-999"), false);
    assert.equal(yamlText.includes("shh"), false);

    const cfg = registry.get("custom-api");
    assert(cfg);
    const view = await registry.toView("custom-api", cfg);
    assert.equal(view.auth?.hasSecret, true);
    assert.equal(view.headers?.[0]?.value, "");
    assert.equal(view.headers?.[0]?.hasSecret, true);

    // Updating without re-entering secret keeps existing secret intact
    await registry.upsertFromForm({
      id: "custom-api",
      name: "Custom API Renamed",
      transport: "http",
      url: "https://example.com/mcp",
      enabled: true,
      timeoutMs: 30_000,
      auth: {
        type: "api_key",
        in: "header",
        headerName: "X-Custom-Key",
      },
      headers: [{ key: "X-Secret-Header", value: "", isSecret: true }],
    });

    assert.equal(await secrets.get("mcp.custom-api.auth.api_key"), "raw-api-key-999");
    assert.equal(await secrets.get("mcp.custom-api.header.x-secret-header"), "shh");
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("End-to-end MCP Proxy: merges stdio + remote HTTP upstreams, handles concurrent sessions & concurrency: 1", async () => {
  const home = await makeTempHome();
  const remote = await startMockRemoteMcp({
    headerName: "Authorization",
    headerValue: "Bearer remote-secret-42",
  });
  const daemon = await createMetaRelayDaemon({
    homeDir: home,
    port: 0,
    watchRegistry: false,
    serveConsole: false,
    syncHarnesses: false,
  });

  try {
    await daemon.start();

    // Register stdio server via REST API (with secret env + concurrency: 1)
    const stdioRes = await fetch(`${daemon.config.baseUrl}/api/mcp/servers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "local-demo",
        name: "Local Demo",
        transport: "stdio",
        command: process.execPath,
        args: [MOCK_STDIO_SCRIPT],
        concurrency: 1,
        env: [{ key: "MOCK_SECRET", value: "xyz123", isSecret: true }],
      }),
    });
    assert.equal(stdioRes.status, 201, await stdioRes.clone().text());

    // Register remote HTTP server with bearer token via REST API
    const remoteRes = await fetch(`${daemon.config.baseUrl}/api/mcp/servers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "remote-demo",
        name: "Remote Demo",
        transport: "http",
        url: remote.url,
        auth: { type: "bearer", token: "remote-secret-42" },
      }),
    });
    assert.equal(remoteRes.status, 201, await remoteRes.clone().text());

    // Verify /api/health & /api/mcp/presets
    const health = (await (await fetch(`${daemon.config.baseUrl}/api/health`)).json()) as {
      ok: boolean;
      connectedServers: number;
      totalTools: number;
    };
    assert.equal(health.ok, true);
    assert.equal(health.connectedServers, 2);
    assert.equal(health.totalTools, 3);

    const presetsRes = (await (
      await fetch(`${daemon.config.baseUrl}/api/mcp/presets`)
    ).json()) as { presets: Array<{ id: string }> };
    assert.ok(presetsRes.presets.some((p) => p.id === "linear"));

    // Connect TWO independent MCP clients (simulating Codex + OpenClaw simultaneously)
    const mcpUrl = new URL(`${daemon.config.baseUrl}/mcp`);
    const clientA = new Client({ name: "codex-sim", version: "1.0.0" }, { capabilities: {} });
    const clientB = new Client({ name: "openclaw-sim", version: "1.0.0" }, { capabilities: {} });
    const transportA = new StreamableHTTPClientTransport(mcpUrl);
    const transportB = new StreamableHTTPClientTransport(mcpUrl);

    await Promise.all([clientA.connect(transportA), clientB.connect(transportB)]);

    const listed = await clientA.listTools();
    const names = listed.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["local-demo__echo", "local-demo__slow_op", "remote-demo__ping"]);

    // Fire concurrent calls from both harnesses simultaneously
    const [echoRes, pingRes, slow1, slow2] = await Promise.all([
      clientA.callTool({ name: "local-demo__echo", arguments: { message: "hello" } }),
      clientB.callTool({ name: "remote-demo__ping", arguments: { tag: "multi" } }),
      clientA.callTool({ name: "local-demo__slow_op", arguments: { delayMs: 50 } }),
      clientB.callTool({ name: "local-demo__slow_op", arguments: { delayMs: 50 } }),
    ]);

    const echoText = (echoRes.content as Array<{ text: string }>)[0]?.text;
    const pingText = (pingRes.content as Array<{ text: string }>)[0]?.text;
    assert.equal(echoText, "stdio:hello:xyz123");
    assert.equal(pingText, "remote-pong:multi");

    // Because local-demo has concurrency: 1, peak observed concurrency must stay 1
    const slow2Parsed = JSON.parse(
      (slow2.content as Array<{ text: string }>)[0]?.text ?? "{}",
    ) as { peakConcurrency: number };
    assert.equal(slow2Parsed.peakConcurrency, 1);

    await Promise.all([clientA.close(), clientB.close()]);
  } finally {
    await daemon.stop();
    await remote.close();
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("config.yml loads defaults and user ~/metarelay/config.yml overrides them", async () => {
  const home = await makeTempHome();
  try {
    const defaultCfg = resolveConfig({ homeDir: home });
    assert.equal(defaultCfg.host, "127.0.0.1");
    assert.equal(defaultCfg.port, 3847);
    assert.equal(defaultCfg.consolePort, 5173);

    await fs.writeFile(
      path.join(home, "config.yml"),
      "server:\n  port: 4999\nconsole:\n  port: 6173\n",
      "utf8",
    );
    const overridden = resolveConfig({ homeDir: home });
    assert.equal(overridden.port, 4999);
    assert.equal(overridden.baseUrl, "http://127.0.0.1:4999");
    assert.equal(overridden.consolePort, 6173);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("syncAllHarnesses updates metarelay MCP URL across Codex, Claude, OpenClaw, and Antigravity without clobbering existing entries", async () => {
  const fakeHome = await makeTempHome();
  try {
    const paths = {
      codexConfig: path.join(fakeHome, ".codex", "config.toml"),
      claudeConfig: path.join(fakeHome, ".claude.json"),
      openclawConfig: path.join(fakeHome, ".openclaw", "openclaw.json"),
      antigravityConfig: path.join(fakeHome, ".gemini", "config", "mcp_config.json"),
    };

    await fs.mkdir(path.dirname(paths.codexConfig), { recursive: true });
    await fs.mkdir(path.dirname(paths.openclawConfig), { recursive: true });
    await fs.mkdir(path.dirname(paths.antigravityConfig), { recursive: true });

    await fs.writeFile(
      paths.codexConfig,
      '[mcp_servers.existing]\ncommand = "echo"\n',
      "utf8",
    );
    await fs.writeFile(
      paths.claudeConfig,
      JSON.stringify({ mcpServers: { existing: { command: "echo" } } }, null, 2),
      "utf8",
    );
    await fs.writeFile(
      paths.openclawConfig,
      JSON.stringify({ mcp: { servers: { existing: { command: "echo" } } } }, null, 2),
      "utf8",
    );
    await fs.writeFile(
      paths.antigravityConfig,
      JSON.stringify({ mcpServers: { existing: { command: "echo" } } }, null, 2),
      "utf8",
    );

    const first = await syncAllHarnesses("http://127.0.0.1:4567/mcp", paths);
    assert.equal(first.every((r) => r.detected && r.synced && r.changed), true);

    // Second sync with same URL is a no-op
    const second = await syncAllHarnesses("http://127.0.0.1:4567/mcp", paths);
    assert.equal(second.every((r) => r.synced && !r.changed), true);

    // Port change updates every harness while keeping existing servers intact
    const third = await syncAllHarnesses("http://127.0.0.1:5678/mcp", paths);
    assert.equal(third.every((r) => r.synced && r.changed), true);

    const codexText = await fs.readFile(paths.codexConfig, "utf8");
    assert.match(codexText, /\[mcp_servers\.existing\]/);
    assert.match(codexText, /\[mcp_servers\.metarelay\]\nurl = "http:\/\/127\.0\.0\.1:5678\/mcp"/);

    const claudeJson = JSON.parse(await fs.readFile(paths.claudeConfig, "utf8"));
    assert.equal(claudeJson.mcpServers.existing.command, "echo");
    assert.deepEqual(claudeJson.mcpServers.metarelay, {
      type: "http",
      url: "http://127.0.0.1:5678/mcp",
    });

    const openclawJson = JSON.parse(await fs.readFile(paths.openclawConfig, "utf8"));
    assert.equal(openclawJson.mcp.servers.existing.command, "echo");
    assert.deepEqual(openclawJson.mcp.servers.metarelay, {
      transport: "streamable-http",
      url: "http://127.0.0.1:5678/mcp",
    });

    const agyJson = JSON.parse(await fs.readFile(paths.antigravityConfig, "utf8"));
    assert.equal(agyJson.mcpServers.existing.command, "echo");
    assert.deepEqual(agyJson.mcpServers.metarelay, {
      serverUrl: "http://127.0.0.1:5678/mcp",
    });
  } finally {
    await fs.rm(fakeHome, { recursive: true, force: true });
  }
});
