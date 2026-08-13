import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PgService, assertValidIdentifier } from '../db/pg.service';
import { EncryptionService } from '../crypto/encryption.service';
import { SecretRow, SecretStatus, SecretConnectionPayload } from './secrets.types';

interface SecretDbRow {
  id: number;
  secret_name: string;
  role_name: string;
  encrypted_password: Buffer;
  iv: Buffer;
  auth_tag: Buffer;
  status: SecretStatus;
  created_at: Date;
  revoked_at: Date | null;
}

function toRow(r: SecretDbRow): SecretRow {
  return {
    id: r.id,
    secretName: r.secret_name,
    roleName: r.role_name,
    status: r.status,
    createdAt: r.created_at,
    revokedAt: r.revoked_at,
  };
}

/**
 * Encrypted-at-rest store for generated Postgres credentials. Every
 * credential is persisted as AES-256-GCM ciphertext (EncryptionService) -
 * plaintext passwords only ever exist transiently in process memory and in
 * the HTTP response body handed to an authenticated dependent.
 */
@Injectable()
export class SecretsService {
  constructor(
    private readonly pg: PgService,
    private readonly crypto: EncryptionService,
    private readonly config: ConfigService,
  ) {}

  async create(secretName: string, roleName: string, password: string): Promise<SecretRow> {
    assertValidIdentifier(secretName, 'secret name');
    assertValidIdentifier(roleName, 'role name');
    const { ciphertext, iv, authTag } = this.crypto.encrypt(password);
    const { rows } = await this.pg.query<SecretDbRow>(
      `INSERT INTO secrets (secret_name, role_name, encrypted_password, iv, auth_tag, status)
       VALUES ($1, $2, $3, $4, $5, 'active')
       RETURNING *`,
      [secretName, roleName, ciphertext, iv, authTag],
    );
    return toRow(rows[0]);
  }

  async getActiveByName(secretName: string): Promise<SecretRow> {
    const { rows } = await this.pg.query<SecretDbRow>(
      `SELECT * FROM secrets WHERE secret_name = $1 AND status = 'active'
       ORDER BY created_at DESC LIMIT 1`,
      [secretName],
    );
    if (rows.length === 0) {
      throw new NotFoundException(`No active secret named "${secretName}"`);
    }
    return toRow(rows[0]);
  }

  async hasAny(secretName: string): Promise<boolean> {
    const { rows } = await this.pg.query(
      `SELECT 1 FROM secrets WHERE secret_name = $1 LIMIT 1`,
      [secretName],
    );
    return rows.length > 0;
  }

  async listByName(secretName: string): Promise<SecretRow[]> {
    const { rows } = await this.pg.query<SecretDbRow>(
      `SELECT * FROM secrets WHERE secret_name = $1 ORDER BY created_at DESC`,
      [secretName],
    );
    return rows.map(toRow);
  }

  async getById(id: number): Promise<SecretRow> {
    const { rows } = await this.pg.query<SecretDbRow>(`SELECT * FROM secrets WHERE id = $1`, [id]);
    if (rows.length === 0) throw new NotFoundException(`No secret with id ${id}`);
    return toRow(rows[0]);
  }

  async markRetiring(id: number): Promise<void> {
    await this.pg.query(`UPDATE secrets SET status = 'retiring' WHERE id = $1`, [id]);
  }

  async markRevoked(id: number): Promise<void> {
    await this.pg.query(
      `UPDATE secrets SET status = 'revoked', revoked_at = now() WHERE id = $1`,
      [id],
    );
  }

  /** Decrypts the stored password for a raw db row - internal use only
   * (rotation service needs it to build the connection payload). */
  private async decryptById(id: number): Promise<string> {
    const { rows } = await this.pg.query<SecretDbRow>(`SELECT * FROM secrets WHERE id = $1`, [id]);
    if (rows.length === 0) throw new NotFoundException(`No secret with id ${id}`);
    const r = rows[0];
    return this.crypto.decrypt({ ciphertext: r.encrypted_password, iv: r.iv, authTag: r.auth_tag });
  }

  /** What GET /secrets/:name/active hands back to a dependent's
   * RotatingSecretClient: the currently-active credential plus enough
   * connection info to reach the target database directly. */
  async getConnectionPayload(secretName: string): Promise<SecretConnectionPayload> {
    const active = await this.getActiveByName(secretName);
    const password = await this.decryptById(active.id);
    return {
      secretName: active.secretName,
      roleName: active.roleName,
      password,
      host: this.config.get<string>('APP_DB_HOST')!,
      port: Number(this.config.get<string>('APP_DB_PORT')),
      database: this.config.get<string>('APP_DB_NAME')!,
      status: active.status,
    };
  }
}
