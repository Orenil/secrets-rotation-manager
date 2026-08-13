export type SecretStatus = 'active' | 'retiring' | 'revoked';

export interface SecretRow {
  id: number;
  secretName: string;
  roleName: string;
  status: SecretStatus;
  createdAt: Date;
  revokedAt: Date | null;
}

/** What a dependent's RotatingSecretClient receives from GET /secrets/:name/active. */
export interface SecretConnectionPayload {
  secretName: string;
  roleName: string;
  password: string;
  host: string;
  port: number;
  database: string;
  status: SecretStatus;
}
