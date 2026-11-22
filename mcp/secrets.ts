import fs from "node:fs/promises";
import path from "node:path";

const SECRET_REF_PREFIX = "${secret:";
const SECRET_REF_REGEX = /\$\{secret:([a-zA-Z0-9._:-]+)\}/g;
const ENV_REF_REGEX = /\$\{([A-Z0-9_]+)\}/g;

export function makeSecretRef(secretKey: string): string {
  return `${SECRET_REF_PREFIX}${secretKey}}`;
}

export function extractSecretKey(value: string): string | null {
  if (!value.startsWith(SECRET_REF_PREFIX) || !value.endsWith("}")) {
    return null;
  }
  const inner = value.slice(SECRET_REF_PREFIX.length, -1);
  return /^[a-zA-Z0-9._:-]+$/.test(inner) ? inner : null;
}

export class SecretStore {
  private readonly filePath: string;
  private cache: Record<string, string> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  private async ensureLoaded(): Promise<Record<string, string>> {
    if (this.cache !== null) {
      return this.cache;
    }
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const clean: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === "string") {
            clean[k] = v;
          }
        }
        this.cache = clean;
      } else {
        this.cache = {};
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.cache = {};
      } else {
        throw err;
      }
    }
    return this.cache;
  }

  private async persist(): Promise<void> {
    const data = this.cache ?? {};
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.chmod(tmp, 0o600);
    await fs.rename(tmp, this.filePath);
  }

  async get(key: string): Promise<string | undefined> {
    const store = await this.ensureLoaded();
    return store[key];
  }

  async has(key: string): Promise<boolean> {
    const store = await this.ensureLoaded();
    return typeof store[key] === "string" && store[key].length > 0;
  }

  async set(key: string, value: string): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      const store = await this.ensureLoaded();
      store[key] = value;
      await this.persist();
    });
    return this.writeQueue;
  }

  async delete(key: string): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      const store = await this.ensureLoaded();
      if (key in store) {
        delete store[key];
        await this.persist();
      }
    });
    return this.writeQueue;
  }

  async deleteByPrefix(prefix: string): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      const store = await this.ensureLoaded();
      let changed = false;
      for (const k of Object.keys(store)) {
        if (k.startsWith(prefix)) {
          delete store[k];
          changed = true;
        }
      }
      if (changed) {
        await this.persist();
      }
    });
    return this.writeQueue;
  }

  /**
   * Resolves `${secret:<key>}` from the 0600 store and `${ENV_VAR}` from process.env.
   */
  async resolveString(template: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
    const store = await this.ensureLoaded();
    const withSecrets = template.replace(SECRET_REF_REGEX, (_match, key: string) => {
      const val = store[key];
      if (val === undefined) {
        throw new Error(`Missing secret "${key}" in MetaRelay secret store`);
      }
      return val;
    });
    return withSecrets.replace(ENV_REF_REGEX, (_match, varName: string) => {
      const val = env[varName];
      return val ?? "";
    });
  }
}
