import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMetaRelayDaemon } from "../../mcp/server.js";
import { SkillConflictError, SkillStore, resolveSafeSkillFile } from "../store.js";

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "metarelay-skills-test-"));
}

test("Skill path validation rejects invalid names and path traversal", () => {
  const root = "/tmp/fake-skills";
  assert.throws(() => resolveSafeSkillFile(root, "../escape", "SKILL.md"), /Invalid skill name/);
  assert.throws(() => resolveSafeSkillFile(root, "valid-skill", "../../etc/passwd"), /traversal/i);
  const ok = resolveSafeSkillFile(root, "secretary", "references/template.md");
  assert.equal(ok.relativePath, "references/template.md");
});

test("SkillStore supports 3-level Progressive Disclosure, conflict detection, weighted search, and directory import", async () => {
  const dir = await makeTempDir();
  const importSrc = await makeTempDir();
  try {
    const store = new SkillStore(dir);

    // Create a skill + companion reference file
    const created = await store.write({
      name: "secretary",
      description: "Run Friday reviews, extract follow-ups, and draft handoff notes.",
      triggers: ["friday review", "weekly triage"],
      tags: ["review", "workflow"],
      body: "# Secretary\n\nFollow references/checklist.md for weekly reviews.\n",
    });
    await fs.mkdir(path.join(dir, "secretary", "references"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "secretary", "references", "checklist.md"),
      "- Review open PRs\n- Record decisions\n",
      "utf8",
    );

    // Level 1: list returns metadata + companion file paths (no body)
    const listed = await store.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].name, "secretary");
    assert.deepEqual(listed[0].files, ["references/checklist.md"]);
    assert.equal("body" in listed[0], false);

    // Level 2: load returns full SKILL.md body
    const loaded = await store.load("secretary");
    assert(loaded);
    assert.match(loaded.body, /references\/checklist\.md/);

    // Level 3: readFile reads companion file safely
    const ref = await store.readFile("secretary", "references/checklist.md");
    assert(ref);
    assert.match(ref.content, /Review open PRs/);

    // Optimistic conflict detection
    await assert.rejects(
      () =>
        store.write({
          name: "secretary",
          description: "Overwrite without rev",
          body: "nope",
        }),
      SkillConflictError,
    );
    const updated = await store.write({
      name: "secretary",
      description: "Updated Friday review skill",
      triggers: ["friday review"],
      tags: ["review"],
      body: "# Secretary v2\n",
      expectedRevision: created.revision,
    });
    assert.notEqual(updated.revision, created.revision);

    // Search ranks trigger/name matches cleanly
    const matches = await store.search("friday review");
    assert.equal(matches[0]?.name, "secretary");

    // Directory import pulls third-party Agent Skills and skips existing unless overwrite: true
    await fs.mkdir(path.join(importSrc, "deploy-check"), { recursive: true });
    await fs.writeFile(
      path.join(importSrc, "deploy-check", "SKILL.md"),
      "---\nname: deploy-check\ndescription: Pre-release deployment checklist.\n---\n\nCheck CI.\n",
      "utf8",
    );
    await fs.mkdir(path.join(importSrc, "secretary"), { recursive: true });
    await fs.writeFile(
      path.join(importSrc, "secretary", "SKILL.md"),
      "---\nname: secretary\ndescription: Duplicate\n---\n\nDup.\n",
      "utf8",
    );

    const imp = await store.importFromDirectory(importSrc);
    assert.deepEqual(imp.imported, ["deploy-check"]);
    assert.deepEqual(imp.skipped, ["secretary"]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(importSrc, { recursive: true, force: true });
  }
});

test("End-to-end MCP Progressive Disclosure: harness discovers skills in instructions, loads Level 2 & Level 3 via /mcp", async () => {
  const home = await makeTempDir();
  const daemon = await createMetaRelayDaemon({
    homeDir: home,
    port: 0,
    watchRegistry: false,
    serveConsole: false,
    syncHarnesses: false,
  });

  try {
    await daemon.skills.write({
      name: "release-notes",
      description: "Generate concise changelog notes from git commits.",
      triggers: ["release notes", "changelog"],
      tags: ["release"],
      body: "# Release Notes\nRead references/format.md for output format.\n",
    });
    await fs.mkdir(path.join(daemon.config.skillsDir, "release-notes", "references"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(daemon.config.skillsDir, "release-notes", "references", "format.md"),
      "## Format\nUse Added / Changed / Fixed.\n",
      "utf8",
    );

    await daemon.start();
    const client = new Client({ name: "codex-test", version: "1.0.0" }, { capabilities: {} });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${daemon.config.baseUrl}/mcp`)));

    // Level 1: MCP initialize instructions include compact skill catalog
    const instructions = client.getInstructions() ?? "";
    assert.match(instructions, /release-notes: Generate concise changelog notes/);

    // Level 1 tool: skill_list
    const listRes = await client.callTool({ name: "skill_list", arguments: {} });
    const listed = JSON.parse((listRes.content as Array<{ text: string }>)[0].text) as {
      skills: Array<{ name: string; files: string[] }>;
    };
    assert.equal(listed.skills[0]?.name, "release-notes");
    assert.deepEqual(listed.skills[0]?.files, ["references/format.md"]);

    // Level 2 tool: skill_load
    const loadRes = await client.callTool({
      name: "skill_load",
      arguments: { name: "release-notes" },
    });
    const loaded = JSON.parse((loadRes.content as Array<{ text: string }>)[0].text) as {
      body: string;
    };
    assert.match(loaded.body, /references\/format\.md/);

    // Level 3 tool: skill_read_file
    const fileRes = await client.callTool({
      name: "skill_read_file",
      arguments: { name: "release-notes", path: "references/format.md" },
    });
    const file = JSON.parse((fileRes.content as Array<{ text: string }>)[0].text) as {
      content: string;
    };
    assert.match(file.content, /Added \/ Changed \/ Fixed/);

    await client.close();
  } finally {
    await daemon.stop();
    await fs.rm(home, { recursive: true, force: true });
  }
});
