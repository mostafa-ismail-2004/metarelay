# MetaRelay Native Harness Skills (`skills/`)

The `skills/` module holds the canonical instructions that teach every connected AI harness (**Codex**, **Claude Code**, **OpenClaw**, and **Antigravity**) how to use MetaRelay's shared memory and workflows.

## Design (2-Piece `lean-ctx` Pattern)

Instead of symlinking dozens of skills into every harness (which bloats system prompts), MetaRelay ships two small files:

1. **`skills/metarelay/GLOBAL_SNIPPET.md`** — A ~10-line fenced block (`<!-- metarelay --> ... <!-- /metarelay -->`) intended for each harness's always-loaded global instructions (`~/.codex/AGENTS.md`, `~/.claude/CLAUDE.md`, `~/.openclaw/workspace/AGENTS.md`, Antigravity rules) so agents never forget MetaRelay exists.
2. **`skills/metarelay/SKILL.md`** — Standard Agent Skill loaded on demand containing the full 2-tier memory decision tree, template types, `expectedRevision` conflict-handling rules, and weekly consolidation protocol.

*(Automated harness skill installation/sync will be wired in the setup flow milestone.)*
