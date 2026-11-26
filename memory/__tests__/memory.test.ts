import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMetaRelayDaemon } from "../../mcp/server.js";
import { MemoryConflictError, MemoryStore } from "../store.js";
import { SHORT_TERM_PATH, resolveSafeMemoryPath } from "../templates.js";

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "metarelay-memory-test-"));
}

test("Path traversal and .archive direct access are rejected", () => {
  const root = "/tmp/fake-memory";
  assert.throws(() => resolveSafeMemoryPath(root, "../secrets.json"), /must be a relative \.md|traversal/i);
  assert.throws(() => resolveSafeMemoryPath(root, "../../etc/passwd.md"), /traversal/i);
  assert.throws(() => resolveSafeMemoryPath(root, ".archive/old.md"), /not permitted/i);
  assert.throws(() => resolveSafeMemoryPath(root, "notes/no-ext"), /must be a relative \.md/i);

  const ok = resolveSafeMemoryPath(root, "decisions/runtime-truth.md");
  assert.equal(ok.relativePath, "decisions/runtime-truth.md");
});

test("MemoryStore scaffolds fixed templates, enforces conflict detection, and supports merge recovery", async () => {
  const dir = await makeTempDir();
  try {
    const store = new MemoryStore(dir);

    // Create decision via template (no body -> scaffolds fixed sections)
    const created = await store.write({
      type: "decision",
      title: "Runtime JSON Discovery",
      summary: "Use runtime.json with PID and instanceId as sole source of truth.",
      tags: ["cli", "daemon"],
      updatedBy: "codex",
    });
    assert.equal(created.path, "decisions/runtime-json-discovery.md");
    assert.match(created.body, /## Context/);
    assert.match(created.body, /## Decision/);
    assert.match(created.body, /## Consequences/);

    // Duplicate create without expectedRevision must fail with MemoryConflictError
    await assert.rejects(
      () =>
        store.write({
          path: created.path,
          title: "Overwrite attempt",
          summary: "Should fail without revision",
        }),
      (err: unknown) =>
        err instanceof MemoryConflictError && err.currentRevision === created.revision,
    );

    // Updating with stale revision fails cleanly with latest content
    await assert.rejects(
      () =>
        store.write({
          path: created.path,
          title: "Stale update",
          summary: "Should fail",
          expectedRevision: "deadbeef00000000",
        }),
      (err: unknown) =>
        err instanceof MemoryConflictError &&
        err.currentRevision === created.revision &&
        err.currentContent.includes("Runtime JSON Discovery"),
    );

    // Updating with exact revision succeeds and changes revision
    const updated = await store.write({
      path: created.path,
      title: "Runtime JSON Discovery",
      summary: "Verified via PID + instanceId handshake.",
      body: "## Context\nCLI needs live daemon port.\n\n## Decision\nVerify runtime.json.\n",
      updatedBy: "claude",
      expectedRevision: created.revision,
    });
    assert.notEqual(updated.revision, created.revision);
    assert.equal(updated.updatedBy, "claude");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("Short-term memory supports concurrent atomic logs and revision-guarded archive + clear", async () => {
  const dir = await makeTempDir();
  try {
    const store = new MemoryStore(dir);

    // Fire 5 concurrent appends from different harnesses — none should be lost
    await Promise.all([
      store.logShortTerm({ text: "Highlight 1 from Codex", harness: "codex" }),
      store.logShortTerm({ text: "Highlight 2 from Claude", harness: "claude" }),
      store.logShortTerm({ text: "Highlight 3 from OpenClaw", harness: "openclaw" }),
      store.logShortTerm({ text: "Highlight 4 from Antigravity", harness: "antigravity" }),
      store.logShortTerm({ text: "Highlight 5 from Codex", harness: "codex", tags: ["mcp"] }),
    ]);

    const shortTerm = await store.read(SHORT_TERM_PATH);
    assert(shortTerm);
    for (let i = 1; i <= 5; i++) {
      assert.match(shortTerm.body, new RegExp(`Highlight ${i} from`));
    }

    // Wrong revision refuses to wipe short-term memory
    await assert.rejects(
      () => store.clearShortTerm("wrong-rev"),
      MemoryConflictError,
    );

    // Matching revision archives snapshot and resets short-term.md cleanly
    const cleared = await store.clearShortTerm(shortTerm.revision, { archive: true });
    assert.ok(cleared.archivedPath?.startsWith(".archive/short-term-"));
    const archivedRaw = await fs.readFile(path.join(dir, cleared.archivedPath!), "utf8");
    assert.match(archivedRaw, /Highlight 5 from Codex/);

    const afterClear = await store.read(SHORT_TERM_PATH);
    assert(afterClear);
    assert.equal(afterClear.body.includes("Highlight 1"), false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("Weighted search ranks title/tag/summary matches above body-only matches", async () => {
  const dir = await makeTempDir();
  try {
    const store = new MemoryStore(dir);

    await store.write({
      type: "note",
      title: "Misc notes",
      summary: "General workspace thoughts",
      body: "## Notes\nMentioned oauth once in passing.\n",
      updatedBy: "codex",
    });

    await store.write({
      type: "decision",
      title: "OAuth 2.1 Token Storage",
      summary: "Store OAuth 2.1 tokens in 0600 files under ~/.metarelay/.state/oauth.",
      tags: ["oauth", "security"],
      body: "## Decision\nKeep tokens isolated from servers.yaml.\n",
      updatedBy: "claude",
    });

    const matches = await store.search("oauth");
    assert.equal(matches.length, 2);
    assert.equal(matches[0].path, "decisions/oauth-2-1-token-storage.md");
    assert.ok(matches[0].score > matches[1].score);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("End-to-end MCP round-trip: OpenClaw writes Friday review, Codex revises it, OpenClaw reads revision via /mcp", async () => {
  const home = await makeTempDir();
  const daemon = await createMetaRelayDaemon({
    homeDir: home,
    port: 0,
    watchRegistry: false,
    serveConsole: false,
    syncHarnesses: false,
  });

  try {
    await daemon.start();
    const mcpUrl = new URL(`${daemon.config.baseUrl}/mcp`);

    const openclaw = new Client({ name: "openclaw", version: "1.0.0" }, { capabilities: {} });
    const codex = new Client({ name: "codex", version: "1.0.0" }, { capabilities: {} });
    await Promise.all([
      openclaw.connect(new StreamableHTTPClientTransport(mcpUrl)),
      codex.connect(new StreamableHTTPClientTransport(mcpUrl)),
    ]);

    // 1. OpenClaw writes a Friday review
    const writeRes = await openclaw.callTool({
      name: "memory_write",
      arguments: {
        type: "review",
        slug: "friday-review",
        title: "Friday Review",
        summary: "Completed MCP proxy and cross-OS CLI this week.",
        tags: ["review", "weekly"],
        body: "## Highlights\n- Shipped MCP proxy\n\n## Follow-ups\n- Build workflows\n",
        updatedBy: "openclaw",
      },
    });
    const created = JSON.parse((writeRes.content as Array<{ text: string }>)[0].text) as {
      path: string;
      revision: string;
    };
    assert.match(created.path, /^reviews\/\d{4}-\d{2}-\d{2}-friday-review\.md$/);

    // 2. Codex calls memory_brief, sees the review in catalog, reads it, and revises it with expectedRevision
    const briefRes = await codex.callTool({ name: "memory_brief", arguments: {} });
    const brief = JSON.parse((briefRes.content as Array<{ text: string }>)[0].text) as {
      catalog: Array<{ path: string; summary: string }>;
    };
    assert.ok(brief.catalog.some((c) => c.path === created.path));

    const reviseRes = await codex.callTool({
      name: "memory_write",
      arguments: {
        path: created.path,
        title: "Friday Review",
        summary: "Completed MCP proxy, CLI, and 2-tier shared memory.",
        body: "## Highlights\n- Shipped MCP proxy\n- Added 2-tier shared memory\n",
        updatedBy: "codex",
        expectedRevision: created.revision,
      },
    });
    assert.equal(reviseRes.isError, undefined);

    // 3. OpenClaw reads back the revision
    const readRes = await openclaw.callTool({
      name: "memory_read",
      arguments: { path: created.path },
    });
    const finalDoc = JSON.parse((readRes.content as Array<{ text: string }>)[0].text) as {
      updatedBy: string;
      body: string;
    };
    assert.equal(finalDoc.updatedBy, "codex");
    assert.match(finalDoc.body, /Added 2-tier shared memory/);

    await Promise.all([openclaw.close(), codex.close()]);
  } finally {
    await daemon.stop();
    await fs.rm(home, { recursive: true, force: true });
  }
});
