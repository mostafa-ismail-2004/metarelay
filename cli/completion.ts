import { KNOWN_MCP_PRESETS } from "../mcp/presets.js";
import type { SupportedShell } from "./platform.js";

export const TOP_LEVEL_COMMANDS = [
  "start",
  "status",
  "sync",
  "mcp",
  "memory",
  "skills",
  "completion",
  "help",
] as const;

export const MCP_SUBCOMMANDS = [
  "list",
  "presets",
  "add",
  "remove",
  "reconnect",
  "auth",
] as const;

export const MEMORY_SUBCOMMANDS = [
  "brief",
  "templates",
  "list",
  "search",
  "read",
  "write",
  "delete",
  "log",
  "clear-short-term",
] as const;

export const SKILLS_SUBCOMMANDS = [
  "list",
  "search",
  "load",
  "read-file",
  "add",
  "write",
  "delete",
  "import",
] as const;

export const SUPPORTED_SHELLS: readonly SupportedShell[] = [
  "bash",
  "zsh",
  "fish",
  "powershell",
];

export const COMMAND_FLAGS: Record<string, readonly string[]> = {
  start: ["--host", "--port", "--no-sync", "--help"],
  status: ["--json", "--help"],
  sync: ["--json", "--help"],
  "mcp:list": ["--json", "--help"],
  "mcp:presets": ["--json", "--help"],
  "mcp:add": [
    "--preset",
    "--id",
    "--name",
    "--transport",
    "--url",
    "--command",
    "--arg",
    "--cwd",
    "--auth",
    "--token",
    "--api-key",
    "--header-name",
    "--query-param",
    "--header",
    "--env",
    "--concurrency",
    "--timeout",
    "--help",
  ],
  "mcp:remove": ["--help"],
  "mcp:reconnect": ["--help"],
  "mcp:auth": ["--no-open", "--help"],
  "memory:brief": ["--json", "--help"],
  "memory:templates": ["--json", "--help"],
  "memory:list": ["--type", "--tag", "--json", "--help"],
  "memory:search": ["--type", "--tag", "--json", "--help"],
  "memory:read": ["--json", "--help"],
  "memory:write": [
    "--path",
    "--type",
    "--slug",
    "--title",
    "--summary",
    "--tag",
    "--body",
    "--body-file",
    "--updated-by",
    "--expected-revision",
    "--json",
    "--help",
  ],
  "memory:delete": ["--expected-revision", "--help"],
  "memory:log": ["--harness", "--tag", "--help"],
  "memory:clear-short-term": ["--expected-revision", "--help"],
  "skills:list": ["--tag", "--json", "--help"],
  "skills:search": ["--tag", "--json", "--help"],
  "skills:load": ["--json", "--help"],
  "skills:read-file": ["--help"],
  "skills:add": ["--name", "--overwrite", "--json", "--help"],
  "skills:write": [
    "--name",
    "--description",
    "--trigger",
    "--tag",
    "--body",
    "--body-file",
    "--expected-revision",
    "--json",
    "--help",
  ],
  "skills:delete": ["--help"],
  "skills:import": ["--overwrite", "--json", "--help"],
  completion: ["--help"],
};

export interface CompletionContext {
  getServerIds: () => Promise<string[]> | string[];
  getSkillNames?: () => Promise<string[]> | string[];
  getMemoryPaths?: () => Promise<string[]> | string[];
}

function filterPrefix(candidates: readonly string[], prefix: string): string[] {
  const lower = prefix.toLowerCase();
  return candidates.filter((c) => c.toLowerCase().startsWith(lower));
}

/**
 * Resolves tab-completion candidates for the given argv tokens after `metarelay`.
 * The last token in `words` is the partial token currently being completed (may be "").
 */
export async function completeArgs(
  words: string[],
  ctx: CompletionContext,
): Promise<string[]> {
  const tokens = words.length === 0 ? [""] : words;
  const current = tokens[tokens.length - 1] ?? "";
  const prev = tokens.length >= 2 ? tokens[tokens.length - 2] : "";
  const beforeCurrent = tokens.slice(0, -1);

  // Value completion for flags that take known enums or dynamic values
  if (prev === "--preset") {
    return filterPrefix(
      KNOWN_MCP_PRESETS.map((p) => p.id),
      current,
    );
  }
  if (prev === "--transport") {
    return filterPrefix(["http", "sse", "stdio"], current);
  }
  if (prev === "--auth") {
    return filterPrefix(["oauth", "bearer", "api_key", "none"], current);
  }
  if (prev === "--type") {
    return filterPrefix(["profile", "decision", "lesson", "project", "review", "note"], current);
  }

  // Position 0: top-level command
  if (beforeCurrent.length === 0) {
    return filterPrefix(TOP_LEVEL_COMMANDS, current);
  }

  const cmd = beforeCurrent[0];

  if (cmd === "completion") {
    if (beforeCurrent.length === 1 && !current.startsWith("-")) {
      return filterPrefix(SUPPORTED_SHELLS, current);
    }
    return filterPrefix(COMMAND_FLAGS.completion, current);
  }

  if (cmd === "skills") {
    if (beforeCurrent.length === 1 && !current.startsWith("-")) {
      return filterPrefix(SKILLS_SUBCOMMANDS, current);
    }
    const sub = beforeCurrent[1];
    if (
      !current.startsWith("-") &&
      (sub === "load" || sub === "read-file" || sub === "delete") &&
      ctx.getSkillNames
    ) {
      const names = await ctx.getSkillNames();
      return filterPrefix(names, current);
    }
    return filterPrefix(COMMAND_FLAGS[`skills:${sub}`] ?? ["--help"], current);
  }

  if (cmd === "memory") {
    if (beforeCurrent.length === 1 && !current.startsWith("-")) {
      return filterPrefix(MEMORY_SUBCOMMANDS, current);
    }
    const sub = beforeCurrent[1];
    if (
      !current.startsWith("-") &&
      (sub === "read" || sub === "delete") &&
      ctx.getMemoryPaths
    ) {
      const paths = await ctx.getMemoryPaths();
      return filterPrefix(paths, current);
    }
    return filterPrefix(COMMAND_FLAGS[`memory:${sub}`] ?? ["--help"], current);
  }

  if (cmd === "mcp") {
    if (beforeCurrent.length === 1 && !current.startsWith("-")) {
      return filterPrefix(MCP_SUBCOMMANDS, current);
    }
    const sub = beforeCurrent[1];
    if (current.startsWith("-")) {
      const flags = COMMAND_FLAGS[`mcp:${sub}`] ?? ["--help"];
      return filterPrefix(flags, current);
    }
    if (sub === "remove" || sub === "reconnect" || sub === "auth") {
      const serverIds = await ctx.getServerIds();
      return filterPrefix(serverIds, current);
    }
    return filterPrefix(COMMAND_FLAGS[`mcp:${sub}`] ?? [], current);
  }

  if (cmd && cmd in COMMAND_FLAGS) {
    return filterPrefix(COMMAND_FLAGS[cmd], current);
  }

  return [];
}

/**
 * Generates native tab-completion scripts for bash, zsh, fish, and PowerShell.
 */
export function generateCompletionScript(shell: SupportedShell): string {
  switch (shell) {
    case "bash":
      return `# MetaRelay bash completion
_metarelay_completions() {
  local IFS=$'\\n'
  local words=("\${COMP_WORDS[@]:1:COMP_CWORD}")
  COMPREPLY=( $(metarelay __complete "\${words[@]}" 2>/dev/null) )
}
complete -F _metarelay_completions metarelay
`;

    case "zsh":
      return `#compdef metarelay
# MetaRelay zsh completion
_metarelay() {
  local -a completions
  local -a args
  args=("\${words[@]:2:\$((CURRENT - 1))}")
  completions=("\${(@f)$(metarelay __complete "\${args[@]}" 2>/dev/null)}")
  if (( \${#completions[@]} > 0 )); then
    compadd -a completions
  fi
}
compdef _metarelay metarelay
`;

    case "fish":
      return `# MetaRelay fish completion
function __metarelay_complete
  set -l tokens (commandline -opc)
  set -l current (commandline -ct)
  set -e tokens[1]
  metarelay __complete $tokens $current 2>/dev/null
end
complete -c metarelay -f -a "(__metarelay_complete)"
`;

    case "powershell":
      return `# MetaRelay PowerShell completion
Register-ArgumentCompleter -Native -CommandName metarelay -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $tokens = @($commandAst.CommandElements | Select-Object -Skip 1 | ForEach-Object { $_.Extent.Text })
  if ([string]::IsNullOrEmpty($wordToComplete)) {
    $tokens += ""
  }
  $results = & metarelay __complete @tokens 2>$null
  foreach ($item in $results) {
    [System.Management.Automation.CompletionResult]::new($item, $item, 'ParameterValue', $item)
  }
}
`;
  }
}
