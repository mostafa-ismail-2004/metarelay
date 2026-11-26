import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";

export const SKILL_NAME_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const skillFrontmatterSchema = z.object({
  name: z.string().regex(SKILL_NAME_REGEX, "Skill name must be lowercase alphanumeric, hyphens, or underscores"),
  description: z.string().min(1).max(600),
  triggers: z.array(z.string().min(1).max(80)).default([]),
  tags: z.array(z.string().min(1).max(40)).default([]),
});

export type SkillFrontmatter = z.infer<typeof skillFrontmatterSchema>;

export interface SkillMeta {
  name: string;
  description: string;
  triggers: string[];
  tags: string[];
  files: string[];
  revision: string;
  updatedAt: string;
}

export interface SkillDocument extends SkillMeta {
  body: string;
  raw: string;
}

export interface SkillSearchMatch extends SkillMeta {
  score: number;
}

export interface WriteSkillInput {
  name: string;
  description: string;
  triggers?: string[];
  tags?: string[];
  body: string;
  expectedRevision?: string;
}

export class SkillConflictError extends Error {
  readonly code = "SKILL_CONFLICT";
  readonly name: string;
  readonly expectedRevision: string | undefined;
  readonly currentRevision: string;

  constructor(params: {
    skillName: string;
    expectedRevision: string | undefined;
    currentRevision: string;
  }) {
    super(
      `Revision conflict on skill "${params.skillName}": expected ${params.expectedRevision ?? "new skill"}, found ${params.currentRevision}.`,
    );
    this.name = "SkillConflictError";
    this.expectedRevision = params.expectedRevision;
    this.currentRevision = params.currentRevision;
  }
}

function computeRevision(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await fsp.writeFile(tmp, content, "utf8");
  await fsp.rename(tmp, filePath);
}

export function serializeSkillMarkdown(frontmatter: SkillFrontmatter, body: string): string {
  const validated = skillFrontmatterSchema.parse(frontmatter);
  const yamlObj: Record<string, unknown> = {
    name: validated.name,
    description: validated.description,
  };
  if (validated.triggers.length > 0) yamlObj.triggers = validated.triggers;
  if (validated.tags.length > 0) yamlObj.tags = validated.tags;

  const yamlBlock = YAML.stringify(yamlObj, { lineWidth: 100 }).trimEnd();
  const normalizedBody = body.replace(/^\r?\n+/, "").trimEnd();
  return `---\n${yamlBlock}\n---\n\n${normalizedBody}\n`;
}

export function parseSkillMarkdown(
  raw: string,
  folderName: string,
): { frontmatter: SkillFrontmatter; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (match) {
    const parsed = YAML.parse(match[1]) as Record<string, unknown> | null;
    const body = (match[2] ?? "").replace(/^\r?\n+/, "");
    const candidate = {
      name:
        typeof parsed?.name === "string" && SKILL_NAME_REGEX.test(parsed.name.trim())
          ? parsed.name.trim()
          : folderName,
      description:
        typeof parsed?.description === "string" && parsed.description.trim()
          ? parsed.description.trim().slice(0, 600)
          : firstLineSummary(body) || `Skill ${folderName}`,
      triggers: Array.isArray(parsed?.triggers)
        ? parsed.triggers.map((t) => String(t).trim()).filter(Boolean)
        : [],
      tags: Array.isArray(parsed?.tags)
        ? parsed.tags.map((t) => String(t).trim()).filter(Boolean)
        : [],
    };
    return {
      frontmatter: skillFrontmatterSchema.parse(candidate),
      body,
    };
  }

  return {
    frontmatter: skillFrontmatterSchema.parse({
      name: folderName,
      description: firstLineSummary(raw) || `Skill ${folderName}`,
      triggers: [],
      tags: [],
    }),
    body: raw,
  };
}

function firstLineSummary(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const cleaned = line.replace(/^#+\s*/, "").trim();
    if (cleaned) return cleaned.slice(0, 240);
  }
  return "";
}

export function resolveSafeSkillDir(skillsDir: string, skillName: string): string {
  const trimmed = skillName.trim();
  if (!SKILL_NAME_REGEX.test(trimmed)) {
    throw new Error(
      `Invalid skill name "${skillName}": must be lowercase alphanumeric, hyphens, or underscores`,
    );
  }
  const root = path.resolve(skillsDir);
  const target = path.resolve(root, trimmed);
  if (!target.startsWith(root + path.sep)) {
    throw new Error(`Path traversal rejected for skill "${skillName}"`);
  }
  return target;
}

export function resolveSafeSkillFile(
  skillsDir: string,
  skillName: string,
  relativePath: string,
): { relativePath: string; absolutePath: string } {
  const skillRoot = resolveSafeSkillDir(skillsDir, skillName);
  const cleaned = relativePath.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!cleaned) {
    throw new Error("Companion file path cannot be empty");
  }
  const abs = path.resolve(skillRoot, cleaned);
  if (abs === skillRoot || !abs.startsWith(skillRoot + path.sep)) {
    throw new Error(`Path traversal rejected: "${relativePath}"`);
  }
  return {
    relativePath: path.relative(skillRoot, abs).replace(/\\/g, "/"),
    absolutePath: abs,
  };
}

async function listCompanionFiles(skillRoot: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const rel = path.relative(skillRoot, full).replace(/\\/g, "/");
        if (rel !== "SKILL.md") {
          out.push(rel);
        }
      }
    }
  }
  await walk(skillRoot);
  return out.sort();
}

export class SkillStore {
  readonly skillsDir: string;

  constructor(skillsDir: string) {
    this.skillsDir = path.resolve(skillsDir);
  }

  /**
   * Level 1 (Progressive Disclosure): metadata + companion file list only (no SKILL.md bodies).
   */
  async list(filter?: { tag?: string }): Promise<SkillMeta[]> {
    let entries;
    try {
      entries = await fsp.readdir(this.skillsDir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }

    const items: SkillMeta[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".") || !SKILL_NAME_REGEX.test(entry.name)) continue;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const doc = await this.load(entry.name);
      if (!doc) continue;
      if (
        filter?.tag &&
        !doc.tags.some((t) => t.toLowerCase() === filter.tag!.toLowerCase())
      ) {
        continue;
      }
      items.push({
        name: doc.name,
        description: doc.description,
        triggers: doc.triggers,
        tags: doc.tags,
        files: doc.files,
        revision: doc.revision,
        updatedAt: doc.updatedAt,
      });
    }

    return items.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Level 2 (Progressive Disclosure): full SKILL.md body + list of companion files.
   */
  async load(skillName: string): Promise<SkillDocument | null> {
    const skillRoot = resolveSafeSkillDir(this.skillsDir, skillName);
    const skillFile = path.join(skillRoot, "SKILL.md");
    try {
      const [raw, stat, files] = await Promise.all([
        fsp.readFile(skillFile, "utf8"),
        fsp.stat(skillFile),
        listCompanionFiles(skillRoot),
      ]);
      const { frontmatter, body } = parseSkillMarkdown(raw, skillName);
      return {
        ...frontmatter,
        files,
        revision: computeRevision(raw),
        updatedAt: stat.mtime.toISOString(),
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

  /**
   * Level 3 (Progressive Disclosure): read a specific companion file inside a skill folder.
   */
  async readFile(
    skillName: string,
    relativePath: string,
  ): Promise<{ skill: string; path: string; content: string } | null> {
    const { relativePath: safeRel, absolutePath } = resolveSafeSkillFile(
      this.skillsDir,
      skillName,
      relativePath,
    );
    try {
      const content = await fsp.readFile(absolutePath, "utf8");
      return { skill: skillName, path: safeRel, content };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw err;
    }
  }

  async search(
    query: string,
    options?: { tag?: string; limit?: number },
  ): Promise<SkillSearchMatch[]> {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return [];
    const terms = normalized.split(/\s+/).filter(Boolean);
    const limit = Math.max(1, Math.min(options?.limit ?? 15, 50));

    const metas = await this.list({ tag: options?.tag });
    const matches: SkillSearchMatch[] = [];

    for (const meta of metas) {
      const doc = await this.load(meta.name);
      if (!doc) continue;

      const nameLow = doc.name.toLowerCase();
      const descLow = doc.description.toLowerCase();
      const triggersLow = doc.triggers.join(" ").toLowerCase();
      const tagsLow = doc.tags.join(" ").toLowerCase();
      const bodyLow = doc.body.toLowerCase();

      let score = 0;
      if (nameLow.includes(normalized)) score += 12;
      if (triggersLow.includes(normalized)) score += 10;
      if (descLow.includes(normalized)) score += 6;
      if (bodyLow.includes(normalized)) score += 3;

      for (const term of terms) {
        if (nameLow.includes(term)) score += 6;
        if (triggersLow.includes(term)) score += 5;
        if (tagsLow.includes(term)) score += 4;
        if (descLow.includes(term)) score += 3;
        if (bodyLow.includes(term)) score += 1;
      }

      if (score > 0) {
        matches.push({ ...meta, score });
      }
    }

    matches.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    return matches.slice(0, limit);
  }

  async write(input: WriteSkillInput): Promise<SkillDocument> {
    const skillRoot = resolveSafeSkillDir(this.skillsDir, input.name);
    const existing = await this.load(input.name);
    if (existing) {
      if (!input.expectedRevision || input.expectedRevision !== existing.revision) {
        throw new SkillConflictError({
          skillName: input.name,
          expectedRevision: input.expectedRevision,
          currentRevision: existing.revision,
        });
      }
    } else if (input.expectedRevision && input.expectedRevision !== "new") {
      throw new SkillConflictError({
        skillName: input.name,
        expectedRevision: input.expectedRevision,
        currentRevision: "missing",
      });
    }

    const raw = serializeSkillMarkdown(
      {
        name: input.name.trim(),
        description: input.description.trim(),
        triggers: (input.triggers ?? []).map((t) => t.trim()).filter(Boolean),
        tags: (input.tags ?? []).map((t) => t.trim()).filter(Boolean),
      },
      input.body,
    );

    await atomicWrite(path.join(skillRoot, "SKILL.md"), raw);
    return (await this.load(input.name))!;
  }

  async delete(skillName: string): Promise<boolean> {
    const skillRoot = resolveSafeSkillDir(this.skillsDir, skillName);
    const existing = await this.load(skillName);
    if (!existing) return false;
    await fsp.rm(skillRoot, { recursive: true, force: true });
    return true;
  }

  /**
   * Adds a single skill from a local path:
   * - A skill directory containing `SKILL.md` (copies the entire folder + companion files)
   * - A `SKILL.md` file (copies its containing skill folder)
   * - A standalone `.md` file (imports as `<slug>/SKILL.md`)
   */
  async addFromPath(
    sourcePath: string,
    options?: { name?: string; overwrite?: boolean },
  ): Promise<SkillDocument> {
    const resolved = path.resolve(sourcePath);
    const stat = await fsp.stat(resolved);

    let skillDirToCopy: string | null = null;
    let standaloneFile: string | null = null;
    let inferredName: string;

    if (stat.isDirectory()) {
      const skillFile = path.join(resolved, "SKILL.md");
      try {
        await fsp.access(skillFile);
      } catch {
        throw new Error(`Directory "${sourcePath}" does not contain a SKILL.md file`);
      }
      skillDirToCopy = resolved;
      inferredName = path.basename(resolved);
    } else if (stat.isFile()) {
      const base = path.basename(resolved);
      if (!base.endsWith(".md")) {
        throw new Error(`Expected a skill directory or .md file (got "${sourcePath}")`);
      }
      standaloneFile = resolved;
      const raw = await fsp.readFile(resolved, "utf8");
      const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      const fmParsed = fmMatch ? (YAML.parse(fmMatch[1]) as Record<string, unknown> | null) : null;
      const fmName =
        typeof fmParsed?.name === "string" && fmParsed.name.trim() ? fmParsed.name.trim() : null;
      inferredName =
        fmName ?? (base === "SKILL.md" ? path.basename(path.dirname(resolved)) : base.slice(0, -3));
    } else {
      throw new Error(`Unsupported path type: "${sourcePath}"`);
    }

    const rawName = (options?.name ?? inferredName)
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    const destDir = resolveSafeSkillDir(this.skillsDir, rawName);

    const existing = await this.load(rawName);
    if (existing && !options?.overwrite) {
      throw new Error(`Skill "${rawName}" already exists. Pass --overwrite to replace it.`);
    }

    await fsp.mkdir(this.skillsDir, { recursive: true });
    if (skillDirToCopy) {
      await fsp.cp(skillDirToCopy, destDir, { recursive: true, force: true });
    } else if (standaloneFile) {
      const raw = await fsp.readFile(standaloneFile, "utf8");
      const { frontmatter, body } = parseSkillMarkdown(raw, rawName);
      const serialized = serializeSkillMarkdown({ ...frontmatter, name: rawName }, body);
      await atomicWrite(path.join(destDir, "SKILL.md"), serialized);
    }

    return (await this.load(rawName))!;
  }

  /**
   * Imports existing Agent Skills (<name>/SKILL.md + companion files) from another directory
   * into ~/metarelay/skills/.
   */
  async importFromDirectory(
    sourceDir: string,
    options?: { overwrite?: boolean; filterNames?: string[] },
  ): Promise<{ imported: string[]; skipped: string[] }> {
    const imported: string[] = [];
    const skipped: string[] = [];
    const allowed = options?.filterNames ? new Set(options.filterNames) : null;

    let entries;
    try {
      entries = await fsp.readdir(sourceDir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { imported, skipped };
      }
      throw err;
    }

    await fsp.mkdir(this.skillsDir, { recursive: true });

    for (const entry of entries) {
      if (entry.name.startsWith(".") || !SKILL_NAME_REGEX.test(entry.name)) continue;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (allowed && !allowed.has(entry.name)) continue;

      const srcSkillDir = path.join(sourceDir, entry.name);
      const srcSkillFile = path.join(srcSkillDir, "SKILL.md");
      try {
        await fsp.access(srcSkillFile);
      } catch {
        continue;
      }

      const destSkillDir = resolveSafeSkillDir(this.skillsDir, entry.name);
      const alreadyExists = (await this.load(entry.name)) !== null;
      if (alreadyExists && !options?.overwrite) {
        skipped.push(entry.name);
        continue;
      }

      await fsp.cp(srcSkillDir, destSkillDir, { recursive: true, force: true });
      imported.push(entry.name);
    }

    return { imported: imported.sort(), skipped: skipped.sort() };
  }
}
