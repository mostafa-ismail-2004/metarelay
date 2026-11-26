import type { FastifyInstance } from "fastify";
import { SkillConflictError, type SkillStore } from "./store.js";

function handleSkillError(err: unknown): { status: number; body: Record<string, unknown> } {
  if (err instanceof SkillConflictError) {
    return {
      status: 409,
      body: {
        code: err.code,
        error: err.message,
        expectedRevision: err.expectedRevision,
        currentRevision: err.currentRevision,
      },
    };
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/invalid|traversal|cannot|required/i.test(msg)) {
    return { status: 400, body: { error: msg } };
  }
  return { status: 500, body: { error: msg } };
}

export function mountSkillsApi(app: FastifyInstance, store: SkillStore): void {
  app.get<{ Querystring: { tag?: string } }>("/api/skills", async (req) => {
    const skills = await store.list({ tag: req.query.tag });
    return { skills };
  });

  app.get<{ Querystring: { q?: string; tag?: string; limit?: string } }>(
    "/api/skills/search",
    async (req) => {
      const matches = await store.search(req.query.q ?? "", {
        tag: req.query.tag,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      });
      return { matches };
    },
  );

  app.get<{ Params: { name: string } }>("/api/skills/:name", async (req, reply) => {
    try {
      const doc = await store.load(req.params.name);
      if (!doc) {
        return reply.status(404).send({ error: `Skill not found: ${req.params.name}` });
      }
      return reply.send({ skill: doc });
    } catch (err) {
      const { status, body } = handleSkillError(err);
      return reply.status(status).send(body);
    }
  });

  app.get<{ Params: { name: string }; Querystring: { path?: string } }>(
    "/api/skills/:name/file",
    async (req, reply) => {
      try {
        const relPath = req.query.path ?? "";
        const file = await store.readFile(req.params.name, relPath);
        if (!file) {
          return reply
            .status(404)
            .send({ error: `File "${relPath}" not found in skill "${req.params.name}"` });
        }
        return reply.send(file);
      } catch (err) {
        const { status, body } = handleSkillError(err);
        return reply.status(status).send(body);
      }
    },
  );

  app.post("/api/skills", async (req, reply) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const doc = await store.write({
        name: String(b.name ?? ""),
        description: String(b.description ?? ""),
        triggers: Array.isArray(b.triggers) ? b.triggers.map(String) : undefined,
        tags: Array.isArray(b.tags) ? b.tags.map(String) : undefined,
        body: String(b.body ?? ""),
        expectedRevision:
          typeof b.expectedRevision === "string" ? b.expectedRevision : undefined,
      });
      return reply.status(200).send({ skill: doc });
    } catch (err) {
      const { status, body } = handleSkillError(err);
      return reply.status(status).send(body);
    }
  });

  app.delete<{ Params: { name: string } }>("/api/skills/:name", async (req, reply) => {
    try {
      const deleted = await store.delete(req.params.name);
      if (!deleted) {
        return reply.status(404).send({ error: `Skill not found: ${req.params.name}` });
      }
      return reply.send({ ok: true, name: req.params.name });
    } catch (err) {
      const { status, body } = handleSkillError(err);
      return reply.status(status).send(body);
    }
  });
}
