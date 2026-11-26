# Shared Skills System (`skills/`)

The `skills/` module implements MetaRelay's **Progressive Disclosure** shared skills system under `~/metarelay/skills/`, plus the canonical MetaRelay bootstrap instructions for connected harnesses.

---

## 3-Level Progressive Disclosure

Instead of symlinking dozens of skill directories into every harness (which duplicates files and bloats prompts), MetaRelay stores skills once in `~/metarelay/skills/<name>/SKILL.md` and serves them over `/mcp`:

1. **Level 1 — Metadata**: Compact 1-line-per-skill index (`name` + `description`) injected automatically into MCP `instructions` (up to 25 skills; above 25, directs agents to `skill_search` / `skill_list`).
2. **Level 2 — Full Instructions**: `skill_load(name)` returns the full `SKILL.md` body and list of companion files.
3. **Level 3 — Companion Files**: `skill_read_file(name, path)` reads `references/*`, `scripts/*`, etc. on demand (path-traversal guarded).

---

## Module Map

| File | Responsibility |
| --- | --- |
| `skills/store.ts` | `SkillStore` — YAML frontmatter parsing, Level 1–3 reads, weighted search, conflict-guarded `write`, `delete`, and `importFromDirectory`. |
| `skills/mcp-provider.ts` | Built-in `/mcp` tools (`skill_list`, `skill_search`, `skill_load`, `skill_read_file`, `skill_write`, `skill_delete`) + live MCP `instructions` catalog. |
| `skills/api.ts` | REST endpoints (`/api/skills`, `/api/skills/search`, `/api/skills/:name`, `/api/skills/:name/file`). |
| `skills/metarelay/GLOBAL_SNIPPET.md` | Compact `<!-- metarelay -->` always-on snippet for each harness's global instruction file. |
| `skills/metarelay/SKILL.md` | Canonical MetaRelay bootstrap Agent Skill. |

---

## CLI (`cli/commands/skills.ts`)

```bash
metarelay skills list [--tag <tag>] [--json]
metarelay skills search <query> [--tag <tag>] [--json]
metarelay skills load <name> [--json]
metarelay skills read-file <name> <relative-path>
metarelay skills import <source-dir> [--overwrite]
```

*(Automated harness global-snippet setup/sync will be wired in the setup flow milestone.)*
