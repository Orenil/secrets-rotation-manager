import { Injectable } from '@nestjs/common';
import { PgService } from '../db/pg.service';
import { AlertRow } from './rotation.types';

interface AlertDbRow {
  id: number;
  rotation_id: number;
  message: string;
  created_at: Date;
}

function toRow(r: AlertDbRow): AlertRow {
  return { id: r.id, rotationId: r.rotation_id, message: r.message, createdAt: r.created_at };
}

@Injectable()
export class AlertsService {
  constructor(private readonly pg: PgService) {}

  /** One alert per rotation (unique constraint) - the forced-failure path
   * calls this every poll cycle while a dependent lingers on the old
   * credential, but only the first call actually inserts a row. */
  async createIfMissing(rotationId: number, message: string): Promise<AlertRow | null> {
    const { rows } = await this.pg.query<AlertDbRow>(
      `INSERT INTO alerts (rotation_id, message) VALUES ($1, $2)
       ON CONFLICT (rotation_id) DO NOTHING
       RETURNING *`,
      [rotationId, message],
    );
    return rows[0] ? toRow(rows[0]) : null;
  }

  async getForRotation(rotationId: number): Promise<AlertRow | null> {
    const { rows } = await this.pg.query<AlertDbRow>(`SELECT * FROM alerts WHERE rotation_id = $1`, [
      rotationId,
    ]);
    return rows[0] ? toRow(rows[0]) : null;
  }

  async listAll(): Promise<AlertRow[]> {
    const { rows } = await this.pg.query<AlertDbRow>(`SELECT * FROM alerts ORDER BY created_at DESC`);
    return rows.map(toRow);
  }
}
