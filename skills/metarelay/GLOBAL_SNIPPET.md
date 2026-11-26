<!-- metarelay -->
## MetaRelay — Shared Workspace & Memory

Use MetaRelay's MCP tools (`memory_*`, `workflow_*`) for shared context across harnesses — never read or write `~/metarelay/` with raw file or shell tools.
- **Before non-trivial tasks or handoffs**: call `memory_brief` to load `USER.md`, recent `short-term.md` highlights, and the summary catalog of all long-term memories.
- **Targeted lookup**: call `memory_read(path)` only on relevant files, or `memory_search(query)` for specific terms.
- **Write back**: call `memory_write` directly for durable decisions, user preferences/corrections, project invariants, or reviews (always include a 1–2 line `summary` and pass `expectedRevision` on updates); call `memory_log` for working highlights.
- **Full rules & templates**: load the `metarelay` skill (`SKILL.md`).
<!-- /metarelay -->
