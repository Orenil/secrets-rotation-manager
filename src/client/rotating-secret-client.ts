export interface SecretConnectionPayload {
  secretName: string;
  roleName: string;
  password: string;
  host: string;
  port: number;
  database: string;
  status: 'active' | 'retiring' | 'revoked';
}

export interface RotatingSecretClientOptions {
  apiBaseUrl: string;
  secretName: string;
  /** How long a fetched credential is trusted before the client re-hits
   * the API. This TTL - not a redeploy - is how a dependent picks up a
   * rotated credential. */
  ttlMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Short-TTL cached secret client for dependent services. Mirrors how a
 * Vault dynamic-secret lease client behaves: never bakes a credential into
 * env vars, always trusts its cache only for `ttlMs`, and transparently
 * re-fetches on expiry so rotation propagates without redeploying every
 * dependent.
 */
export class RotatingSecretClient {
  private readonly apiBaseUrl: string;
  private readonly secretName: string;
  private readonly ttlMs: number;
  private readonly fetchImpl: typeof fetch;
  private cached: { value: SecretConnectionPayload; expiresAt: number } | null = null;
  private inFlight: Promise<SecretConnectionPayload> | null = null;

  constructor(options: RotatingSecretClientOptions) {
    this.apiBaseUrl = options.apiBaseUrl.replace(/\/$/, '');
    this.secretName = options.secretName;
    this.ttlMs = options.ttlMs ?? 5000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Returns the cached credential while it's within TTL; otherwise fetches
   * a fresh one. Concurrent callers during a refresh share one in-flight
   * request instead of stampeding the API. */
  async getCredential(): Promise<SecretConnectionPayload> {
    const now = Date.now();
    if (this.cached && this.cached.expiresAt > now) {
      return this.cached.value;
    }
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.fetchFresh().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async fetchFresh(): Promise<SecretConnectionPayload> {
    const res = await this.fetchImpl(`${this.apiBaseUrl}/secrets/${this.secretName}/active`);
    if (!res.ok) {
      throw new Error(`RotatingSecretClient: failed to fetch "${this.secretName}" (HTTP ${res.status})`);
    }
    const value = (await res.json()) as SecretConnectionPayload;
    this.cached = { value, expiresAt: Date.now() + this.ttlMs };
    return value;
  }

  /** Forces the next getCredential() to bypass the cache. Not used by the
   * rotation flow itself (which relies on natural TTL expiry to prove
   * zero-redeploy propagation) - useful for tests and manual cache-busting. */
  invalidate(): void {
    this.cached = null;
  }

  get cachedUntil(): number | null {
    return this.cached?.expiresAt ?? null;
  }
}
