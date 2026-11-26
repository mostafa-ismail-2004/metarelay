import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { z } from "zod";

const configFileSchema = z.object({
  server: z
    .object({
      host: z.string().min(1).optional(),
      port: z.number().int().min(0).max(65535).optional(),
    })
    .optional(),
  console: z
    .object({
      host: z.string().min(1).optional(),
      port: z.number().int().min(1).max(65535).optional(),
    })
    .optional(),
  storage: z
    .object({
      home: z.string().min(1).optional(),
    })
    .optional(),
  harnesses: z
    .object({
      autoSyncOnStart: z.boolean().optional(),
    })
    .optional(),
});

type PartialConfigFile = z.infer<typeof configFileSchema>;

export interface MetaRelayConfig {
  repoConfigFile: string;
  userConfigFile: string;
  homeDir: string;
  mcpDir: string;
  memoryDir: string;
  serversFile: string;
  stateDir: string;
  secretsFile: string;
  oauthDir: string;
  runtimeFile: string;
  host: string;
  port: number;
  baseUrl: string;
  consoleHost: string;
  consolePort: number;
  consoleUrl: string;
  autoSyncHarnesses: boolean;
}

export function expandHome(inputPath: string): string {
  if (inputPath === "~") return os.homedir();
  if (inputPath.startsWith("~/") || inputPath.startsWith("~\\")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}

function readYamlConfig(filePath: string): PartialConfigFile {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = YAML.parse(raw) ?? {};
  return configFileSchema.parse(parsed);
}

function resolveRepoConfigPath(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(currentDir, "..", "config.yml"),
    path.resolve(currentDir, "..", "..", "config.yml"),
    path.resolve(process.cwd(), "config.yml"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0];
}

export function resolveConfig(overrides?: {
  configFile?: string;
  homeDir?: string;
  host?: string;
  port?: number;
  consoleHost?: string;
  consolePort?: number;
  consoleUrl?: string;
  autoSyncHarnesses?: boolean;
}): MetaRelayConfig {
  const repoConfigFile = path.resolve(overrides?.configFile ?? resolveRepoConfigPath());
  const baseYaml = readYamlConfig(repoConfigFile);

  const initialHome = path.resolve(
    expandHome(
      overrides?.homeDir ??
        process.env.METARELAY_HOME ??
        baseYaml.storage?.home ??
        path.join(os.homedir(), "metarelay"),
    ),
  );

  const userConfigFile = path.join(initialHome, "config.yml");
  const userYaml = readYamlConfig(userConfigFile);

  const host =
    overrides?.host ??
    process.env.METARELAY_HOST ??
    userYaml.server?.host ??
    baseYaml.server?.host ??
    "127.0.0.1";

  const envPort =
    process.env.METARELAY_PORT !== undefined ? Number(process.env.METARELAY_PORT) : undefined;
  const rawPort =
    overrides?.port ??
    (envPort !== undefined && Number.isFinite(envPort) ? envPort : undefined) ??
    userYaml.server?.port ??
    baseYaml.server?.port ??
    3847;
  const port = Number.isFinite(rawPort) && rawPort >= 0 ? rawPort : 3847;

  const consoleHost =
    overrides?.consoleHost ??
    process.env.METARELAY_CONSOLE_HOST ??
    userYaml.console?.host ??
    baseYaml.console?.host ??
    "127.0.0.1";

  const envConsolePort =
    process.env.METARELAY_CONSOLE_PORT !== undefined
      ? Number(process.env.METARELAY_CONSOLE_PORT)
      : undefined;
  const consolePort =
    overrides?.consolePort ??
    (envConsolePort !== undefined && Number.isFinite(envConsolePort)
      ? envConsolePort
      : undefined) ??
    userYaml.console?.port ??
    baseYaml.console?.port ??
    5173;

  const baseUrl = `http://${host}:${port}`;
  const consoleUrl =
    overrides?.consoleUrl ??
    process.env.METARELAY_CONSOLE_URL ??
    `http://${consoleHost}:${consolePort}`;

  const envAutoSync = process.env.METARELAY_AUTO_SYNC_HARNESSES;
  const autoSyncHarnesses =
    overrides?.autoSyncHarnesses ??
    (envAutoSync !== undefined ? envAutoSync !== "false" && envAutoSync !== "0" : undefined) ??
    userYaml.harnesses?.autoSyncOnStart ??
    baseYaml.harnesses?.autoSyncOnStart ??
    true;

  const mcpDir = path.join(initialHome, "mcp");
  const memoryDir = path.join(initialHome, "memory");
  const stateDir = path.join(initialHome, ".state");

  return {
    repoConfigFile,
    userConfigFile,
    homeDir: initialHome,
    mcpDir,
    memoryDir,
    serversFile: path.join(mcpDir, "servers.yaml"),
    stateDir,
    secretsFile: path.join(stateDir, "secrets.json"),
    oauthDir: path.join(stateDir, "oauth"),
    runtimeFile: path.join(stateDir, "runtime.json"),
    host,
    port,
    baseUrl,
    consoleHost,
    consolePort,
    consoleUrl,
    autoSyncHarnesses,
  };
}
