import crypto from "node:crypto";
import { Readable } from "node:stream";
import {
  Server,
  WebStandardStreamableHTTPServerTransport,
  isInitializeRequest,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/server";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { UpstreamManager } from "./upstream-manager.js";

export interface BuiltInToolProvider {
  listTools(): Promise<Tool[]> | Tool[];
  canHandle(toolName: string): boolean;
  callTool(
    toolName: string,
    args: Record<string, unknown> | undefined,
  ): Promise<CallToolResult>;
  getInstructions?(): Promise<string> | string;
}

interface ActiveSession {
  server: Server;
  transport: WebStandardStreamableHTTPServerTransport;
}

function fastifyRequestToWebRequest(req: FastifyRequest): Request {
  const host = req.headers.host ?? "127.0.0.1";
  const url = `http://${host}${req.raw.url ?? "/mcp"}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, value);
    }
  }

  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD") {
    return new Request(url, { method, headers });
  }

  let body: string | undefined;
  if (req.body !== undefined) {
    body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  }
  return new Request(url, { method, headers, body });
}

async function sendWebResponseToFastify(
  req: FastifyRequest,
  webRes: Response,
  reply: FastifyReply,
): Promise<void> {
  reply.status(webRes.status);
  webRes.headers.forEach((value, key) => {
    reply.header(key, value);
  });

  if (!webRes.body) {
    await reply.send();
    return;
  }

  const contentType = webRes.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    const nodeStream = Readable.fromWeb(
      webRes.body as unknown as import("node:stream/web").ReadableStream,
    );
    req.raw.once("close", () => {
      nodeStream.destroy();
    });
    await reply.send(nodeStream);
    return;
  }

  const text = await webRes.text();
  await reply.send(text);
}

export class MetaRelayProxyServer {
  private readonly upstreams: UpstreamManager;
  private readonly builtInProviders: BuiltInToolProvider[] = [];
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly onToolsChanged: () => void;

  constructor(upstreams: UpstreamManager) {
    this.upstreams = upstreams;
    this.onToolsChanged = () => {
      void this.notifyToolListChanged();
    };
    this.upstreams.on("toolsChanged", this.onToolsChanged);
  }

  registerBuiltInProvider(provider: BuiltInToolProvider): void {
    this.builtInProviders.push(provider);
  }

  get activeSessionCount(): number {
    return this.sessions.size;
  }

  private async buildInstructions(): Promise<string> {
    const parts: string[] = [
      "MetaRelay unified MCP proxy. Upstream tools are namespaced as <server>__<tool>.",
    ];
    for (const provider of this.builtInProviders) {
      if (provider.getInstructions) {
        const extra = await provider.getInstructions();
        if (extra.trim()) parts.push(extra.trim());
      }
    }
    return parts.join("\n");
  }

  private async createSessionServer(): Promise<Server> {
    const instructions = await this.buildInstructions();
    const server = new Server(
      { name: "metarelay", version: "0.1.0" },
      {
        capabilities: {
          tools: { listChanged: true },
        },
        instructions,
      },
    );

    server.setRequestHandler("tools/list", async () => {
      const tools: Tool[] = [];
      for (const provider of this.builtInProviders) {
        tools.push(...(await provider.listTools()));
      }
      tools.push(...this.upstreams.listAllTools());
      return { tools };
    });

    server.setRequestHandler("tools/call", async (request) => {
      const name = request.params.name;
      const args = request.params.arguments as Record<string, unknown> | undefined;

      for (const provider of this.builtInProviders) {
        if (provider.canHandle(name)) {
          return provider.callTool(name, args);
        }
      }

      try {
        return await this.upstreams.callTool(name, args);
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: err instanceof Error ? err.message : String(err),
            },
          ],
        };
      }
    });

    return server;
  }

  async notifyToolListChanged(): Promise<void> {
    await Promise.allSettled(
      Array.from(this.sessions.values()).map((session) =>
        session.server.sendToolListChanged(),
      ),
    );
  }

  mount(app: FastifyInstance): void {
    const handler = async (req: FastifyRequest, reply: FastifyReply) => {
      const sessionIdHeader = req.headers["mcp-session-id"];
      const sessionId = Array.isArray(sessionIdHeader)
        ? sessionIdHeader[0]
        : sessionIdHeader;

      let session: ActiveSession | undefined;

      if (sessionId && this.sessions.has(sessionId)) {
        session = this.sessions.get(sessionId);
      } else if (!sessionId && req.method === "POST" && isInitializeRequest(req.body)) {
        const server = await this.createSessionServer();
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (sid) => {
            this.sessions.set(sid, { server, transport });
          },
          onsessionclosed: (sid) => {
            this.sessions.delete(sid);
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) {
            this.sessions.delete(transport.sessionId);
          }
        };
        await server.connect(transport);
        session = { server, transport };
      } else {
        reply.status(400).send({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: sessionId
              ? `Unknown or expired MCP session: ${sessionId}`
              : "Bad Request: missing mcp-session-id or initialize payload",
          },
          id: null,
        });
        return;
      }

      const webReq = fastifyRequestToWebRequest(req);
      const webRes = await session!.transport.handleRequest(webReq, {
        parsedBody: req.body,
      });
      await sendWebResponseToFastify(req, webRes, reply);
    };

    app.post("/mcp", handler);
    app.get("/mcp", handler);
    app.delete("/mcp", handler);
  }

  async close(): Promise<void> {
    this.upstreams.off("toolsChanged", this.onToolsChanged);
    await Promise.allSettled(
      Array.from(this.sessions.values()).map(async ({ server, transport }) => {
        try {
          await transport.close();
        } catch {
          // ignore
        }
        try {
          await server.close();
        } catch {
          // ignore
        }
      }),
    );
    this.sessions.clear();
  }
}
