import path from "node:path";
import YAML from "yaml";
import { z } from "zod";

export const LONG_TERM_TYPES = [
  "profile",
  "decision",
  "lesson",
  "project",
  "review",
  "note",
] as const;

export const MEMORY_TYPES = [...LONG_TERM_TYPES, "short_term"] as const;

export type LongTermMemoryType = (typeof LONG_TERM_TYPES)[number];
export type MemoryType = (typeof MEMORY_TYPES)[number];

export const memoryFrontmatterSchema = z.object({
  type: z.enum(MEMORY_TYPES),
  title: z.string().min(1).max(160),
  summary: z.string().min(1).max(500),
  tags: z.array(z.string().min(1).max(40)).default([]),
  updatedBy: z.string().min(1).max(60).default("unknown"),
  updatedAt: z.string().min(1),
});

export type MemoryFrontmatter = z.infer<typeof memoryFrontmatterSchema>;

export interface MemoryTemplateSpec {
  type: LongTermMemoryType;
  directory: string | null; // null for root singleton (USER.md)
  singletonPath?: string;
  description: string;
  sections: readonly string[];
}

export const MEMORY_TEMPLATES: Record<LongTermMemoryType, MemoryTemplateSpec> = {
  profile: {
    type: "profile",
    directory: null,
    singletonPath: "USER.md",
    description: "Enduring user preferences, communication style, OS/stack, and rules.",
    sections: ["## Preferences", "## Working Style", "## Environment & Tools"],
  },
  decision: {
    type: "decision",
    directory: "decisions",
    description: "Architectural, product, or workflow decisions and their rationale.",
    sections: ["## Context", "## Decision", "## Consequences"],
  },
  lesson: {
    type: "lesson",
    directory: "lessons",
    description: "User corrections, rules, and gotchas so no harness repeats a mistake.",
    sections: ["## What Happened", "## Rule to Follow", "## Why"],
  },
  project: {
    type: "project",
    directory: "projects",
    description: "Per-project architecture, key invariants, and current milestone status.",
    sections: ["## Overview", "## Architecture & Invariants", "## Status & Open Questions"],
  },
  review: {
    type: "review",
    directory: "reviews",
    description: "Periodic reviews (e.g. Friday review) and cross-harness handoff notes.",
    sections: ["## Highlights", "## Decisions & Updates", "## Follow-ups"],
  },
  note: {
    type: "note",
    directory: "notes",
    description: "General reusable knowledge, reference notes, or runbooks.",
    sections: ["## Notes", "## References"],
  },
};

export const SHORT_TERM_PATH = "short-term.md";
export const USER_PROFILE_PATH = "USER.md";

export function slugify(input: string): string {
  const cleaned = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  if (!cleaned) {
    throw new Error(`Cannot derive valid slug from "${input}"`);
  }
  return cleaned;
}

export function defaultPathForType(
  type: LongTermMemoryType,
  slugOrTitle: string,
  now: Date = new Date(),
): string {
  const spec = MEMORY_TEMPLATES[type];
  if (spec.singletonPath) {
    return spec.singletonPath;
  }
  const slug = slugify(slugOrTitle);
  if (type === "review") {
    const datePrefix = now.toISOString().slice(0, 10);
    const filename = slug.startsWith(datePrefix) ? `${slug}.md` : `${datePrefix}-${slug}.md`;
    return `${spec.directory}/${filename}`;
  }
  return `${spec.directory}/${slug}.md`;
}

export function renderDefaultBody(type: LongTermMemoryType): string {
  const spec = MEMORY_TEMPLATES[type];
  return spec.sections.map((heading) => `${heading}\n\n`).join("").trimEnd() + "\n";
}

export function renderShortTermTemplate(now: Date = new Date()): string {
  return serializeMarkdown(
    {
      type: "short_term",
      title: "Short-Term Memory",
      summary:
        "Ephemeral timestamped highlights from recent conversations across harnesses. Consolidated weekly into long-term memory and cleared.",
      tags: ["short-term", "inbox"],
      updatedBy: "metarelay",
      updatedAt: now.toISOString(),
    },
    "## Recent Highlights\n",
  );
}

export function serializeMarkdown(frontmatter: MemoryFrontmatter, body: string): string {
  const validated = memoryFrontmatterSchema.parse(frontmatter);
  const yamlBlock = YAML.stringify(validated, { lineWidth: 100 }).trimEnd();
  const normalizedBody = body.replace(/^\r?\n+/, "").trimEnd();
  return `---\n${yamlBlock}\n---\n\n${normalizedBody}\n`;
}

export function parseMarkdown(
  raw: string,
  fallbackPath: string,
): { frontmatter: MemoryFrontmatter; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (match) {
    const parsedYaml = YAML.parse(match[1]) as Record<string, unknown> | null;
    const body = (match[2] ?? "").replace(/^\r?\n+/, "");
    const inferredType = inferTypeFromPath(fallbackPath);
    const candidate = {
      type: parsedYaml?.type ?? inferredType,
      title:
        typeof parsedYaml?.title === "string" && parsedYaml.title.trim()
          ? parsedYaml.title.trim()
          : path.basename(fallbackPath, ".md"),
      summary:
        typeof parsedYaml?.summary === "string" && parsedYaml.summary.trim()
          ? parsedYaml.summary.trim()
          : firstNonEmptyLine(body) || `Memory file ${fallbackPath}`,
      tags: Array.isArray(parsedYaml?.tags)
        ? parsedYaml.tags.map((t) => String(t).trim()).filter(Boolean)
        : [],
      updatedBy:
        typeof parsedYaml?.updatedBy === "string" && parsedYaml.updatedBy.trim()
          ? parsedYaml.updatedBy.trim()
          : "unknown",
      updatedAt:
        typeof parsedYaml?.updatedAt === "string" && parsedYaml.updatedAt.trim()
          ? parsedYaml.updatedAt.trim()
          : new Date(0).toISOString(),
    };
    return {
      frontmatter: memoryFrontmatterSchema.parse(candidate),
      body,
    };
  }

  const inferredType = inferTypeFromPath(fallbackPath);
  return {
    frontmatter: memoryFrontmatterSchema.parse({
      type: inferredType,
      title: path.basename(fallbackPath, ".md"),
      summary: firstNonEmptyLine(raw) || `Memory file ${fallbackPath}`,
      tags: [],
      updatedBy: "unknown",
      updatedAt: new Date(0).toISOString(),
    }),
    body: raw,
  };
}

function firstNonEmptyLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const cleaned = line.replace(/^#+\s*/, "").trim();
    if (cleaned) return cleaned.slice(0, 200);
  }
  return "";
}

export function inferTypeFromPath(relPath: string): MemoryType {
  const norm = relPath.replace(/\\/g, "/");
  if (norm === SHORT_TERM_PATH) return "short_term";
  if (norm === USER_PROFILE_PATH) return "profile";
  if (norm.startsWith("decisions/")) return "decision";
  if (norm.startsWith("lessons/")) return "lesson";
  if (norm.startsWith("projects/")) return "project";
  if (norm.startsWith("reviews/")) return "review";
  return "note";
}

/**
 * Normalizes a relative memory path and prevents directory traversal outside `memoryDir`.
 */
export function resolveSafeMemoryPath(
  memoryDir: string,
  relPath: string,
): { relativePath: string; absolutePath: string } {
  const cleaned = relPath.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!cleaned || !cleaned.endsWith(".md")) {
    throw new Error(`Memory path must be a relative .md file (got "${relPath}")`);
  }
  if (cleaned.startsWith(".archive/") || cleaned === ".archive") {
    throw new Error("Direct access to .archive/ is not permitted");
  }
  const root = path.resolve(memoryDir);
  const abs = path.resolve(root, cleaned);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`Path traversal rejected: "${relPath}"`);
  }
  const normalizedRel = path.relative(root, abs).replace(/\\/g, "/");
  return { relativePath: normalizedRel, absolutePath: abs };
}
