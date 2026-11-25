import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveVerifiedBaseUrl, runCli } from "../commands.js";
import { resolveConfig } from "../../mcp/config.js";
import { writeRuntimeState } from "../../mcp/harness-sync.js";
import { createMetaRelayDaemon } from "../../mcp/server.js";
import { completeArgs, generateCompletionScript } from "../completion.js";
import {
  buildOpenUrlCommand,
  detectShell,
  getCompletionInstallHint,
  resolvePlatformHomeDir,
  type PlatformContext,
} from "../platform.js";

async function makeTempHome(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "metarelay-cli-test-"));
}

function createCaptureIo(extra?: Partial<Parameters<typeof runCli>[1]>) {
  let out = "";
  let err = "";
  return {
    io: {
      stdout: (t: string) => {
        out += t;
      },
      stderr: (t: string) => {
        err += t;
      },
      ...extra,
    },
    getOut: () => out,
    getErr: () => err,
  };
}

test("Linux platform: browser open, shell detection, completion paths, and home resolution", () => {
  const linuxCtx: PlatformContext = {
    platform: "linux",
    homeDir: "/home/alice",
    env: { SHELL: "/bin/bash" },
  };

  assert.deepEqual(buildOpenUrlCommand("https://example.com/oauth?a=1&b=2", "linux"), {
    command: "xdg-open",
    args: ["https://example.com/oauth?a=1&b=2"],
    shell: false,
  });

  assert.equal(detectShell(linuxCtx), "bash");
  assert.equal(
    detectShell({ ...linuxCtx, env: { SHELL: "/usr/bin/fish" } }),
    "fish",
  );

  const bashHint = getCompletionInstallHint("bash", linuxCtx);
  assert.equal(bashHint.filePath, "/home/alice/.bashrc");
  assert.match(bashHint.instructions, /metarelay completion bash/);

  const fishHint = getCompletionInstallHint("fish", linuxCtx);
  assert.equal(fishHint.filePath, "/home/alice/.config/fish/completions/metarelay.fish");

  assert.equal(resolvePlatformHomeDir("~/metarelay", linuxCtx), "/home/alice/metarelay");
});

test("macOS (darwin) platform: browser open, default zsh, completion paths, and home resolution", () => {
  const macCtx: PlatformContext = {
    platform: "darwin",
    homeDir: "/Users/alice",
    env: {},
  };

  assert.deepEqual(buildOpenUrlCommand("https://example.com/oauth?a=1&b=2", "darwin"), {
    command: "open",
    args: ["https://example.com/oauth?a=1&b=2"],
    shell: false,
  });

  assert.equal(detectShell(macCtx), "zsh");

  const zshHint = getCompletionInstallHint("zsh", macCtx);
  assert.equal(zshHint.filePath, "/Users/alice/.zshrc");
  assert.match(zshHint.instructions, /metarelay completion zsh/);

  const bashHint = getCompletionInstallHint("bash", macCtx);
  assert.equal(bashHint.filePath, "/Users/alice/.bash_profile");

  assert.equal(resolvePlatformHomeDir("~/metarelay", macCtx), "/Users/alice/metarelay");
});

test("Windows (win32) platform: cmd start escaping, PowerShell detection, profile path, and home resolution", () => {
  const winCtx: PlatformContext = {
    platform: "win32",
    homeDir: "C:\\Users\\alice",
    env: {},
  };

  assert.deepEqual(buildOpenUrlCommand("https://example.com/oauth?a=1&b=2", "win32"), {
    command: "cmd",
    args: ["/c", "start", "", "https://example.com/oauth?a=1^&b=2"],
    shell: false,
  });

  assert.throws(
    () => buildOpenUrlCommand("file:///etc/passwd", "win32"),
    /Unsupported URL protocol/,
  );

  assert.equal(detectShell(winCtx), "powershell");

  const psHint = getCompletionInstallHint("powershell", winCtx);
  assert.equal(
    psHint.filePath,
    "C:\\Users\\alice\\Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1",
  );
  assert.match(psHint.instructions, /metarelay completion powershell/);

  assert.equal(resolvePlatformHomeDir("~/metarelay", winCtx), "C:\\Users\\alice\\metarelay");
  assert.equal(resolvePlatformHomeDir("~\\metarelay", winCtx), "C:\\Users\\alice\\metarelay");
});

test("Tab completion resolves commands, subcommands, flags, presets, and live server IDs", async () => {
  const ctx = {
    getServerIds: () => ["github", "linear", "open-design"],
  };

  assert.deepEqual(await completeArgs(["st"], ctx), ["start", "status"]);
  assert.deepEqual(await completeArgs(["mcp", ""], ctx), [
    "list",
    "presets",
    "add",
    "remove",
    "reconnect",
    "auth",
  ]);
  assert.deepEqual(await completeArgs(["mcp", "add", "--preset", "li"], ctx), ["linear"]);
  assert.deepEqual(await completeArgs(["mcp", "add", "--transport", "s"], ctx), ["sse", "stdio"]);
  assert.deepEqual(await completeArgs(["mcp", "add", "--auth", "o"], ctx), ["oauth"]);
  assert.deepEqual(await completeArgs(["mcp", "remove", "open"], ctx), ["open-design"]);
  assert.deepEqual(await completeArgs(["mcp", "auth", ""], ctx), [
    "github",
    "linear",
    "open-design",
  ]);
  assert.deepEqual(await completeArgs(["completion", "p"], ctx), ["powershell"]);

  for (const shell of ["bash", "zsh", "fish", "powershell"] as const) {
    const script = generateCompletionScript(shell);
    assert.match(script, /metarelay __complete/);
  }
});

test("CLI commands: completion scripts, offline mcp add/list/__complete/remove, and OAuth browser launch", async () => {
  const home = await makeTempHome();
  try {
    const offlineFetch: typeof fetch = async () => {
      throw new Error("ECONNREFUSED");
    };

    // 1. completion auto-detects PowerShell on Windows
    const compWin = createCaptureIo({
      platformCtx: { platform: "win32", homeDir: "C:\\Users\\dev", env: {} },
    });
    assert.equal(await runCli(["completion"], compWin.io), 0);
    assert.match(compWin.getOut(), /Register-ArgumentCompleter/);

    // 2. mcp add --preset linear (offline fallback writes servers.yaml)
    const addCap = createCaptureIo({
      fetchImpl: offlineFetch,
      configOverrides: { homeDir: home, port: 59999 },
    });
    assert.equal(await runCli(["mcp", "add", "--preset", "linear"], addCap.io), 0);
    assert.match(addCap.getOut(), /Added MCP server "linear"/);

    // 3. __complete dynamically sees "linear" from servers.yaml
    const completeCap = createCaptureIo({
      configOverrides: { homeDir: home, port: 59999 },
    });
    assert.equal(await runCli(["__complete", "mcp", "remove", "lin"], completeCap.io), 0);
    assert.equal(completeCap.getOut().trim(), "linear");

    // 4. mcp list shows linear
    const listCap = createCaptureIo({
      fetchImpl: offlineFetch,
      configOverrides: { homeDir: home, port: 59999 },
    });
    assert.equal(await runCli(["mcp", "list"], listCap.io), 0);
    assert.match(listCap.getOut(), /linear/);

    // 5. mcp auth opens browser with authorizeUrl from verified live daemon
    let openedUrl = "";
    const cfgForAuth = resolveConfig({ homeDir: home, port: 59999 });
    await writeRuntimeState(cfgForAuth.runtimeFile, {
      instanceId: "test-inst-1",
      pid: process.pid,
      host: "127.0.0.1",
      port: 59999,
      mcpEndpoint: "http://127.0.0.1:59999/mcp",
      harnesses: [],
    });
    const mockAuthFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/api/health")) {
        return new Response(
          JSON.stringify({ ok: true, service: "metarelay", instanceId: "test-inst-1" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ authorizeUrl: "https://auth.linear.app/authorize?x=1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const authCap = createCaptureIo({
      fetchImpl: mockAuthFetch,
      openBrowser: async (u) => {
        openedUrl = u;
      },
      configOverrides: { homeDir: home, port: 59999 },
    });
    assert.equal(await runCli(["mcp", "auth", "linear"], authCap.io), 0);
    assert.equal(openedUrl, "https://auth.linear.app/authorize?x=1");
    await fs.unlink(cfgForAuth.runtimeFile);

    // 6. mcp remove linear cleans it up
    const rmCap = createCaptureIo({
      fetchImpl: offlineFetch,
      configOverrides: { homeDir: home, port: 59999 },
    });
    assert.equal(await runCli(["mcp", "remove", "linear"], rmCap.io), 0);
    assert.match(rmCap.getOut(), /Removed MCP server "linear"/);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("Runtime discovery verifies live daemon port via instanceId and rejects stale/lying runtime.json", async () => {
  const home = await makeTempHome();
  const daemon = await createMetaRelayDaemon({
    homeDir: home,
    port: 0, // ephemeral port different from config.yml's 3847
    watchRegistry: false,
    serveConsole: false,
    syncHarnesses: false,
  });

  try {
    await daemon.start();
    const livePort = daemon.config.port;
    assert.notEqual(livePort, 3847);

    // CLI configured with default port 3847 still discovers the live daemon on livePort via runtime.json
    const statusCap = createCaptureIo({
      configOverrides: { homeDir: home, port: 3847 },
    });
    assert.equal(await runCli(["status", "--json"], statusCap.io), 0);
    const statusJson = JSON.parse(statusCap.getOut()) as { ok: boolean; mcpEndpoint: string };
    assert.equal(statusJson.ok, true);
    assert.equal(statusJson.mcpEndpoint, `http://127.0.0.1:${livePort}/mcp`);

    // Lying runtime.json (wrong instanceId — e.g. another process or stale restart) is rejected
    const cfg = resolveConfig({ homeDir: home, port: 3847 });
    await writeRuntimeState(cfg.runtimeFile, {
      instanceId: "forged-stale-id",
      pid: process.pid,
      host: "127.0.0.1",
      port: livePort,
      mcpEndpoint: `http://127.0.0.1:${livePort}/mcp`,
      harnesses: [],
    });
    const rejected = await resolveVerifiedBaseUrl(cfg, fetch);
    assert.equal(rejected, null);

    // Clean stop removes runtime.json
    await daemon.stop();
    await assert.rejects(() => fs.stat(cfg.runtimeFile));
  } finally {
    await daemon.stop().catch(() => {});
    await fs.rm(home, { recursive: true, force: true });
  }
});
