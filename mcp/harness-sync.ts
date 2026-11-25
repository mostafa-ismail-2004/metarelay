import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type HarnessId = "codex" | "claude" | "openclaw" | "antigravity";

export interface HarnessSyncResult {
  id: HarnessId;
  name: string;
  configPath: string;
  detected: boolean;
  synced: boolean;
  changed: boolean;
  error?: string;
}

export interface HarnessPaths {
  codexConfig: string;
  claudeConfig: string;
  openclawConfig: string;
  antigravityConfig: string;
}

export function defaultHarnessPaths(homeDir: string = os.homedir()): HarnessPaths {
  return {
    codexConfig: path.join(homeDir, ".codex", "config.toml"),
    claudeConfig: path.join(homeDir, ".claude.json"),
    openclawConfig: path.join(homeDir, ".openclaw", "openclaw.json"),
    antigravityConfig: path.join(homeDir, ".gemini", "config", "mcp_config.json"),
  };
}

async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });
  let mode: number | undefined;
  try {
    const stat = await fsp.stat(filePath);
    mode = stat.mode & 0o777;
  } catch {
    // new file
  }
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, content, { encoding: "utf8", ...(mode ? { mode } : {}) });
  if (mode) {
    await fsp.chmod(tmp, mode);
  }
  await fsp.rename(tmp, filePath);
}

/**
 * Surgically upserts `[mcp_servers.metarelay]` with `url = "<mcpUrl>"` in Codex's config.toml
 * without touching any other sections or comments.
 */
export function upsertCodexToml(content: string, mcpUrl: string): {
  next: string;
  changed: boolean;
} {
  const desiredUrlLine = `url = "${mcpUrl}"`;
  const lines = content.split(/\r?\n/);
  const headerRegex = /^\s*\[mcp_servers\.metarelay\]\s*$/;
  const anySectionRegex = /^\s*\[/;

  const startIdx = lines.findIndex((line) => headerRegex.test(line));
  if (startIdx === -1) {
    const trimmedEnd = content.replace(/\s*$/, "");
    const prefix = trimmedEnd.length > 0 ? `${trimmedEnd}\n\n` : "";
    const next = `${prefix}[mcp_servers.metarelay]\n${desiredUrlLine}\n`;
    return { next, changed: next !== content };
  }

  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (anySectionRegex.test(lines[i])) {
      endIdx = i;
      break;
    }
  }

  let foundUrl = false;
  for (let i = startIdx + 1; i < endIdx; i++) {
    if (/^\s*url\s*=/.test(lines[i])) {
      lines[i] = desiredUrlLine;
      foundUrl = true;
      break;
    }
  }
  if (!foundUrl) {
    lines.splice(startIdx + 1, 0, desiredUrlLine);
  }

  const next = lines.join("\n").replace(/\n*$/, "\n");
  return { next, changed: next !== content };
}

async function syncCodex(configPath: string, mcpUrl: string): Promise<HarnessSyncResult> {
  const detected = fs.existsSync(configPath) || fs.existsSync(path.dirname(configPath));
  if (!detected) {
    return {
      id: "codex",
      name: "Codex",
      configPath,
      detected: false,
      synced: false,
      changed: false,
    };
  }
  try {
    const raw = fs.existsSync(configPath) ? await fsp.readFile(configPath, "utf8") : "";
    const { next, changed } = upsertCodexToml(raw, mcpUrl);
    if (changed) {
      await atomicWriteFile(configPath, next);
    }
    return {
      id: "codex",
      name: "Codex",
      configPath,
      detected: true,
      synced: true,
      changed,
    };
  } catch (err) {
    return {
      id: "codex",
      name: "Codex",
      configPath,
      detected: true,
      synced: false,
      changed: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function syncJsonHarness(options: {
  id: HarnessId;
  name: string;
  configPath: string;
  detectDir?: string;
  apply: (obj: Record<string, unknown>) => boolean;
}): Promise<HarnessSyncResult> {
  const detected =
    fs.existsSync(options.configPath) ||
    (options.detectDir ? fs.existsSync(options.detectDir) : false);
  if (!detected) {
    return {
      id: options.id,
      name: options.name,
      configPath: options.configPath,
      detected: false,
      synced: false,
      changed: false,
    };
  }

  try {
    const raw = fs.existsSync(options.configPath)
      ? await fsp.readFile(options.configPath, "utf8")
      : "{}";
    const parsed = (JSON.parse(raw) ?? {}) as Record<string, unknown>;
    const changed = options.apply(parsed);
    if (changed) {
      await atomicWriteFile(options.configPath, JSON.stringify(parsed, null, 2) + "\n");
    }
    return {
      id: options.id,
      name: options.name,
      configPath: options.configPath,
      detected: true,
      synced: true,
      changed,
    };
  } catch (err) {
    return {
      id: options.id,
      name: options.name,
      configPath: options.configPath,
      detected: true,
      synced: false,
      changed: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function syncAllHarnesses(
  mcpUrl: string,
  paths: HarnessPaths = defaultHarnessPaths(),
): Promise<HarnessSyncResult[]> {
  const results = await Promise.all([
    syncCodex(paths.codexConfig, mcpUrl),
    syncJsonHarness({
      id: "claude",
      name: "Claude Code",
      configPath: paths.claudeConfig,
      apply: (obj) => {
        const servers =
          obj.mcpServers && typeof obj.mcpServers === "object" && !Array.isArray(obj.mcpServers)
            ? (obj.mcpServers as Record<string, unknown>)
            : {};
        const prev = servers.metarelay as Record<string, unknown> | undefined;
        const next = { type: "http", url: mcpUrl };
        if (prev?.type === next.type && prev?.url === next.url) {
          return false;
        }
        servers.metarelay = next;
        obj.mcpServers = servers;
        return true;
      },
    }),
    syncJsonHarness({
      id: "openclaw",
      name: "OpenClaw",
      configPath: paths.openclawConfig,
      apply: (obj) => {
        const mcp =
          obj.mcp && typeof obj.mcp === "object" && !Array.isArray(obj.mcp)
            ? (obj.mcp as Record<string, unknown>)
            : {};
        const servers =
          mcp.servers && typeof mcp.servers === "object" && !Array.isArray(mcp.servers)
            ? (mcp.servers as Record<string, unknown>)
            : {};
        const prev = servers.metarelay as Record<string, unknown> | undefined;
        const next = { transport: "streamable-http", url: mcpUrl };
        if (prev?.transport === next.transport && prev?.url === next.url) {
          return false;
        }
        servers.metarelay = next;
        mcp.servers = servers;
        obj.mcp = mcp;
        return true;
      },
    }),
    syncJsonHarness({
      id: "antigravity",
      name: "Antigravity",
      configPath: paths.antigravityConfig,
      apply: (obj) => {
        const servers =
          obj.mcpServers && typeof obj.mcpServers === "object" && !Array.isArray(obj.mcpServers)
            ? (obj.mcpServers as Record<string, unknown>)
            : {};
        const prev = servers.metarelay as Record<string, unknown> | undefined;
        const next = { serverUrl: mcpUrl };
        if (prev?.serverUrl === next.serverUrl) {
          return false;
        }
        servers.metarelay = next;
        obj.mcpServers = servers;
        return true;
      },
    }),
  ]);

  return results;
}

export interface RuntimeState {
  instanceId: string;
  pid: number;
  host: string;
  port: number;
  mcpEndpoint: string;
  harnesses: HarnessSyncResult[];
  updatedAt: number;
}

export async function writeRuntimeState(
  runtimeFile: string,
  state: Omit<RuntimeState, "updatedAt">,
): Promise<void> {
  await atomicWriteFile(
    runtimeFile,
    JSON.stringify({ ...state, updatedAt: Date.now() }, null, 2) + "\n",
  );
}

export async function readRuntimeState(runtimeFile: string): Promise<RuntimeState | null> {
  try {
    const raw = await fsp.readFile(runtimeFile, "utf8");
    const parsed = JSON.parse(raw) as Partial<RuntimeState>;
    if (
      typeof parsed.instanceId === "string" &&
      typeof parsed.pid === "number" &&
      typeof parsed.host === "string" &&
      typeof parsed.port === "number"
    ) {
      return parsed as RuntimeState;
    }
    return null;
  } catch {
    return null;
  }
}

export async function removeRuntimeState(runtimeFile: string): Promise<void> {
  try {
    await fsp.unlink(runtimeFile);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}
