import { Injectable } from '@nestjs/common';
import { PgService } from '../db/pg.service';
import { RotationRow, RotationState } from './rotation.types';

interface RotationDbRow {
  id: number;
  secret_name: string;
  old_secret_id: number;
  new_secret_id: number;
  state: RotationState;
  grace_period_ends_at: Date;
  consecutive_zero_checks: number;
  created_at: Date;
  completed_at: Date | null;
}

function toRow(r: RotationDbRow): RotationRow {
  return {
    id: r.id,
    secretName: r.secret_name,
    oldSecretId: r.old_secret_id,
    newSecretId: r.new_secret_id,
    state: r.state,
    gracePeriodEndsAt: r.grace_period_ends_at,
    consecutiveZeroChecks: r.consecutive_zero_checks,
    createdAt: r.created_at,
    completedAt: r.completed_at,
  };
}

@Injectable()
export class RotationsRepo {
  constructor(private readonly pg: PgService) {}

  async insert(
    secretName: string,
    oldSecretId: number,
    newSecretId: number,
    gracePeriodEndsAt: Date,
  ): Promise<RotationRow> {
    const { rows } = await this.pg.query<RotationDbRow>(
      `INSERT INTO rotations (secret_name, old_secret_id, new_secret_id, grace_period_ends_at)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [secretName, oldSecretId, newSecretId, gracePeriodEndsAt],
    );
    return toRow(rows[0]);
  }

  async getById(id: number): Promise<RotationRow> {
    const { rows } = await this.pg.query<RotationDbRow>(`SELECT * FROM rotations WHERE id = $1`, [id]);
    if (!rows[0]) throw new Error(`No rotation with id ${id}`);
    return toRow(rows[0]);
  }

  async getLatestForSecret(secretName: string): Promise<RotationRow | null> {
    const { rows } = await this.pg.query<RotationDbRow>(
      `SELECT * FROM rotations WHERE secret_name = $1 ORDER BY created_at DESC LIMIT 1`,
      [secretName],
    );
    return rows[0] ? toRow(rows[0]) : null;
  }

  async setState(id: number, state: RotationState, completed = false): Promise<void> {
    await this.pg.query(
      `UPDATE rotations
       SET state = $2, completed_at = CASE WHEN $3 THEN now() ELSE completed_at END
       WHERE id = $1`,
      [id, state, completed],
    );
  }

  /** Atomically bumps (or resets) the consecutive-zero-usage counter and
   * returns the new value, so the telemetry loop can require N consecutive
   * zero-connection readings before treating "unused" as confirmed. */
  async recordZeroCheck(id: number, isZero: boolean): Promise<number> {
    const { rows } = await this.pg.query<{ consecutive_zero_checks: number }>(
      `UPDATE rotations
       SET consecutive_zero_checks = CASE WHEN $2 THEN consecutive_zero_checks + 1 ELSE 0 END
       WHERE id = $1
       RETURNING consecutive_zero_checks`,
      [id, isZero],
    );
    return rows[0].consecutive_zero_checks;
  }
}
