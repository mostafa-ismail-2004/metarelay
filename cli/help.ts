interface HelpEntry {
  usage: string;
  summary: string;
  details?: string[];
  examples?: string[];
}

const HELP_TREE: Record<string, HelpEntry> = {
  "": {
    usage: "metarelay <command> [subcommand] [options]",
    summary: "MetaRelay CLI — local-first workspace, unified MCP proxy, shared memory, and skills.",
    details: [
      "Commands:",
      "  start          Start the MetaRelay daemon (Console + /mcp + harness sync)",
      "  status         Check daemon health, endpoint, servers, and harnesses",
      "  sync           Sync the metarelay MCP URL into detected harnesses",
      "  mcp            Manage upstream MCP servers, presets, and OAuth",
      "  memory         Manage 2-tier shared Markdown memory (short-term + long-term)",
      "  skills         Manage Progressive Disclosure shared skills",
      "  completion     Print shell tab-completion script (bash|zsh|fish|powershell)",
      "  help           Show help for any command (or pass --help / -h anywhere)",
    ],
    examples: [
      "metarelay start",
      "metarelay mcp --help",
      "metarelay memory write --help",
      "metarelay skills add --help",
    ],
  },

  start: {
    usage: "metarelay start [--host <host>] [--port <port>] [--no-sync]",
    summary: "Start the local MetaRelay daemon (Web Console, /mcp proxy, REST API, and harness sync).",
    details: [
      "Options:",
      "  --host <host>   Bind host (default from config.yml: 127.0.0.1)",
      "  --port <port>   Bind port (default from config.yml: 3847)",
      "  --no-sync       Skip automatic harness MCP URL sync on startup",
    ],
    examples: ["metarelay start", "metarelay start --port 4123 --no-sync"],
  },

  status: {
    usage: "metarelay status [--json]",
    summary: "Verify the running MetaRelay daemon via runtime.json and display health metrics.",
    details: ["Options:", "  --json          Output machine-readable JSON"],
  },

  sync: {
    usage: "metarelay sync [--json]",
    summary: "Sync the active metarelay MCP URL into Codex, Claude Code, OpenClaw, and Antigravity.",
    details: ["Options:", "  --json          Output machine-readable JSON"],
  },

  completion: {
    usage: "metarelay completion [bash|zsh|fish|powershell]",
    summary: "Print a dynamic shell tab-completion script (auto-detects shell when omitted).",
    examples: [
      'eval "$(metarelay completion bash)"',
      'eval "$(metarelay completion zsh)"',
      "metarelay completion fish > ~/.config/fish/completions/metarelay.fish",
      "metarelay completion powershell | Out-File -Append -Encoding utf8 $PROFILE",
    ],
  },

  mcp: {
    usage: "metarelay mcp <list|presets|add|remove|reconnect|auth> [options]",
    summary: "Manage upstream MCP servers proxied through MetaRelay's unified /mcp endpoint.",
    details: [
      "Subcommands:",
      "  list           List registered MCP servers and live status/tool counts",
      "  presets        List built-in known OAuth MCP presets",
      "  add            Add a known preset (--preset) or custom stdio/http/sse server",
      "  remove <id>    Remove a registered MCP server and its stored secrets",
      "  reconnect <id> Reconnect an upstream server on the running daemon",
      "  auth <id>      Start OAuth 2.1 PKCE sign-in and open browser",
    ],
    examples: ["metarelay mcp presets", "metarelay mcp add --help"],
  },
  "mcp:list": {
    usage: "metarelay mcp list [--json]",
    summary: "List all registered MCP servers (live status if daemon is running, else from servers.yaml).",
    details: ["Options:", "  --json          Output machine-readable JSON"],
  },
  "mcp:presets": {
    usage: "metarelay mcp presets [--json]",
    summary: "List built-in official MCP servers available for 1-click OAuth setup.",
    details: ["Options:", "  --json          Output machine-readable JSON"],
  },
  "mcp:add": {
    usage: "metarelay mcp add (--preset <id> | --id <id> --transport <http|sse|stdio> ...) [options]",
    summary: "Register a known MCP preset or a custom local/remote MCP server.",
    details: [
      "Options:",
      "  --preset <id>           Quick-add a known preset (see: metarelay mcp presets)",
      "  --id <slug>             Unique lowercase server ID (prefixes proxied tool names)",
      "  --name <label>          Display name",
      "  --transport <type>      http | sse | stdio",
      "  --url <url>             Remote MCP URL (for http/sse)",
      "  --auth <mode>           none | bearer | api_key | oauth",
      "  --token <token>         Bearer token (stored in 0600 secret store)",
      "  --api-key <key>         API key value (stored in 0600 secret store)",
      "  --header-name <name>    API key header name (default: X-API-Key)",
      "  --query-param <name>    Send API key as query parameter instead of header",
      "  --header <KEY=VALUE>    Custom HTTP header (repeatable)",
      "  --command <cmd>         Executable command (for stdio)",
      "  --arg <value>           Command argument (repeatable)",
      "  --cwd <dir>             Working directory (for stdio)",
      "  --env <KEY=VALUE>       Environment variable (repeatable)",
      "  --concurrency <n>       Max parallel calls (set 1 for stateful stdio tools)",
      "  --timeout <ms>          Per-call timeout in milliseconds (default: 60000)",
    ],
    examples: [
      "metarelay mcp add --preset linear",
      'metarelay mcp add --id my-api --url https://example.com/mcp --auth bearer --token "$TOKEN"',
      "metarelay mcp add --id playwright --command npx --arg -y --arg @playwright/mcp --concurrency 1",
    ],
  },
  "mcp:remove": {
    usage: "metarelay mcp remove <id>",
    summary: "Disconnect and remove a registered MCP server and its stored secrets.",
  },
  "mcp:reconnect": {
    usage: "metarelay mcp reconnect <id>",
    summary: "Force reconnect and refresh discovered tools for a server (requires running daemon).",
  },
  "mcp:auth": {
    usage: "metarelay mcp auth <id> [--no-open]",
    summary: "Start OAuth 2.1 sign-in for a server and open the provider consent screen.",
    details: ["Options:", "  --no-open       Print the authorize URL without opening a browser"],
  },

  memory: {
    usage: "metarelay memory <brief|templates|list|search|read|write|delete|log|clear-short-term> [options]",
    summary: "Manage 2-tier shared Markdown memory under ~/metarelay/memory/.",
    details: [
      "Subcommands:",
      "  brief             Show USER.md, short-term.md, and long-term summary catalog",
      "  templates         List fixed long-term memory templates and paths",
      "  list              List shared memory files and summaries",
      "  search <query>    Weighted lexical search across titles, tags, summaries, bodies",
      "  read <path>       Read a memory file (with frontmatter and revision)",
      "  write             Create or update a long-term memory file (revision-guarded)",
      "  delete <path>     Delete a memory file (optionally revision-guarded)",
      "  log <text>        Append a timestamped highlight to short-term.md",
      "  clear-short-term  Archive and reset short-term.md (revision-guarded)",
    ],
    examples: ["metarelay memory brief", "metarelay memory write --help"],
  },
  "memory:brief": {
    usage: "metarelay memory brief [--json]",
    summary: "Show USER.md, short-term.md status, and the compact summary catalog of long-term memories.",
  },
  "memory:templates": {
    usage: "metarelay memory templates [--json]",
    summary: "List the 6 fixed long-term memory templates (profile, decision, lesson, project, review, note).",
  },
  "memory:list": {
    usage: "metarelay memory list [--type <type>] [--tag <tag>] [--json]",
    summary: "List shared memory files with their frontmatter summary.",
  },
  "memory:search": {
    usage: "metarelay memory search <query> [--type <type>] [--tag <tag>] [--json]",
    summary: "Search shared memories with weighted ranking on title, tags, summary, and headings.",
  },
  "memory:read": {
    usage: "metarelay memory read <path> [--json]",
    summary: "Read a memory file by relative path (e.g. decisions/runtime-truth.md).",
  },
  "memory:write": {
    usage: "metarelay memory write [--path <rel.md> | --type <type> [--slug <slug>]] --title <t> --summary <s> [options]",
    summary: "Create a templated long-term memory or update an existing one with conflict detection.",
    details: [
      "Options:",
      "  --path <rel.md>            Explicit relative .md path",
      "  --type <type>              profile | decision | lesson | project | review | note",
      "  --slug <slug>              Optional filename slug when using --type",
      "  --title <text>             Required document title",
      "  --summary <text>           Required 1-2 sentence summary for catalog scanning",
      "  --tag <tag>                Tag (repeatable)",
      "  --body <markdown>          Inline Markdown body",
      "  --body-file <file>         Read Markdown body from a local file",
      "  --updated-by <harness>     Attribution (default: cli)",
      "  --expected-revision <rev>  Required when updating an existing file",
      "  --json                     Output machine-readable JSON",
    ],
  },
  "memory:delete": {
    usage: "metarelay memory delete <path> [--expected-revision <rev>]",
    summary: "Delete a shared memory file (optionally guarded by expected revision).",
  },
  "memory:log": {
    usage: "metarelay memory log <highlight text> [--harness <name>] [--tag <tag>...]",
    summary: "Atomically append a timestamped highlight to short-term.md.",
  },
  "memory:clear-short-term": {
    usage: "metarelay memory clear-short-term --expected-revision <rev>",
    summary: "Archive a backup of short-term.md into .archive/ and reset it safely.",
  },

  skills: {
    usage: "metarelay skills <list|search|load|read-file|add|write|delete|import> [options]",
    summary: "Manage Progressive Disclosure shared skills under ~/metarelay/skills/.",
    details: [
      "Subcommands:",
      "  list                   List shared skills (Level 1 metadata only)",
      "  search <query>         Search shared skills across names, triggers, tags, descriptions",
      "  load <name>            Load full SKILL.md instructions (Level 2)",
      "  read-file <n> <path>   Read a companion file inside a skill (Level 3)",
      "  add <path>             Add a skill from a local folder or standalone .md file",
      "  write                  Create or update a skill via flags",
      "  delete <name>          Delete a shared skill",
      "  import <dir>           Bulk-import existing Agent Skills from a parent directory",
    ],
    examples: ["metarelay skills list", "metarelay skills add ./my-skill"],
  },
  "skills:list": {
    usage: "metarelay skills list [--tag <tag>] [--json]",
    summary: "List installed shared skills with Level 1 metadata.",
  },
  "skills:search": {
    usage: "metarelay skills search <query> [--tag <tag>] [--json]",
    summary: "Search shared skills by keyword.",
  },
  "skills:load": {
    usage: "metarelay skills load <name> [--json]",
    summary: "Load a skill's full SKILL.md content and companion file list (Level 2).",
  },
  "skills:read-file": {
    usage: "metarelay skills read-file <name> <relative-path>",
    summary: "Read a companion file (e.g. references/guide.md) inside a skill (Level 3).",
  },
  "skills:add": {
    usage: "metarelay skills add <path-to-folder-or-md> [--name <slug>] [--overwrite] [--json]",
    summary: "Add a skill from a local skill directory (with SKILL.md) or a standalone .md file.",
  },
  "skills:write": {
    usage: "metarelay skills write --name <slug> --description <desc> (--body <md> | --body-file <file>) [options]",
    summary: "Create or update a shared skill (<name>/SKILL.md).",
  },
  "skills:delete": {
    usage: "metarelay skills delete <name>",
    summary: "Delete a shared skill directory by name.",
  },
  "skills:import": {
    usage: "metarelay skills import <source-dir> [--overwrite] [--json]",
    summary: "Bulk-import all Agent Skills (<name>/SKILL.md) found inside a directory.",
  },
};

export function renderHelp(commandPath: string[]): string | null {
  const clean = commandPath.filter((t) => t && !t.startsWith("-"));
  const key =
    clean.length >= 2 && `${clean[0]}:${clean[1]}` in HELP_TREE
      ? `${clean[0]}:${clean[1]}`
      : clean.length >= 1 && clean[0] in HELP_TREE
        ? clean[0]
        : clean.length === 0
          ? ""
          : null;

  if (key === null) return null;
  const entry = HELP_TREE[key];
  const lines: string[] = [entry.summary, "", `Usage:\n  ${entry.usage}`];
  if (entry.details && entry.details.length > 0) {
    lines.push("", ...entry.details);
  }
  if (entry.examples && entry.examples.length > 0) {
    lines.push("", "Examples:", ...entry.examples.map((ex) => `  ${ex}`));
  }
  return lines.join("\n") + "\n";
}
