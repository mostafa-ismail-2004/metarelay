import fsp from "node:fs/promises";
import { parseArgs } from "node:util";
import type { MetaRelayConfig } from "../../mcp/config.js";
import { SkillConflictError, SkillStore } from "../../skills/store.js";
import type { CliIo } from "../client.js";
import { formatCliError } from "../errors.js";

export async function runSkillsCommand(
  args: string[],
  ctx: { config: MetaRelayConfig; io: CliIo },
): Promise<number> {
  const { config, io } = ctx;
  const store = new SkillStore(config.skillsDir);
  const [sub, ...rest] = args;

  if (!sub || sub === "--help" || sub === "-h") {
    io.stdout(
      "Usage: metarelay skills <list|search|load|read-file|add|write|delete|import> [options]\n",
    );
    return 0;
  }

  if (sub === "add") {
    const parsed = parseArgs({
      args: rest,
      options: {
        name: { type: "string" },
        overwrite: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: true,
    });
    if (parsed.values.help) {
      io.stdout("Usage: metarelay skills add <path-to-skill-dir-or-md> [--name <slug>] [--overwrite]\n");
      return 0;
    }
    const sourcePath = parsed.positionals[0];
    if (!sourcePath) {
      io.stderr("Usage: metarelay skills add <path-to-skill-dir-or-md> [--name <slug>] [--overwrite]\n");
      return 1;
    }
    try {
      const doc = await store.addFromPath(sourcePath, {
        name: parsed.values.name,
        overwrite: parsed.values.overwrite,
      });
      if (parsed.values.json) {
        io.stdout(JSON.stringify(doc, null, 2) + "\n");
        return 0;
      }
      io.stdout(`Added skill "${doc.name}" (${doc.files.length} companion file(s)).\n`);
      return 0;
    } catch (err) {
      io.stderr(`Failed to add skill: ${formatCliError(err)}\n`);
      return 1;
    }
  }

  if (sub === "list") {
    const parsed = parseArgs({
      args: rest,
      options: {
        tag: { type: "string" },
        json: { type: "boolean", default: false },
      },
      allowPositionals: false,
    });
    const skills = await store.list({ tag: parsed.values.tag });
    if (parsed.values.json) {
      io.stdout(JSON.stringify({ skills }, null, 2) + "\n");
      return 0;
    }
    if (skills.length === 0) {
      io.stdout("No shared skills installed in ~/metarelay/skills.\n");
      return 0;
    }
    for (const s of skills) {
      io.stdout(`${s.name.padEnd(24)} ${s.description}\n`);
    }
    return 0;
  }

  if (sub === "search") {
    const parsed = parseArgs({
      args: rest,
      options: {
        tag: { type: "string" },
        json: { type: "boolean", default: false },
      },
      allowPositionals: true,
    });
    const query = parsed.positionals.join(" ").trim();
    if (!query) {
      io.stderr("Usage: metarelay skills search <query>\n");
      return 1;
    }
    const matches = await store.search(query, { tag: parsed.values.tag });
    if (parsed.values.json) {
      io.stdout(JSON.stringify({ matches }, null, 2) + "\n");
      return 0;
    }
    if (matches.length === 0) {
      io.stdout(`No skills matching "${query}".\n`);
      return 0;
    }
    for (const m of matches) {
      io.stdout(`${m.name.padEnd(24)} (score ${m.score}) ${m.description}\n`);
    }
    return 0;
  }

  if (sub === "load") {
    const parsed = parseArgs({
      args: rest,
      options: { json: { type: "boolean", default: false } },
      allowPositionals: true,
    });
    const name = parsed.positionals[0];
    if (!name) {
      io.stderr("Usage: metarelay skills load <name>\n");
      return 1;
    }
    const doc = await store.load(name);
    if (!doc) {
      io.stderr(`Skill not found: ${name}\n`);
      return 1;
    }
    if (parsed.values.json) {
      io.stdout(JSON.stringify(doc, null, 2) + "\n");
      return 0;
    }
    io.stdout(doc.raw);
    return 0;
  }

  if (sub === "read-file") {
    const [name, relPath] = rest;
    if (!name || !relPath) {
      io.stderr("Usage: metarelay skills read-file <name> <relative-path>\n");
      return 1;
    }
    const file = await store.readFile(name, relPath);
    if (!file) {
      io.stderr(`File "${relPath}" not found in skill "${name}".\n`);
      return 1;
    }
    io.stdout(file.content);
    return 0;
  }

  if (sub === "write") {
    const parsed = parseArgs({
      args: rest,
      options: {
        name: { type: "string" },
        description: { type: "string" },
        trigger: { type: "string", multiple: true },
        tag: { type: "string", multiple: true },
        body: { type: "string" },
        "body-file": { type: "string" },
        "expected-revision": { type: "string" },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: false,
    });
    if (parsed.values.help) {
      io.stdout(
        "Usage: metarelay skills write --name <slug> --description <desc> (--body <md> | --body-file <file>) [--trigger <t>...] [--tag <tag>...] [--expected-revision <rev>]\n",
      );
      return 0;
    }
    let body = parsed.values.body;
    if (parsed.values["body-file"]) {
      body = await fsp.readFile(parsed.values["body-file"], "utf8");
    }
    if (!parsed.values.name || !parsed.values.description || body === undefined) {
      io.stderr("Missing required --name, --description, and --body (or --body-file).\n");
      return 1;
    }
    try {
      const doc = await store.write({
        name: parsed.values.name,
        description: parsed.values.description,
        triggers: parsed.values.trigger,
        tags: parsed.values.tag,
        body,
        expectedRevision: parsed.values["expected-revision"],
      });
      if (parsed.values.json) {
        io.stdout(JSON.stringify(doc, null, 2) + "\n");
        return 0;
      }
      io.stdout(`Saved skill "${doc.name}" (rev ${doc.revision}).\n`);
      return 0;
    } catch (err) {
      if (err instanceof SkillConflictError) {
        io.stderr(`${err.message}\n`);
        return 1;
      }
      io.stderr(`Failed to write skill: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }

  if (sub === "delete") {
    const name = rest[0];
    if (!name) {
      io.stderr("Usage: metarelay skills delete <name>\n");
      return 1;
    }
    try {
      const deleted = await store.delete(name);
      if (!deleted) {
        io.stderr(`Skill not found: ${name}\n`);
        return 1;
      }
      io.stdout(`Deleted skill "${name}".\n`);
      return 0;
    } catch (err) {
      io.stderr(`Failed to delete skill: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }

  if (sub === "import") {
    const parsed = parseArgs({
      args: rest,
      options: {
        overwrite: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
      },
      allowPositionals: true,
    });
    const sourceDir = parsed.positionals[0];
    if (!sourceDir) {
      io.stderr("Usage: metarelay skills import <source-dir> [--overwrite]\n");
      return 1;
    }
    const res = await store.importFromDirectory(sourceDir, {
      overwrite: parsed.values.overwrite,
    });
    if (parsed.values.json) {
      io.stdout(JSON.stringify(res, null, 2) + "\n");
      return 0;
    }
    io.stdout(`Imported ${res.imported.length} skill(s) into ${store.skillsDir}.\n`);
    if (res.skipped.length > 0) {
      io.stdout(`Skipped ${res.skipped.length} existing skill(s): ${res.skipped.join(", ")}\n`);
    }
    return 0;
  }

  io.stderr(`Unknown skills subcommand "${sub}".\n`);
  return 1;
}
