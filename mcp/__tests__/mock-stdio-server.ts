import { Server, type Tool } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

const server = new Server(
  { name: "mock-stdio-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

let activeCalls = 0;
let maxObservedConcurrency = 0;

const TOOLS: Tool[] = [
  {
    name: "echo",
    description: "Echoes text and optional secret env",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string" },
      },
      required: ["message"],
    },
  },
  {
    name: "slow_op",
    description: "Sleeps briefly and reports max observed concurrency",
    inputSchema: {
      type: "object",
      properties: {
        delayMs: { type: "number" },
      },
    },
  },
];

server.setRequestHandler("tools/list", async () => ({ tools: TOOLS }));

server.setRequestHandler("tools/call", async (req) => {
  const { name, arguments: args } = req.params;
  if (name === "echo") {
    const msg = String((args as Record<string, unknown> | undefined)?.message ?? "");
    const secret = process.env.MOCK_SECRET ?? "";
    return {
      content: [{ type: "text", text: `stdio:${msg}:${secret}` }],
    };
  }
  if (name === "slow_op") {
    activeCalls += 1;
    if (activeCalls > maxObservedConcurrency) {
      maxObservedConcurrency = activeCalls;
    }
    const delayMs = Number((args as Record<string, unknown> | undefined)?.delayMs ?? 60);
    await new Promise((r) => setTimeout(r, delayMs));
    const peak = maxObservedConcurrency;
    activeCalls -= 1;
    return {
      content: [{ type: "text", text: JSON.stringify({ peakConcurrency: peak }) }],
    };
  }
  return {
    isError: true,
    content: [{ type: "text", text: `Unknown tool: ${name}` }],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
