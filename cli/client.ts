import { resolveConfig, type MetaRelayConfig } from "../mcp/config.js";
import { readRuntimeState } from "../mcp/harness-sync.js";
import type { PlatformContext } from "./platform.js";

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fetchImpl?: typeof fetch;
  openBrowser?: (url: string) => Promise<void>;
  platformCtx?: PlatformContext;
  configOverrides?: Parameters<typeof resolveConfig>[0];
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Resolves the active MetaRelay daemon URL strictly from runtime.json (single source of truth).
 * Verifies both OS PID liveness and `/api/health` identity (`service === "metarelay"` + `instanceId`).
 * Returns `null` whenever no verified live MetaRelay daemon is running.
 */
export async function resolveVerifiedBaseUrl(
  config: MetaRelayConfig,
  fetchImpl: typeof fetch,
  pidCheck: (pid: number) => boolean = isPidAlive,
): Promise<string | null> {
  const runtime = await readRuntimeState(config.runtimeFile);
  if (!runtime || !pidCheck(runtime.pid)) {
    return null;
  }
  const candidate = `http://${runtime.host}:${runtime.port}`;
  try {
    const res = await fetchImpl(`${candidate}/api/health`);
    if (res.ok) {
      const body = (await res.json()) as { service?: string; instanceId?: string };
      if (body.service === "metarelay" && body.instanceId === runtime.instanceId) {
        return candidate;
      }
    }
  } catch {
    // Stale or unreachable runtime endpoint
  }
  return null;
}

export async function tryDaemonJson<T>(
  fetchImpl: typeof fetch,
  baseUrl: string,
  pathname: string,
  init?: RequestInit,
): Promise<{ ok: true; data: T } | { ok: false; status?: number; error: string }> {
  try {
    const res = await fetchImpl(`${baseUrl}${pathname}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    const body = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) {
      return { ok: false, status: res.status, error: body.error ?? `HTTP ${res.status}` };
    }
    return { ok: true, data: body };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
