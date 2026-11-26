import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  SHORT_TERM_PATH,
  USER_PROFILE_PATH,
  defaultPathForType,
  inferTypeFromPath,
  parseMarkdown,
  renderDefaultBody,
  renderShortTermTemplate,
  resolveSafeMemoryPath,
  serializeMarkdown,
  type LongTermMemoryType,
  type MemoryFrontmatter,
  type MemoryType,
} from "./templates.js";

export interface MemoryMeta {
  path: string;
  type: MemoryType;
  title: string;
  summary: string;
  tags: string[];
  updatedBy: string;
  updatedAt: string;
  revision: string;
}

export interface MemoryDocument extends MemoryMeta {
  body: string;
  raw: string;
}

export interface MemorySearchMatch {
  path: string;
  type: MemoryType;
  title: string;
  summary: string;
  tags: string[];
  revision: string;
  score: number;
  snippets: Array<{ line: number; text: string }>;
}

export interface MemoryBrief {
  profile: MemoryDocument | null;
  shortTerm: MemoryDocument | null;
  catalog: MemoryMeta[];
}

export interface WriteMemoryInput {
  path?: string;
  type?: LongTermMemoryType;
  slug?: string;
  title: string;
  summary: string;
  tags?: string[];
  body?: string;
  updatedBy?: string;
  expectedRevision?: string;
}

export class MemoryConflictError extends Error {
  readonly code = "MEMORY_CONFLICT";
  readonly path: string;
  readonly expectedRevision: string | undefined;
  readonly currentRevision: string;
  readonly currentContent: string;

  constructor(params: {
    path: string;
    expectedRevision: string | undefined;
    currentRevision: string;
    currentContent: string;
  }) {
    super(
      `Revision conflict on "${params.path}": expected ${params.expectedRevision ?? "new file"}, found ${params.currentRevision}. Re-read and merge before retrying.`,
    );
    this.name = "MemoryConflictError";
    this.path = params.path;
    this.expectedRevision = params.expectedRevision;
    this.currentRevision = params.currentRevision;
    this.currentContent = params.currentContent;
  }
}

export function computeRevision(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
}

function isoWeekLabel(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await fsp.writeFile(tmp, content, "utf8");
  await fsp.rename(tmp, filePath);
}

export class MemoryStore {
  readonly memoryDir: string;
  private shortTermQueue: Promise<unknown> = Promise.resolve();

  constructor(memoryDir: string) {
    this.memoryDir = path.resolve(memoryDir);
  }

  private async walkMarkdownFiles(dir: string, root: string): Promise<string[]> {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }

    const files: string[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue; // skips .archive, temp files
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await this.walkMarkdownFiles(full, root)));
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(path.relative(root, full).replace(/\\/g, "/"));
      }
    }
    return files.sort();
  }

  async read(relPath: string): Promise<MemoryDocument | null> {
    const { relativePath, absolutePath } = resolveSafeMemoryPath(this.memoryDir, relPath);
    try {
      const raw = await fsp.readFile(absolutePath, "utf8");
      const { frontmatter, body } = parseMarkdown(raw, relativePath);
      return {
        path: relativePath,
        ...frontmatter,
        revision: computeRevision(raw),
        body,
        raw,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw err;
    }
  }

  async list(filter?: { type?: MemoryType; tag?: string; includeShortTerm?: boolean }): Promise<MemoryMeta[]> {
    const relPaths = await this.walkMarkdownFiles(this.memoryDir, this.memoryDir);
    const items: MemoryMeta[] = [];

    for (const rel of relPaths) {
      if (!filter?.includeShortTerm && rel === SHORT_TERM_PATH && filter?.type !== "short_term") {
        continue;
      }
      const doc = await this.read(rel);
      if (!doc) continue;
      if (filter?.type && doc.type !== filter.type) continue;
      if (
        filter?.tag &&
        !doc.tags.some((t) => t.toLowerCase() === filter.tag!.toLowerCase())
      ) {
        continue;
      }
      items.push({
        path: doc.path,
        type: doc.type,
        title: doc.title,
        summary: doc.summary,
        tags: doc.tags,
        updatedBy: doc.updatedBy,
        updatedAt: doc.updatedAt,
        revision: doc.revision,
      });
    }

    return items;
  }

  /**
   * One-call session orientation: USER.md + short-term.md + compact catalog of all long-term files.
   */
  async brief(): Promise<MemoryBrief> {
    const [profile, shortTerm, catalog] = await Promise.all([
      this.read(USER_PROFILE_PATH),
      this.read(SHORT_TERM_PATH),
      this.list({ includeShortTerm: false }),
    ]);
    return {
      profile,
      shortTerm,
      catalog: catalog.filter((item) => item.path !== USER_PROFILE_PATH),
    };
  }

  /**
   * Writes or updates a structured Markdown memory file with optimistic conflict detection.
   * - Creating a new file: omit `expectedRevision` (fails with MemoryConflictError if file already exists).
   * - Updating an existing file: must pass matching `expectedRevision`.
   */
  async write(input: WriteMemoryInput): Promise<MemoryDocument> {
    const now = new Date();
    const targetRelPath =
      input.path ??
      (input.type
        ? defaultPathForType(input.type, input.slug ?? input.title, now)
        : undefined);

    if (!targetRelPath) {
      throw new Error("Either `path` or `type` must be provided to memory_write");
    }

    const { relativePath, absolutePath } = resolveSafeMemoryPath(this.memoryDir, targetRelPath);
    if (relativePath === SHORT_TERM_PATH) {
      throw new Error("Use memory_log or memory_clear_short_term to modify short-term.md");
    }

    const existing = await this.read(relativePath);
    if (existing) {
      if (!input.expectedRevision || input.expectedRevision !== existing.revision) {
        throw new MemoryConflictError({
          path: relativePath,
          expectedRevision: input.expectedRevision,
          currentRevision: existing.revision,
          currentContent: existing.raw,
        });
      }
    } else if (input.expectedRevision && input.expectedRevision !== "new") {
      throw new MemoryConflictError({
        path: relativePath,
        expectedRevision: input.expectedRevision,
        currentRevision: "missing",
        currentContent: "",
      });
    }

    const inferredType = input.type ?? (inferTypeFromPath(relativePath) as LongTermMemoryType);
    const frontmatter: MemoryFrontmatter = {
      type: inferredType,
      title: input.title.trim(),
      summary: input.summary.trim(),
      tags: (input.tags ?? existing?.tags ?? []).map((t) => t.trim()).filter(Boolean),
      updatedBy: input.updatedBy?.trim() || "unknown",
      updatedAt: now.toISOString(),
    };

    const body =
      input.body !== undefined
        ? input.body
        : existing?.body ?? renderDefaultBody(inferredType);

    const raw = serializeMarkdown(frontmatter, body);
    await atomicWrite(absolutePath, raw);

    return {
      path: relativePath,
      ...frontmatter,
      revision: computeRevision(raw),
      body: body.replace(/^\r?\n+/, "").trimEnd() + "\n",
      raw,
    };
  }

  /**
   * Serialized atomic append to short-term.md with ISO timestamp and harness attribution.
   */
  async logShortTerm(input: {
    text: string;
    harness?: string;
    tags?: string[];
  }): Promise<MemoryDocument> {
    const trimmed = input.text.trim();
    if (!trimmed) {
      throw new Error("Short-term highlight text cannot be empty");
    }

    const task = this.shortTermQueue.then(async () => {
      const now = new Date();
      const { absolutePath } = resolveSafeMemoryPath(this.memoryDir, SHORT_TERM_PATH);
      const existing = await this.read(SHORT_TERM_PATH);
      const baseRaw = existing?.raw ?? renderShortTermTemplate(now);
      const { frontmatter, body } = parseMarkdown(baseRaw, SHORT_TERM_PATH);

      const harness = input.harness?.trim() || "agent";
      const tagSuffix =
        input.tags && input.tags.length > 0
          ? ` ${input.tags.map((t) => `#${t.trim()}`).join(" ")}`
          : "";
      const singleLine = trimmed.replace(/\r?\n+/g, " ");
      const entry = `- **[${now.toISOString()} · ${harness}]** ${singleLine}${tagSuffix}`;

      const nextBody = `${body.trimEnd()}\n${entry}\n`;
      const nextRaw = serializeMarkdown(
        {
          ...frontmatter,
          type: "short_term",
          updatedBy: harness,
          updatedAt: now.toISOString(),
        },
        nextBody,
      );

      await atomicWrite(absolutePath, nextRaw);
      return (await this.read(SHORT_TERM_PATH))!;
    });

    this.shortTermQueue = task.catch(() => {});
    return task;
  }

  /**
   * Revision-guarded clear of short-term.md (used after weekly consolidation).
   * Archives the previous snapshot into `.archive/short-term-YYYY-Www.md` by default.
   */
  async clearShortTerm(
    expectedRevision: string,
    options?: { archive?: boolean; clearedBy?: string },
  ): Promise<{ archivedPath?: string; document: MemoryDocument }> {
    const task = this.shortTermQueue.then(async () => {
      const existing = await this.read(SHORT_TERM_PATH);
      const now = new Date();
      if (!existing) {
        const freshRaw = renderShortTermTemplate(now);
        const { absolutePath } = resolveSafeMemoryPath(this.memoryDir, SHORT_TERM_PATH);
        await atomicWrite(absolutePath, freshRaw);
        return { document: (await this.read(SHORT_TERM_PATH))! };
      }

      if (existing.revision !== expectedRevision) {
        throw new MemoryConflictError({
          path: SHORT_TERM_PATH,
          expectedRevision,
          currentRevision: existing.revision,
          currentContent: existing.raw,
        });
      }

      let archivedPath: string | undefined;
      if (options?.archive !== false) {
        const archiveDir = path.join(this.memoryDir, ".archive");
        await fsp.mkdir(archiveDir, { recursive: true });
        const archiveName = `short-term-${isoWeekLabel(now)}-${now.getTime()}.md`;
        const fullArchive = path.join(archiveDir, archiveName);
        await atomicWrite(fullArchive, existing.raw);
        archivedPath = `.archive/${archiveName}`;
      }

      const freshRaw = renderShortTermTemplate(now);
      const { absolutePath } = resolveSafeMemoryPath(this.memoryDir, SHORT_TERM_PATH);
      await atomicWrite(absolutePath, freshRaw);
      const document = (await this.read(SHORT_TERM_PATH))!;
      return { archivedPath, document };
    });

    this.shortTermQueue = task.catch(() => {});
    return task;
  }

  async delete(relPath: string, expectedRevision?: string): Promise<boolean> {
    const { relativePath, absolutePath } = resolveSafeMemoryPath(this.memoryDir, relPath);
    const existing = await this.read(relativePath);
    if (!existing) return false;
    if (expectedRevision && existing.revision !== expectedRevision) {
      throw new MemoryConflictError({
        path: relativePath,
        expectedRevision,
        currentRevision: existing.revision,
        currentContent: existing.raw,
      });
    }
    await fsp.unlink(absolutePath);
    return true;
  }

  /**
   * Weighted lexical search boosting title (5x), tags (4x), summary (3x), headings (2x),
   * exact phrase matches (+6), and body occurrences with matching line snippets.
   */
  async search(
    query: string,
    options?: { type?: MemoryType; tag?: string; limit?: number },
  ): Promise<MemorySearchMatch[]> {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return [];
    const terms = normalizedQuery.split(/\s+/).filter((t) => t.length > 0);
    const limit = Math.max(1, Math.min(options?.limit ?? 15, 50));

    const relPaths = await this.walkMarkdownFiles(this.memoryDir, this.memoryDir);
    const results: MemorySearchMatch[] = [];

    for (const rel of relPaths) {
      const doc = await this.read(rel);
      if (!doc) continue;
      if (options?.type && doc.type !== options.type) continue;
      if (
        options?.tag &&
        !doc.tags.some((t) => t.toLowerCase() === options.tag!.toLowerCase())
      ) {
        continue;
      }

      const titleLow = doc.title.toLowerCase();
      const summaryLow = doc.summary.toLowerCase();
      const tagsLow = doc.tags.join(" ").toLowerCase();
      const pathLow = doc.path.toLowerCase();
      const bodyLow = doc.body.toLowerCase();

      let score = 0;
      if (titleLow.includes(normalizedQuery)) score += 10;
      if (summaryLow.includes(normalizedQuery)) score += 6;
      if (bodyLow.includes(normalizedQuery)) score += 4;

      for (const term of terms) {
        if (titleLow.includes(term)) score += 5;
        if (tagsLow.includes(term)) score += 4;
        if (summaryLow.includes(term)) score += 3;
        if (pathLow.includes(term)) score += 2;
        if (bodyLow.includes(term)) score += 1;
      }

      if (score === 0) continue;

      const snippets: Array<{ line: number; text: string }> = [];
      const lines = doc.body.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const low = line.toLowerCase();
        if (terms.some((t) => low.includes(t))) {
          if (line.trimStart().startsWith("#")) score += 2;
          if (snippets.length < 3) {
            snippets.push({ line: i + 1, text: line.trim().slice(0, 180) });
          }
        }
      }

      results.push({
        path: doc.path,
        type: doc.type,
        title: doc.title,
        summary: doc.summary,
        tags: doc.tags,
        revision: doc.revision,
        score,
        snippets,
      });
    }

    results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    return results.slice(0, limit);
  }
}
