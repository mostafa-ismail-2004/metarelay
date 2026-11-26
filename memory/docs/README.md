# Shared Markdown Memory (`memory/`)

The `memory/` module implements MetaRelay's **2-tier shared Markdown memory** stored under `~/metarelay/memory/` and exposed simultaneously over MCP (`/mcp`), REST (`/api/memory/*`), and the CLI (`metarelay memory ...`).

---

## 2-Tier Architecture

### Tier 1 — Short-Term Memory (`short-term.md`)
- Timestamped, harness-attributed conversation highlights written via `memory_log` (serialized atomic append, conflict-free).
- Triaged weekly into durable long-term templates and cleared via `memory_clear_short_term(expectedRevision)`.
- Every clear saves a snapshot to `~/metarelay/memory/.archive/short-term-YYYY-Www-<ts>.md` and is **revision-guarded** so new highlights logged during consolidation are never lost.

### Tier 2 — Long-Term Memory (Fixed Templates + Required `summary` Frontmatter)
Agents have full authority to write directly to long-term memory whenever signal is clearly durable:

| Type | Path | Fixed Sections |
| --- | --- | --- |
| `profile` | `USER.md` | `## Preferences`, `## Working Style`, `## Environment & Tools` |
| `decision` | `decisions/<slug>.md` | `## Context`, `## Decision`, `## Consequences` |
| `lesson` | `lessons/<slug>.md` | `## What Happened`, `## Rule to Follow`, `## Why` |
| `project` | `projects/<slug>.md` | `## Overview`, `## Architecture & Invariants`, `## Status & Open Questions` |
| `review` | `reviews/<YYYY-MM-DD>-<slug>.md` | `## Highlights`, `## Decisions & Updates`, `## Follow-ups` |
| `note` | `notes/<slug>.md` | `## Notes`, `## References` |

Every file includes validated YAML frontmatter: `type`, `title`, `summary` (1–2 sentences for fast catalog scanning), `tags`, `updatedBy`, and `updatedAt`.

---

## Conflict Detection

- `memory_read(path)` returns a 16-char SHA-256 `revision` of the file's exact contents.
- `memory_write` rejects overwriting an existing file unless `expectedRevision` matches the current file on disk, returning `MemoryConflictError` (`409` over REST, `isError: true` with `currentRevision` + `currentContent` over MCP) so agents merge rather than clobber.

---

## Built-in MCP Tools (`memory/mcp-provider.ts`)

| Tool | Purpose |
| --- | --- |
| `memory_brief` | One-call orientation: `USER.md` + `short-term.md` + compact summary catalog of all long-term files. |
| `memory_list` | List memory metadata + `summary` (optional `type` / `tag` filter). |
| `memory_search` | Weighted lexical search boosting `title` (5x), `tags` (4x), `summary` (3x), headings (2x), and exact phrases. |
| `memory_read` | Read a memory file's frontmatter, body, and `revision`. |
| `memory_write` | Create from template or update with `expectedRevision` conflict detection. |
| `memory_log` | Atomic timestamped append to `short-term.md`. |
| `memory_clear_short_term` | Revision-guarded archive + reset of `short-term.md`. |
| `memory_delete` | Delete a memory file (optionally revision-guarded). |

---

## Testing

```bash
npm test
```

`memory/__tests__/memory.test.ts` verifies templates, path-traversal protection, optimistic conflict detection & merge recovery, concurrent `memory_log` appends, revision-guarded `clearShortTerm` archiving, weighted search ranking, and end-to-end MCP tool calls over `/mcp`.
