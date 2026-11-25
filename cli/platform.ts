import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

export type SupportedPlatform = "linux" | "darwin" | "win32";
export type SupportedShell = "bash" | "zsh" | "fish" | "powershell";

export interface PlatformContext {
  platform: SupportedPlatform;
  homeDir: string;
  env: Record<string, string | undefined>;
}

export interface BrowserLaunchCommand {
  command: string;
  args: string[];
  shell: boolean;
}

export function normalizePlatform(raw: NodeJS.Platform = process.platform): SupportedPlatform {
  if (raw === "darwin") return "darwin";
  if (raw === "win32") return "win32";
  return "linux";
}

export function currentPlatformContext(): PlatformContext {
  return {
    platform: normalizePlatform(process.platform),
    homeDir: os.homedir(),
    env: process.env,
  };
}

/**
 * Builds the OS-native command to open a URL in the user's default browser.
 */
export function buildOpenUrlCommand(
  url: string,
  platform: SupportedPlatform = normalizePlatform(),
): BrowserLaunchCommand {
  // Validate URL to prevent shell metacharacter injection on Windows cmd
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported URL protocol for browser launch: ${parsed.protocol}`);
  }
  const safeUrl = parsed.toString();

  if (platform === "darwin") {
    return { command: "open", args: [safeUrl], shell: false };
  }
  if (platform === "win32") {
    // cmd.exe `start "" "<url>"` requires `&` to be escaped as `^&`
    const escaped = safeUrl.replace(/&/g, "^&");
    return { command: "cmd", args: ["/c", "start", "", escaped], shell: false };
  }
  return { command: "xdg-open", args: [safeUrl], shell: false };
}

export function openUrlInBrowser(
  url: string,
  platform: SupportedPlatform = normalizePlatform(),
): Promise<void> {
  const spec = buildOpenUrlCommand(url, platform);
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      stdio: "ignore",
      detached: true,
      shell: spec.shell,
      windowsHide: true,
    });
    child.once("error", reject);
    child.unref();
    resolve();
  });
}

/**
 * Detects the user's preferred interactive shell on Linux, macOS, or Windows.
 */
export function detectShell(ctx: PlatformContext = currentPlatformContext()): SupportedShell {
  const shellEnv = (ctx.env.SHELL ?? "").toLowerCase();
  if (shellEnv.endsWith("/zsh") || shellEnv.endsWith("\\zsh") || shellEnv.includes("zsh")) {
    return "zsh";
  }
  if (shellEnv.endsWith("/fish") || shellEnv.endsWith("\\fish") || shellEnv.includes("fish")) {
    return "fish";
  }
  if (shellEnv.endsWith("/bash") || shellEnv.endsWith("\\bash") || shellEnv.includes("bash")) {
    return "bash";
  }
  if (ctx.platform === "win32") {
    return "powershell";
  }
  if (ctx.platform === "darwin") {
    return "zsh";
  }
  return "bash";
}

/**
 * Returns the platform-appropriate profile / completion install path & hint.
 */
export function getCompletionInstallHint(
  shell: SupportedShell,
  ctx: PlatformContext = currentPlatformContext(),
): { filePath: string; instructions: string } {
  const pathMod = ctx.platform === "win32" ? path.win32 : path.posix;

  if (shell === "powershell") {
    const docsDir = pathMod.join(ctx.homeDir, "Documents", "PowerShell");
    const profilePath = pathMod.join(docsDir, "Microsoft.PowerShell_profile.ps1");
    return {
      filePath: profilePath,
      instructions: `metarelay completion powershell | Out-File -Append -Encoding utf8 "${profilePath}"`,
    };
  }
  if (shell === "zsh") {
    const rcPath = pathMod.join(ctx.homeDir, ".zshrc");
    return {
      filePath: rcPath,
      instructions: `eval "$(metarelay completion zsh)" # add to ${rcPath}`,
    };
  }
  if (shell === "fish") {
    const fishFile = pathMod.join(
      ctx.homeDir,
      ".config",
      "fish",
      "completions",
      "metarelay.fish",
    );
    return {
      filePath: fishFile,
      instructions: `metarelay completion fish > "${fishFile}"`,
    };
  }
  const bashRc =
    ctx.platform === "darwin"
      ? pathMod.join(ctx.homeDir, ".bash_profile")
      : pathMod.join(ctx.homeDir, ".bashrc");
  return {
    filePath: bashRc,
    instructions: `eval "$(metarelay completion bash)" # add to ${bashRc}`,
  };
}

/**
 * Resolves the MetaRelay home directory using OS-appropriate path semantics.
 */
export function resolvePlatformHomeDir(
  configuredHome: string | undefined,
  ctx: PlatformContext = currentPlatformContext(),
): string {
  const pathMod = ctx.platform === "win32" ? path.win32 : path.posix;
  const raw = ctx.env.METARELAY_HOME ?? configuredHome ?? "~/metarelay";
  if (raw === "~") return ctx.homeDir;
  if (raw.startsWith("~/") || raw.startsWith("~\\")) {
    return pathMod.join(ctx.homeDir, raw.slice(2));
  }
  return pathMod.resolve(raw);
}
