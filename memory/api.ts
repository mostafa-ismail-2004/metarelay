import type { FastifyInstance } from "fastify";
import { MemoryConflictError, type MemoryStore } from "./store.js";
import { MEMORY_TEMPLATES, type LongTermMemoryType, type MemoryType } from "./templates.js";

function handleMemoryError(err: unknown): { status: number; body: Record<string, unknown> } {
  if (err instanceof MemoryConflictError) {
    return {
      status: 409,
      body: {
        code: err.code,
        error: err.message,
        path: err.path,
        expectedRevision: err.expectedRevision,
        currentRevision: err.currentRevision,
        currentContent: err.currentContent,
      },
    };
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/required|must be|cannot|invalid|traversal|not permitted/i.test(msg)) {
    return { status: 400, body: { error: msg } };
  }
  return { status: 500, body: { error: msg } };
}

export function mountMemoryApi(app: FastifyInstance, store: MemoryStore): void {
  app.get("/api/memory/templates", async () => ({
    templates: Object.values(MEMORY_TEMPLATES),
  }));

  app.get("/api/memory/brief", async () => {
    const brief = await store.brief();
    return brief;
  });

  app.get<{ Querystring: { type?: string; tag?: string; includeShortTerm?: string } }>(
    "/api/memory/list",
    async (req) => {
      const items = await store.list({
        type: req.query.type as MemoryType | undefined,
        tag: req.query.tag,
        includeShortTerm: req.query.includeShortTerm === "true",
      });
      return { items };
    },
  );

  app.get<{ Querystring: { q?: string; type?: string; tag?: string; limit?: string } }>(
    "/api/memory/search",
    async (req) => {
      const matches = await store.search(req.query.q ?? "", {
        type: req.query.type as MemoryType | undefined,
        tag: req.query.tag,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      });
      return { matches };
    },
  );

  app.get<{ Querystring: { path?: string } }>("/api/memory/read", async (req, reply) => {
    try {
      const relPath = req.query.path ?? "";
      const doc = await store.read(relPath);
      if (!doc) {
        return reply.status(404).send({ error: `Memory file not found: ${relPath}` });
      }
      return reply.send({ document: doc });
    } catch (err) {
      const { status, body } = handleMemoryError(err);
      return reply.status(status).send(body);
    }
  });

  app.post("/api/memory/write", async (req, reply) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const doc = await store.write({
        path: typeof b.path === "string" ? b.path : undefined,
        type: b.type as LongTermMemoryType | undefined,
        slug: typeof b.slug === "string" ? b.slug : undefined,
        title: String(b.title ?? ""),
        summary: String(b.summary ?? ""),
        tags: Array.isArray(b.tags) ? b.tags.map(String) : undefined,
        body: typeof b.body === "string" ? b.body : undefined,
        updatedBy: typeof b.updatedBy === "string" ? b.updatedBy : "console",
        expectedRevision:
          typeof b.expectedRevision === "string" ? b.expectedRevision : undefined,
      });
      return reply.status(200).send({ document: doc });
    } catch (err) {
      const { status, body } = handleMemoryError(err);
      return reply.status(status).send(body);
    }
  });

  app.post("/api/memory/log", async (req, reply) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const doc = await store.logShortTerm({
        text: String(b.text ?? ""),
        harness: typeof b.harness === "string" ? b.harness : "console",
        tags: Array.isArray(b.tags) ? b.tags.map(String) : undefined,
      });
      return reply.status(201).send({ document: doc });
    } catch (err) {
      const { status, body } = handleMemoryError(err);
      return reply.status(status).send(body);
    }
  });

  app.post("/api/memory/short-term/clear", async (req, reply) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const res = await store.clearShortTerm(String(b.expectedRevision ?? ""), {
        archive: b.archive !== false,
      });
      return reply.send({ ok: true, archivedPath: res.archivedPath, document: res.document });
    } catch (err) {
      const { status, body } = handleMemoryError(err);
      return reply.status(status).send(body);
    }
  });

  app.delete<{ Querystring: { path?: string; expectedRevision?: string } }>(
    "/api/memory/delete",
    async (req, reply) => {
      try {
        const relPath = req.query.path ?? "";
        const deleted = await store.delete(relPath, req.query.expectedRevision);
        if (!deleted) {
          return reply.status(404).send({ error: `Memory file not found: ${relPath}` });
        }
        return reply.send({ ok: true, path: relPath });
      } catch (err) {
        const { status, body } = handleMemoryError(err);
        return reply.status(status).send(body);
      }
    },
  );
}
