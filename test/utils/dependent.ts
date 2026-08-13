import { Client as PgClient } from 'pg';
import { RotatingSecretClient, SecretConnectionPayload } from '../../src/client/rotating-secret-client';

export interface DependentStats {
  successCount: number;
  failureCount: number;
  errors: string[];
}

/** A realistic dependent service: fetches its credential through
 * RotatingSecretClient's TTL cache, holds one persistent Postgres
 * connection, and only reconnects when the credential it's holding
 * actually changed role - exactly how a real connection-pooled service
 * behaves during a rotation. */
export class LiveDependent {
  private readonly client: RotatingSecretClient;
  private pgClient: PgClient | null = null;
  private currentRole: string | null = null;
  private stopped = false;
  readonly stats: DependentStats = { successCount: 0, failureCount: 0, errors: [] };

  constructor(baseUrl: string, secretName: string, ttlMs: number) {
    this.client = new RotatingSecretClient({ apiBaseUrl: baseUrl, secretName, ttlMs });
  }

  async tick(): Promise<void> {
    try {
      const cred = await this.client.getCredential();
      await this.ensureConnected(cred);
      await this.pgClient!.query('INSERT INTO orders(note) VALUES ($1)', ['live-traffic']);
      this.stats.successCount += 1;
    } catch (err: any) {
      this.stats.failureCount += 1;
      this.stats.errors.push(err.message ?? String(err));
    }
  }

  private async ensureConnected(cred: SecretConnectionPayload): Promise<void> {
    if (this.pgClient && this.currentRole === cred.roleName) return;
    const stale = this.pgClient;
    const fresh = new PgClient({
      host: cred.host,
      port: cred.port,
      database: cred.database,
      user: cred.roleName,
      password: cred.password,
    });
    await fresh.connect();
    this.pgClient = fresh;
    this.currentRole = cred.roleName;
    if (stale) await stale.end().catch(() => undefined);
  }

  async runLoop(intervalMs: number): Promise<void> {
    while (!this.stopped) {
      await this.tick();
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  stop(): void {
    this.stopped = true;
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.pgClient) await this.pgClient.end().catch(() => undefined);
  }
}

/** A dependent that deliberately never refreshes its cached credential -
 * models a service that never confirms switchover during the grace period. */
export class StuckDependent {
  private pgClient: PgClient | null = null;
  private stopped = false;
  readonly stats: DependentStats = { successCount: 0, failureCount: 0, errors: [] };

  constructor(private readonly cred: SecretConnectionPayload) {}

  private async ensureConnected(): Promise<PgClient> {
    if (this.pgClient) return this.pgClient;
    const c = new PgClient({
      host: this.cred.host,
      port: this.cred.port,
      database: this.cred.database,
      user: this.cred.roleName,
      password: this.cred.password,
    });
    await c.connect();
    this.pgClient = c;
    return c;
  }

  async tick(): Promise<void> {
    try {
      const c = await this.ensureConnected();
      await c.query('INSERT INTO orders(note) VALUES ($1)', ['stuck-dependent']);
      this.stats.successCount += 1;
    } catch (err: any) {
      this.stats.failureCount += 1;
      this.stats.errors.push(err.message ?? String(err));
    }
  }

  async runLoop(intervalMs: number): Promise<void> {
    while (!this.stopped) {
      await this.tick();
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  stop(): void {
    this.stopped = true;
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.pgClient) await this.pgClient.end().catch(() => undefined);
  }
}
