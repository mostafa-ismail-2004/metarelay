import fsp from "node:fs/promises";
import { parseArgs } from "node:util";
import type { MetaRelayConfig } from "../../mcp/config.js";
import { MemoryConflictError, MemoryStore } from "../../memory/store.js";
import {
  MEMORY_TEMPLATES,
  type LongTermMemoryType,
  type MemoryType,
} from "../../memory/templates.js";
import type { CliIo } from "../client.js";
import { formatCliError } from "../errors.js";

export async function runMemoryCommand(
  args: string[],
  ctx: { config: MetaRelayConfig; io: CliIo },
): Promise<number> {
  const { config, io } = ctx;
  const store = new MemoryStore(config.memoryDir);
  const [sub, ...rest] = args;

  if (!sub || sub === "--help" || sub === "-h") {
    io.stdout(
      "Usage: metarelay memory <brief|templates|list|search|read|write|delete|log|clear-short-term> [options]\n",
    );
    return 0;
  }

  if (sub === "templates") {
    const parsed = parseArgs({
      args: rest,
      options: { json: { type: "boolean", default: false } },
      allowPositionals: false,
    });
    const templates = Object.values(MEMORY_TEMPLATES);
    if (parsed.values.json) {
      io.stdout(JSON.stringify({ templates }, null, 2) + "\n");
      return 0;
    }
    for (const t of templates) {
      const loc = t.singletonPath ?? `${t.directory}/<slug>.md`;
      io.stdout(`${t.type.padEnd(10)} ${loc.padEnd(24)} ${t.description}\n`);
    }
    return 0;
  }

  if (sub === "brief") {
    const parsed = parseArgs({
      args: rest,
      options: { json: { type: "boolean", default: false } },
      allowPositionals: false,
    });
    const brief = await store.brief();
    if (parsed.values.json) {
      io.stdout(JSON.stringify(brief, null, 2) + "\n");
      return 0;
    }
    io.stdout(`Profile (USER.md): ${brief.profile ? brief.profile.summary : "(not created yet)"}\n`);
    io.stdout(
      `Short-term:        ${brief.shortTerm ? `rev ${brief.shortTerm.revision}` : "(empty)"}\n`,
    );
    io.stdout(`Long-term catalog (${brief.catalog.length}):\n`);
    for (const item of brief.catalog) {
      io.stdout(`  - ${item.path} [${item.type}] ${item.title} — ${item.summary}\n`);
    }
    return 0;
  }

  if (sub === "list") {
    const parsed = parseArgs({
      args: rest,
      options: {
        type: { type: "string" },
        tag: { type: "string" },
        json: { type: "boolean", default: false },
      },
      allowPositionals: false,
    });
    const items = await store.list({
      type: parsed.values.type as MemoryType | undefined,
      tag: parsed.values.tag,
      includeShortTerm: true,
    });
    if (parsed.values.json) {
      io.stdout(JSON.stringify({ items }, null, 2) + "\n");
      return 0;
    }
    if (items.length === 0) {
      io.stdout("No shared memories yet.\n");
      return 0;
    }
    for (const item of items) {
      io.stdout(`${item.path.padEnd(36)} [${item.type}] ${item.summary}\n`);
    }
    return 0;
  }

  if (sub === "search") {
    const parsed = parseArgs({
      args: rest,
      options: {
        type: { type: "string" },
        tag: { type: "string" },
        json: { type: "boolean", default: false },
      },
      allowPositionals: true,
    });
    const query = parsed.positionals.join(" ").trim();
    if (!query) {
      io.stderr("Usage: metarelay memory search <query>\n");
      return 1;
    }
    const matches = await store.search(query, {
      type: parsed.values.type as MemoryType | undefined,
      tag: parsed.values.tag,
    });
    if (parsed.values.json) {
      io.stdout(JSON.stringify({ matches }, null, 2) + "\n");
      return 0;
    }
    if (matches.length === 0) {
      io.stdout(`No matches for "${query}".\n`);
      return 0;
    }
    for (const m of matches) {
      io.stdout(`${m.path} (score ${m.score}) — ${m.summary}\n`);
    }
    return 0;
  }

  if (sub === "read") {
    const parsed = parseArgs({
      args: rest,
      options: { json: { type: "boolean", default: false } },
      allowPositionals: true,
    });
    const relPath = parsed.positionals[0];
    if (!relPath) {
      io.stderr("Usage: metarelay memory read <path>\n");
      return 1;
    }
    const doc = await store.read(relPath);
    if (!doc) {
      io.stderr(`Memory file not found: ${relPath}\n`);
      return 1;
    }
    if (parsed.values.json) {
      io.stdout(JSON.stringify(doc, null, 2) + "\n");
      return 0;
    }
    io.stdout(doc.raw);
    return 0;
  }

  if (sub === "write") {
    const parsed = parseArgs({
      args: rest,
      options: {
        path: { type: "string" },
        type: { type: "string" },
        slug: { type: "string" },
        title: { type: "string" },
        summary: { type: "string" },
        tag: { type: "string", multiple: true },
        body: { type: "string" },
        "body-file": { type: "string" },
        "updated-by": { type: "string" },
        "expected-revision": { type: "string" },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: false,
    });
    if (parsed.values.help) {
      io.stdout(
        "Usage: metarelay memory write [--path <rel.md> | --type <type> [--slug <slug>]] --title <t> --summary <s> [--body <md> | --body-file <file>] [--tag <tag>...] [--expected-revision <rev>]\n",
      );
      return 0;
    }
    if (!parsed.values.title || !parsed.values.summary) {
      io.stderr("Missing required --title and --summary.\n");
      return 1;
    }
    let body = parsed.values.body;
    if (parsed.values["body-file"]) {
      body = await fsp.readFile(parsed.values["body-file"], "utf8");
    }
    try {
      const doc = await store.write({
        path: parsed.values.path,
        type: parsed.values.type as LongTermMemoryType | undefined,
        slug: parsed.values.slug,
        title: parsed.values.title,
        summary: parsed.values.summary,
        tags: parsed.values.tag,
        body,
        updatedBy: parsed.values["updated-by"] ?? "cli",
        expectedRevision: parsed.values["expected-revision"],
      });
      if (parsed.values.json) {
        io.stdout(JSON.stringify(doc, null, 2) + "\n");
        return 0;
      }
      io.stdout(`Saved ${doc.path} (rev ${doc.revision}).\n`);
      return 0;
    } catch (err) {
      if (err instanceof MemoryConflictError) {
        io.stderr(`${err.message}\n`);
        return 1;
      }
      io.stderr(`Failed to write memory: ${formatCliError(err)}\n`);
      return 1;
    }
  }

  if (sub === "delete") {
    const parsed = parseArgs({
      args: rest,
      options: { "expected-revision": { type: "string" } },
      allowPositionals: true,
    });
    const relPath = parsed.positionals[0];
    if (!relPath) {
      io.stderr("Usage: metarelay memory delete <path> [--expected-revision <rev>]\n");
      return 1;
    }
    try {
      const deleted = await store.delete(relPath, parsed.values["expected-revision"]);
      if (!deleted) {
        io.stderr(`Memory file not found: ${relPath}\n`);
        return 1;
      }
      io.stdout(`Deleted ${relPath}.\n`);
      return 0;
    } catch (err) {
      io.stderr(`Failed to delete memory: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }

  if (sub === "log") {
    const parsed = parseArgs({
      args: rest,
      options: {
        harness: { type: "string" },
        tag: { type: "string", multiple: true },
      },
      allowPositionals: true,
    });
    const text = parsed.positionals.join(" ").trim();
    if (!text) {
      io.stderr("Usage: metarelay memory log <highlight text> [--harness <name>]\n");
      return 1;
    }
    const doc = await store.logShortTerm({
      text,
      harness: parsed.values.harness ?? "cli",
      tags: parsed.values.tag,
    });
    io.stdout(`Logged to ${doc.path} (rev ${doc.revision}).\n`);
    return 0;
  }

  if (sub === "clear-short-term") {
    const parsed = parseArgs({
      args: rest,
      options: { "expected-revision": { type: "string" } },
      allowPositionals: false,
    });
    const expected = parsed.values["expected-revision"];
    if (!expected) {
      io.stderr("Usage: metarelay memory clear-short-term --expected-revision <rev>\n");
      return 1;
    }
    const res = await store.clearShortTerm(expected, { archive: true });
    io.stdout(`Cleared short-term.md (archived to ${res.archivedPath ?? "none"}).\n`);
    return 0;
  }

  io.stderr(`Unknown memory subcommand "${sub}".\n`);
  return 1;
}
