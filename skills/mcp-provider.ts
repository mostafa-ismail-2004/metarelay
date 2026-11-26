import type { CallToolResult, Tool } from "@modelcontextprotocol/server";
import type { BuiltInToolProvider } from "../mcp/proxy-server.js";
import { SkillConflictError, type SkillStore } from "./store.js";

const INLINE_CATALOG_LIMIT = 25;

const SKILL_TOOLS: Tool[] = [
  {
    name: "skill_list",
    description:
      "Level 1 Progressive Disclosure: list all shared skills with their name, short description, triggers, tags, and companion file paths (without full bodies).",
    inputSchema: {
      type: "object",
      properties: {
        tag: { type: "string" },
      },
    },
  },
  {
    name: "skill_search",
    description:
      "Search shared skills by keyword across name, triggers, tags, description, and body.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        tag: { type: "string" },
        limit: { type: "number" },
      },
      required: ["query"],
    },
  },
  {
    name: "skill_load",
    description:
      "Level 2 Progressive Disclosure: load the full SKILL.md instructions and companion file list for a named skill.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
      },
      required: ["name"],
    },
  },
  {
    name: "skill_read_file",
    description:
      "Level 3 Progressive Disclosure: read a companion reference or script file inside a skill directory (e.g. 'references/guide.md').",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        path: { type: "string" },
      },
      required: ["name", "path"],
    },
  },
  {
    name: "skill_write",
    description:
      "Create or update a shared skill (<name>/SKILL.md) with YAML frontmatter (description, triggers, tags). Pass expectedRevision when updating an existing skill.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        triggers: { type: "array", items: { type: "string" } },
        tags: { type: "array", items: { type: "string" } },
        body: { type: "string" },
        expectedRevision: { type: "string" },
      },
      required: ["name", "description", "body"],
    },
  },
  {
    name: "skill_delete",
    description: "Delete a shared skill by name.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
      },
      required: ["name"],
    },
  },
];

const TOOL_NAMES = new Set(SKILL_TOOLS.map((t) => t.name));

function jsonResult(data: unknown, isError = false): CallToolResult {
  return {
    ...(isError ? { isError: true } : {}),
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

export function createSkillsMcpProvider(store: SkillStore): BuiltInToolProvider {
  return {
    listTools: () => SKILL_TOOLS,
    canHandle: (toolName) => TOOL_NAMES.has(toolName),
    getInstructions: async () => {
      const skills = await store.list();
      if (skills.length === 0) {
        return "Shared skills store is ready (0 skills installed). Use skill_write to save reusable skills.";
      }
      if (skills.length <= INLINE_CATALOG_LIMIT) {
        const lines = skills.map((s) => `- ${s.name}: ${s.description.slice(0, 120)}`);
        return [
          `Shared skills (${skills.length} available — call skill_load(name) when a task matches):`,
          ...lines,
        ].join("\n");
      }
      return `Shared skills (${skills.length} available). Call skill_search(query) or skill_list() to find matching skills, then skill_load(name) to load instructions.`;
    },
    callTool: async (toolName, rawArgs) => {
      const args = rawArgs ?? {};
      try {
        switch (toolName) {
          case "skill_list": {
            const skills = await store.list({
              tag: typeof args.tag === "string" ? args.tag : undefined,
            });
            return jsonResult({ skills });
          }

          case "skill_search": {
            const matches = await store.search(String(args.query ?? ""), {
              tag: typeof args.tag === "string" ? args.tag : undefined,
              limit: typeof args.limit === "number" ? args.limit : undefined,
            });
            return jsonResult({ matches });
          }

          case "skill_load": {
            const name = String(args.name ?? "");
            const doc = await store.load(name);
            if (!doc) {
              return jsonResult({ error: `Skill not found: ${name}` }, true);
            }
            return jsonResult(doc);
          }

          case "skill_read_file": {
            const name = String(args.name ?? "");
            const relPath = String(args.path ?? "");
            const file = await store.readFile(name, relPath);
            if (!file) {
              return jsonResult(
                { error: `File "${relPath}" not found in skill "${name}"` },
                true,
              );
            }
            return jsonResult(file);
          }

          case "skill_write": {
            const doc = await store.write({
              name: String(args.name ?? ""),
              description: String(args.description ?? ""),
              triggers: Array.isArray(args.triggers) ? args.triggers.map(String) : undefined,
              tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
              body: String(args.body ?? ""),
              expectedRevision:
                typeof args.expectedRevision === "string" ? args.expectedRevision : undefined,
            });
            return jsonResult(doc);
          }

          case "skill_delete": {
            const name = String(args.name ?? "");
            const deleted = await store.delete(name);
            return jsonResult({ ok: deleted, name }, !deleted);
          }

          default:
            return jsonResult({ error: `Unknown skill tool "${toolName}"` }, true);
        }
      } catch (err) {
        if (err instanceof SkillConflictError) {
          return jsonResult(
            {
              code: err.code,
              error: err.message,
              expectedRevision: err.expectedRevision,
              currentRevision: err.currentRevision,
            },
            true,
          );
        }
        return jsonResult({ error: err instanceof Error ? err.message : String(err) }, true);
      }
    },
  };
}
