import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import YAML from "yaml";

interface ConfigFileShape {
  server?: { host?: string; port?: number };
  console?: { host?: string; port?: number };
  storage?: { home?: string };
}

function readYaml(filePath: string): ConfigFileShape {
  if (!fs.existsSync(filePath)) return {};
  return (YAML.parse(fs.readFileSync(filePath, "utf8")) as ConfigFileShape | null) ?? {};
}

function expandHome(p: string): string {
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoConfig = readYaml(path.resolve(currentDir, "..", "config.yml"));
const homeDir = expandHome(
  process.env.METARELAY_HOME ?? repoConfig.storage?.home ?? path.join(os.homedir(), "metarelay"),
);
const userConfig = readYaml(path.join(homeDir, "config.yml"));

const serverHost =
  process.env.METARELAY_HOST ?? userConfig.server?.host ?? repoConfig.server?.host ?? "127.0.0.1";
const serverPort = Number(
  process.env.METARELAY_PORT ?? userConfig.server?.port ?? repoConfig.server?.port ?? 3847,
);
const consoleHost =
  process.env.METARELAY_CONSOLE_HOST ??
  userConfig.console?.host ??
  repoConfig.console?.host ??
  "127.0.0.1";
const consolePort = Number(
  process.env.METARELAY_CONSOLE_PORT ??
    userConfig.console?.port ??
    repoConfig.console?.port ??
    5173,
);
const daemonTarget = process.env.METARELAY_DAEMON_URL ?? `http://${serverHost}:${serverPort}`;

export default defineConfig({
  plugins: [react()],
  server: {
    host: consoleHost,
    port: consolePort,
    proxy: {
      "/api": daemonTarget,
      "/mcp": daemonTarget,
    },
  },
});
