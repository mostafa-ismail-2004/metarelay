import { parseArgs } from "node:util";
import type { MetaRelayConfig } from "../../mcp/config.js";
import { MemoryStore } from "../../memory/store.js";
import type { MemoryType } from "../../memory/templates.js";
import type { CliIo } from "../client.js";

export async function runMemoryCommand(
  args: string[],
  ctx: { config: MetaRelayConfig; io: CliIo },
): Promise<number> {
  const { config, io } = ctx;
  const store = new MemoryStore(config.memoryDir);
  const [sub, ...rest] = args;

  if (!sub || sub === "--help" || sub === "-h") {
    io.stdout(
      "Usage: metarelay memory <brief|list|search|read|log|clear-short-term> [options]\n",
    );
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
