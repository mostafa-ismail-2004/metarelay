---
name: metarelay
description: Use MetaRelay's shared MCP tools for cross-harness memory, skills, decisions, lessons, reviews, and reusable workflows. Load this skill whenever starting a non-trivial task, switching harnesses, recording a decision or user correction, or checking shared skills.
---

# MetaRelay — Shared Skills & Memory Skill

MetaRelay connects your local AI harnesses (Codex, Claude Code, OpenClaw, Antigravity) to one shared workspace. Always interact with shared skills, memory, and workflows through MetaRelay's MCP tools (`skill_*`, `memory_*`, `workflow_*`) — **never** read or write `~/metarelay/` via raw shell or filesystem tools.

---

## 1. Shared Skills (Progressive Disclosure)

Skills follow 3-level Progressive Disclosure so your context stays lean:
1. **Level 1 — Metadata**: Scan the 1-line skill catalog in MetaRelay's MCP instructions, or call `skill_list()` / `skill_search(query)` when looking for specialized procedures.
2. **Level 2 — Full Instructions**: When a skill matches the current task, call `skill_load(name)` to read its `SKILL.md` and see any companion files (`references/`, `scripts/`).
3. **Level 3 — Companion Files**: Only call `skill_read_file(name, path)` if `SKILL.md` points you to a specific reference or script needed for the current step.

---

## 2. Reading Shared Memory

1. **Start of a non-trivial task, handoff, or past-work question**:
   - Call `memory_brief()` first.
   - It returns `USER.md` (persistent user preferences), `short-term.md` (recent timestamped highlights), and a compact catalog (`path`, `type`, `title`, `summary`, `tags`) of all long-term memories in **one call**.
2. **Targeted deep reads**:
   - Scan the `title` and `summary` fields returned by `memory_brief()` or `memory_list()`.
   - Call `memory_read(path)` **only** on the 1–2 files relevant to the current task.
   - Use `memory_search(query, type?, tag?)` when looking for specific terms, identifiers, or past decisions.
3. **Named workflows**:
   - When the user mentions a recurring procedure (e.g. Friday review, secretary, release checklist), call `workflow_list()` and `workflow_load(name)` before acting.

---

## 3. Writing Shared Memory (2-Tier Model)

You have full authority to write directly to **long-term** memory OR log to **short-term** memory depending on durability:

### Write Directly to Long-Term (`memory_write`)
Use `memory_write` immediately when the signal is clearly durable:

| `type` | Target Path | When to use |
| --- | --- | --- |
| `profile` | `USER.md` | Enduring user preferences, tone, stack, or communication rules |
| `decision` | `decisions/<slug>.md` | Architectural, product, or workflow decisions and their rationale |
| `lesson` | `lessons/<slug>.md` | User corrections or gotchas so **no other harness repeats the mistake** |
| `project` | `projects/<slug>.md` | Repo architecture, key invariants, and milestone status |
| `review` | `reviews/<YYYY-MM-DD>-<slug>.md` | Periodic reviews (e.g. Friday review) and cross-harness handoff summaries |
| `note` | `notes/<slug>.md` | Reusable reference material or runbooks |

### Log to Short-Term (`memory_log`)
Use `memory_log(text, { harness, tags? })` for working highlights, intermediate findings, or tentative context that might matter across harnesses this week. `short-term.md` is triaged and wiped weekly.

### Never Store in Memory
- API keys, tokens, passwords, OAuth secrets, or private credentials
- Raw build/compiler/test logs or transient debugging noise
- Unverified speculation presented as fact

---

## 4. Metadata & Conflict-Safety Rules

1. **Always write a crisp `summary`** (1–2 sentences) and concise `tags` in every `memory_write` call so other harnesses can decide whether to open the file from `memory_list()` alone.
2. **Always pass `updatedBy`** with your harness name (`codex`, `claude`, `openclaw`, or `antigravity`).
3. **Conflict detection (`expectedRevision`)**:
   - Before updating an existing file, call `memory_read(path)` and pass its `revision` as `expectedRevision` to `memory_write`.
   - If `memory_write` returns a `CONFLICT` error with the latest `currentRevision` and `currentContent`, **merge** your edits with the latest content and retry once. Never blindly overwrite another harness's changes.

---

## 5. Weekly Consolidation Protocol

When asked to consolidate short-term memory:
1. Call `memory_read("short-term.md")` and record its exact `revision`.
2. Call `memory_list()` to inspect existing long-term files so you merge rather than duplicate.
3. Promote genuinely durable highlights into the proper long-term templates via `memory_write` (respecting `expectedRevision` when updating existing files).
4. Discard ephemeral or obsolete lines.
5. Call `memory_clear_short_term(expectedRevision)` — this archives a weekly backup to `.archive/` and resets `short-term.md` **only** if no new highlights were added mid-run. If it conflicts, re-read and preserve the newly appended lines.
