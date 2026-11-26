import type { CallToolResult, Tool } from "@modelcontextprotocol/server";
import type { BuiltInToolProvider } from "../mcp/proxy-server.js";
import { MemoryConflictError, type MemoryStore } from "./store.js";
import {
  LONG_TERM_TYPES,
  MEMORY_TYPES,
  type LongTermMemoryType,
  type MemoryType,
} from "./templates.js";

const MEMORY_TOOLS: Tool[] = [
  {
    name: "memory_brief",
    description:
      "Load USER.md, short-term.md, and a compact summary catalog (path, type, title, summary, tags) of all long-term memories in one call. Call this at the start of non-trivial tasks or harness handoffs.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "memory_list",
    description:
      "List shared Markdown memories with their frontmatter title, summary, tags, and revision (without full bodies).",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: [...MEMORY_TYPES] },
        tag: { type: "string" },
        includeShortTerm: { type: "boolean" },
      },
    },
  },
  {
    name: "memory_search",
    description:
      "Weighted lexical search across shared memory titles, summaries, tags, headings, and bodies.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        type: { type: "string", enum: [...MEMORY_TYPES] },
        tag: { type: "string" },
        limit: { type: "number" },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_read",
    description:
      "Read a specific shared memory file by relative path (e.g. 'USER.md', 'decisions/daemon-discovery.md', 'short-term.md'). Returns frontmatter, body, and SHA-256 revision.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    },
  },
  {
    name: "memory_write",
    description:
      "Create or update a structured long-term memory file with required title & summary frontmatter and optimistic conflict detection (pass expectedRevision when updating an existing file).",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative .md path (optional if type is provided).",
        },
        type: {
          type: "string",
          enum: [...LONG_TERM_TYPES],
          description: "Template type (profile, decision, lesson, project, review, note).",
        },
        slug: {
          type: "string",
          description: "Optional filename slug when creating via type.",
        },
        title: { type: "string" },
        summary: {
          type: "string",
          description: "Concise 1-2 sentence summary for fast scanning via memory_list.",
        },
        tags: { type: "array", items: { type: "string" } },
        body: { type: "string", description: "Markdown body content." },
        updatedBy: {
          type: "string",
          description: "Harness name (codex, claude, openclaw, antigravity).",
        },
        expectedRevision: {
          type: "string",
          description: "Required when updating an existing file (from memory_read).",
        },
      },
      required: ["title", "summary"],
    },
  },
  {
    name: "memory_log",
    description:
      "Append a timestamped highlight to short-term.md (atomic, conflict-free; consolidated weekly into long-term memory).",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        harness: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["text"],
    },
  },
  {
    name: "memory_clear_short_term",
    description:
      "Archive and reset short-term.md after weekly consolidation. Requires expectedRevision so entries added mid-consolidation are never lost.",
    inputSchema: {
      type: "object",
      properties: {
        expectedRevision: { type: "string" },
        archive: { type: "boolean" },
      },
      required: ["expectedRevision"],
    },
  },
  {
    name: "memory_delete",
    description: "Delete a shared memory file (optionally guarded by expectedRevision).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        expectedRevision: { type: "string" },
      },
      required: ["path"],
    },
  },
];

const TOOL_NAMES = new Set(MEMORY_TOOLS.map((t) => t.name));

function jsonResult(data: unknown, isError = false): CallToolResult {
  return {
    ...(isError ? { isError: true } : {}),
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

export function createMemoryMcpProvider(store: MemoryStore): BuiltInToolProvider {
  return {
    listTools: () => MEMORY_TOOLS,
    canHandle: (toolName) => TOOL_NAMES.has(toolName),
    getInstructions: async () => {
      const items = await store.list({ includeShortTerm: false });
      const count = items.length;
      return `Shared memory available (${count} long-term files). Call memory_brief() at the start of non-trivial tasks; use memory_write for durable decisions/lessons/reviews and memory_log for short-term highlights.`;
    },
    callTool: async (toolName, rawArgs) => {
      const args = rawArgs ?? {};
      try {
        switch (toolName) {
          case "memory_brief": {
            const brief = await store.brief();
            return jsonResult({
              profile: brief.profile
                ? {
                    path: brief.profile.path,
                    revision: brief.profile.revision,
                    summary: brief.profile.summary,
                    body: brief.profile.body,
                  }
                : null,
              shortTerm: brief.shortTerm
                ? {
                    path: brief.shortTerm.path,
                    revision: brief.shortTerm.revision,
                    body: brief.shortTerm.body,
                  }
                : null,
              catalog: brief.catalog,
            });
          }

          case "memory_list": {
            const items = await store.list({
              type: args.type as MemoryType | undefined,
              tag: typeof args.tag === "string" ? args.tag : undefined,
              includeShortTerm: Boolean(args.includeShortTerm),
            });
            return jsonResult({ items });
          }

          case "memory_search": {
            const matches = await store.search(String(args.query ?? ""), {
              type: args.type as MemoryType | undefined,
              tag: typeof args.tag === "string" ? args.tag : undefined,
              limit: typeof args.limit === "number" ? args.limit : undefined,
            });
            return jsonResult({ matches });
          }

          case "memory_read": {
            const doc = await store.read(String(args.path ?? ""));
            if (!doc) {
              return jsonResult({ error: `Memory file not found: ${String(args.path)}` }, true);
            }
            return jsonResult(doc);
          }

          case "memory_write": {
            const doc = await store.write({
              path: typeof args.path === "string" ? args.path : undefined,
              type: args.type as LongTermMemoryType | undefined,
              slug: typeof args.slug === "string" ? args.slug : undefined,
              title: String(args.title ?? ""),
              summary: String(args.summary ?? ""),
              tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
              body: typeof args.body === "string" ? args.body : undefined,
              updatedBy: typeof args.updatedBy === "string" ? args.updatedBy : undefined,
              expectedRevision:
                typeof args.expectedRevision === "string" ? args.expectedRevision : undefined,
            });
            return jsonResult(doc);
          }

          case "memory_log": {
            const doc = await store.logShortTerm({
              text: String(args.text ?? ""),
              harness: typeof args.harness === "string" ? args.harness : undefined,
              tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
            });
            return jsonResult({
              path: doc.path,
              revision: doc.revision,
              updatedAt: doc.updatedAt,
            });
          }

          case "memory_clear_short_term": {
            const res = await store.clearShortTerm(String(args.expectedRevision ?? ""), {
              archive: args.archive !== false,
            });
            return jsonResult({
              ok: true,
              archivedPath: res.archivedPath,
              revision: res.document.revision,
            });
          }

          case "memory_delete": {
            const deleted = await store.delete(
              String(args.path ?? ""),
              typeof args.expectedRevision === "string" ? args.expectedRevision : undefined,
            );
            return jsonResult({ ok: deleted, path: String(args.path ?? "") }, !deleted);
          }

          default:
            return jsonResult({ error: `Unknown memory tool "${toolName}"` }, true);
        }
      } catch (err) {
        if (err instanceof MemoryConflictError) {
          return jsonResult(
            {
              code: err.code,
              error: err.message,
              path: err.path,
              expectedRevision: err.expectedRevision,
              currentRevision: err.currentRevision,
              currentContent: err.currentContent,
            },
            true,
          );
        }
        return jsonResult({ error: err instanceof Error ? err.message : String(err) }, true);
      }
    },
  };
}
