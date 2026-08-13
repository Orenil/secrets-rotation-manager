import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, QueryResultRow } from 'pg';

/**
 * Single admin-privileged connection pool used both for control-plane
 * tables (secrets/rotations/telemetry/alerts) and for the Postgres admin
 * operations rotation requires: CREATE ROLE, GRANT, REVOKE, DROP ROLE, and
 * reading pg_stat_activity for live usage telemetry. In production this
 * would be a narrowly-scoped, short-lived Vault admin lease rather than a
 * static superuser connection string - see README "Rejected tradeoffs".
 */
@Injectable()
export class PgService implements OnModuleDestroy {
  readonly pool: Pool;

  constructor(config: ConfigService) {
    this.pool = new Pool({
      connectionString: config.get<string>('DATABASE_URL'),
      max: 10,
    });
  }

  query<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]) {
    return this.pool.query<T>(text, params);
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}

const IDENTIFIER_RE = /^[a-z][a-z0-9_]{0,62}$/;

/** Defends against SQL injection in identifiers we splice into DDL, even
 * though every caller today builds these names internally rather than
 * from raw user input. */
export function assertValidIdentifier(name: string, kind: string): void {
  if (!IDENTIFIER_RE.test(name)) {
    throw new Error(`Invalid ${kind} "${name}": must match ${IDENTIFIER_RE}`);
  }
}
