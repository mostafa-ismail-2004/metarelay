<!-- metarelay -->
## MetaRelay — Shared Workspace, Skills & Memory

Use MetaRelay's MCP tools (`memory_*`, `skill_*`, `workflow_*`) for shared context across harnesses — never read or write `~/metarelay/` with raw file or shell tools.
- **Before non-trivial tasks or handoffs**: call `memory_brief` to load `USER.md`, recent `short-term.md` highlights, and the summary catalog of all long-term memories.
- **Shared skills (Progressive Disclosure)**: check the skill catalog in MetaRelay's MCP instructions or call `skill_list` / `skill_search(query)`. When a task matches a skill, call `skill_load(name)` before acting, and `skill_read_file(name, path)` only if it references companion files.
- **Targeted memory lookup**: call `memory_read(path)` only on relevant files, or `memory_search(query)` for specific terms.
- **Write back**: call `memory_write` directly for durable decisions, user preferences/corrections, project invariants, or reviews (always include a 1–2 line `summary` and pass `expectedRevision` on updates); call `memory_log` for working highlights.
- **Full rules & templates**: load the `metarelay` skill (`SKILL.md`).
<!-- /metarelay -->
