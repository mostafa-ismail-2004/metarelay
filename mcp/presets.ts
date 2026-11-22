export interface McpServerPreset {
  id: string;
  name: string;
  category: "Engineering" | "Knowledge" | "Design" | "Communication" | "Infrastructure" | "Finance";
  description: string;
  transport: "http" | "sse";
  url: string;
  authType: "oauth" | "bearer" | "api_key";
  defaultScopes?: string[];
  docsUrl: string;
}

export const KNOWN_MCP_PRESETS: readonly McpServerPreset[] = [
  {
    id: "linear",
    name: "Linear",
    category: "Engineering",
    description: "Issues, projects, cycles, and team workflows via Linear's official MCP server.",
    transport: "http",
    url: "https://mcp.linear.app/mcp",
    authType: "oauth",
    docsUrl: "https://linear.app/docs/mcp",
  },
  {
    id: "notion",
    name: "Notion",
    category: "Knowledge",
    description: "Search, read, and update Notion pages and databases with OAuth.",
    transport: "http",
    url: "https://mcp.notion.com/mcp",
    authType: "oauth",
    docsUrl: "https://developers.notion.com/docs/mcp",
  },
  {
    id: "github",
    name: "GitHub",
    category: "Engineering",
    description: "Repositories, issues, pull requests, and code search via GitHub's hosted MCP.",
    transport: "http",
    url: "https://api.githubcopilot.com/mcp/",
    authType: "oauth",
    docsUrl: "https://github.com/github/github-mcp-server",
  },
  {
    id: "figma",
    name: "Figma",
    category: "Design",
    description: "Inspect Figma frames, design tokens, and component metadata.",
    transport: "http",
    url: "https://mcp.figma.com/mcp",
    authType: "oauth",
    docsUrl: "https://help.figma.com/hc/en-us/articles/32132100833559",
  },
  {
    id: "sentry",
    name: "Sentry",
    category: "Engineering",
    description: "Query issues, stack traces, releases, and error telemetry from Sentry.",
    transport: "http",
    url: "https://mcp.sentry.dev/mcp",
    authType: "oauth",
    docsUrl: "https://docs.sentry.io/product/sentry-mcp/",
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    category: "Infrastructure",
    description: "Manage Workers, KV, R2, D1, and Cloudflare logs via official MCP.",
    transport: "http",
    url: "https://bindings.mcp.cloudflare.com/mcp",
    authType: "oauth",
    docsUrl: "https://developers.cloudflare.com/agents/model-context-protocol/",
  },
  {
    id: "stripe",
    name: "Stripe",
    category: "Finance",
    description: "Inspect customers, subscriptions, invoices, and Stripe documentation.",
    transport: "http",
    url: "https://mcp.stripe.com",
    authType: "oauth",
    docsUrl: "https://docs.stripe.com/mcp",
  },
  {
    id: "atlassian",
    name: "Atlassian (Jira & Confluence)",
    category: "Engineering",
    description: "Search and manage Jira issues and Confluence pages via Atlassian's remote MCP.",
    transport: "sse",
    url: "https://mcp.atlassian.com/v1/sse",
    authType: "oauth",
    docsUrl: "https://www.atlassian.com/platform/remote-mcp-server",
  },
  {
    id: "slack",
    name: "Slack",
    category: "Communication",
    description: "Read channels, search threads, and post updates through Slack MCP.",
    transport: "http",
    url: "https://mcp.slack.com/mcp",
    authType: "oauth",
    docsUrl: "https://api.slack.com/",
  },
  {
    id: "clickup",
    name: "ClickUp",
    category: "Engineering",
    description: "Tasks, lists, comments, and workspace hierarchy via ClickUp MCP.",
    transport: "http",
    url: "https://mcp.clickup.com/mcp",
    authType: "oauth",
    docsUrl: "https://developer.clickup.com/",
  },
] as const;

export function findPresetById(id: string): McpServerPreset | undefined {
  return KNOWN_MCP_PRESETS.find((preset) => preset.id === id);
}
