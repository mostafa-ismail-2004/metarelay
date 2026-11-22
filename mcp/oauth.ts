import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import type {
  OAuthClientInformationContext,
  OAuthClientMetadata,
  OAuthClientProvider,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";

interface PersistedOAuthState {
  clientInfoByIssuer: Record<string, StoredOAuthClientInformation>;
  latestClientInfo?: StoredOAuthClientInformation;
  tokensByIssuer: Record<string, StoredOAuthTokens>;
  latestTokens?: StoredOAuthTokens;
  codeVerifier?: string;
  pendingState?: string;
  updatedAt: number;
}

export interface OAuthProviderOptions {
  serverId: string;
  oauthDir: string;
  redirectUrl: string;
  clientId?: string;
  clientSecret?: string;
  scopes?: string[];
}

export class MetaRelayOAuthProvider implements OAuthClientProvider {
  readonly serverId: string;
  private readonly filePath: string;
  private readonly _redirectUrl: string;
  private readonly staticClientId?: string;
  private readonly staticClientSecret?: string;
  private readonly scopes?: string[];
  private cache: PersistedOAuthState | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private _pendingAuthorizationUrl: URL | null = null;

  constructor(options: OAuthProviderOptions) {
    this.serverId = options.serverId;
    this.filePath = path.join(options.oauthDir, `${options.serverId}.json`);
    this._redirectUrl = options.redirectUrl;
    this.staticClientId = options.clientId;
    this.staticClientSecret = options.clientSecret;
    this.scopes = options.scopes;
  }

  get redirectUrl(): string {
    return this._redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: `MetaRelay (${this.serverId})`,
      redirect_uris: [this._redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.staticClientSecret ? "client_secret_post" : "none",
      ...(this.scopes && this.scopes.length > 0 ? { scope: this.scopes.join(" ") } : {}),
    };
  }

  get pendingAuthorizationUrl(): URL | null {
    return this._pendingAuthorizationUrl;
  }

  clearPendingAuthorizationUrl(): void {
    this._pendingAuthorizationUrl = null;
  }

  private async loadState(): Promise<PersistedOAuthState> {
    if (this.cache) {
      return this.cache;
    }
    try {
      const raw = await fsp.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedOAuthState>;
      this.cache = {
        clientInfoByIssuer: parsed.clientInfoByIssuer ?? {},
        latestClientInfo: parsed.latestClientInfo,
        tokensByIssuer: parsed.tokensByIssuer ?? {},
        latestTokens: parsed.latestTokens,
        codeVerifier: parsed.codeVerifier,
        pendingState: parsed.pendingState,
        updatedAt: parsed.updatedAt ?? Date.now(),
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.cache = {
          clientInfoByIssuer: {},
          tokensByIssuer: {},
          updatedAt: Date.now(),
        };
      } else {
        throw err;
      }
    }
    return this.cache;
  }

  private async saveState(state: PersistedOAuthState): Promise<void> {
    state.updatedAt = Date.now();
    this.cache = state;
    this.writeQueue = this.writeQueue.then(async () => {
      await fsp.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(state, null, 2) + "\n", {
        encoding: "utf8",
        mode: 0o600,
      });
      await fsp.chmod(tmp, 0o600);
      await fsp.rename(tmp, this.filePath);
    });
    return this.writeQueue;
  }

  async state(): Promise<string> {
    const state = await this.loadState();
    const token = crypto.randomBytes(24).toString("base64url");
    state.pendingState = token;
    await this.saveState(state);
    return token;
  }

  async verifyState(receivedState: string | null): Promise<boolean> {
    const state = await this.loadState();
    if (!state.pendingState) {
      return true;
    }
    if (!receivedState) {
      return false;
    }
    const expected = Buffer.from(state.pendingState);
    const actual = Buffer.from(receivedState);
    if (expected.length !== actual.length) {
      return false;
    }
    return crypto.timingSafeEqual(expected, actual);
  }

  async clientInformation(
    ctx?: OAuthClientInformationContext,
  ): Promise<StoredOAuthClientInformation | undefined> {
    if (this.staticClientId) {
      return {
        client_id: this.staticClientId,
        ...(this.staticClientSecret ? { client_secret: this.staticClientSecret } : {}),
      };
    }
    const state = await this.loadState();
    if (ctx?.issuer && state.clientInfoByIssuer[ctx.issuer]) {
      return state.clientInfoByIssuer[ctx.issuer];
    }
    return state.latestClientInfo;
  }

  async saveClientInformation(
    clientInformation: StoredOAuthClientInformation,
    ctx?: OAuthClientInformationContext,
  ): Promise<void> {
    const state = await this.loadState();
    if (ctx?.issuer) {
      state.clientInfoByIssuer[ctx.issuer] = clientInformation;
    }
    state.latestClientInfo = clientInformation;
    await this.saveState(state);
  }

  async tokens(ctx?: OAuthClientInformationContext): Promise<StoredOAuthTokens | undefined> {
    const state = await this.loadState();
    if (ctx?.issuer && state.tokensByIssuer[ctx.issuer]) {
      return state.tokensByIssuer[ctx.issuer];
    }
    return state.latestTokens;
  }

  async saveTokens(
    tokens: StoredOAuthTokens,
    ctx?: OAuthClientInformationContext,
  ): Promise<void> {
    const state = await this.loadState();
    if (ctx?.issuer) {
      state.tokensByIssuer[ctx.issuer] = tokens;
    }
    state.latestTokens = tokens;
    state.pendingState = undefined;
    await this.saveState(state);
  }

  async hasTokens(): Promise<boolean> {
    const t = await this.tokens();
    return Boolean(t?.access_token);
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    this._pendingAuthorizationUrl = authorizationUrl;
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    const state = await this.loadState();
    state.codeVerifier = codeVerifier;
    await this.saveState(state);
  }

  async codeVerifier(): Promise<string> {
    const state = await this.loadState();
    if (!state.codeVerifier) {
      throw new Error(`Missing OAuth PKCE code verifier for server "${this.serverId}"`);
    }
    return state.codeVerifier;
  }

  async clear(): Promise<void> {
    this.cache = null;
    this._pendingAuthorizationUrl = null;
    try {
      await fsp.unlink(this.filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
  }
}
