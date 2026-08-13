import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { PgService, assertValidIdentifier } from '../db/pg.service';
import { SecretsService } from '../secrets/secrets.service';
import { RotationsRepo } from './rotations.repo';
import { TelemetryService } from './telemetry.service';
import { RotationRow } from './rotation.types';

@Injectable()
export class RotationService {
  private readonly logger = new Logger(RotationService.name);
  private readonly gracePeriodMs: number;

  constructor(
    private readonly pg: PgService,
    private readonly secrets: SecretsService,
    private readonly rotations: RotationsRepo,
    private readonly telemetry: TelemetryService,
    config: ConfigService,
  ) {
    this.gracePeriodMs = Number(config.get<string>('ROTATION_GRACE_PERIOD_MS'));
  }

  /** Idempotently provisions a first credential for `secretName` so there
   * is something to rotate. Real deployments would run this once, out of
   * band, when onboarding a new dependent service. */
  async bootstrap(secretName: string): Promise<void> {
    assertValidIdentifier(secretName, 'secret name');
    if (await this.secrets.hasAny(secretName)) return;
    const roleName = this.newRoleName(secretName);
    const password = this.newPassword();
    await this.createLoginRole(roleName, password);
    await this.secrets.create(secretName, roleName, password);
    this.logger.log(`Bootstrapped initial credential "${roleName}" for secret "${secretName}"`);
  }

  /**
   * Dual-credential rotation, the core of the spec: provision a brand-new
   * Postgres role with a brand-new password (never mutate the existing
   * role's password in place - open connections on the old role are never
   * invalidated mid-transaction), publish it as the new active secret, and
   * leave the old role valid until TelemetryService confirms via real
   * pg_stat_activity usage that nothing depends on it anymore.
   */
  async startRotation(secretName: string): Promise<RotationRow> {
    assertValidIdentifier(secretName, 'secret name');
    const inFlight = await this.rotations.getLatestForSecret(secretName);
    if (inFlight && inFlight.state !== 'revoked') {
      throw new ConflictException(
        `Rotation ${inFlight.id} for "${secretName}" is still in progress (state=${inFlight.state})`,
      );
    }

    const current = await this.secrets.getActiveByName(secretName);
    const roleName = this.newRoleName(secretName);
    const password = this.newPassword();

    await this.createLoginRole(roleName, password);
    const newSecret = await this.secrets.create(secretName, roleName, password);
    await this.secrets.markRetiring(current.id);

    const gracePeriodEndsAt = new Date(Date.now() + this.gracePeriodMs);
    const rotation = await this.rotations.insert(secretName, current.id, newSecret.id, gracePeriodEndsAt);

    this.telemetry.startMonitoring(rotation.id);
    this.logger.log(
      `Started rotation ${rotation.id} for "${secretName}": "${current.roleName}" -> "${roleName}", ` +
        `grace period ${this.gracePeriodMs}ms`,
    );
    return rotation;
  }

  getStatus(secretName: string): Promise<RotationRow | null> {
    return this.rotations.getLatestForSecret(secretName);
  }

  getById(id: number): Promise<RotationRow> {
    return this.rotations.getById(id);
  }

  private newRoleName(secretName: string): string {
    // Postgres folds/truncates identifiers at 63 bytes; stay well under that.
    return `${secretName}_${Date.now()}_${randomBytes(3).toString('hex')}`.slice(0, 60);
  }

  private newPassword(): string {
    return randomBytes(24).toString('base64url');
  }

  private async createLoginRole(roleName: string, password: string): Promise<void> {
    assertValidIdentifier(roleName, 'role name');
    // Postgres's CREATE ROLE ... PASSWORD clause requires a literal, not a
    // bind parameter, so we generate the password ourselves (never from
    // user input) and escape it as a quoted string literal rather than
    // trusting string interpolation of anything externally supplied.
    const escapedPassword = password.replace(/'/g, "''");
    await this.pg.query(`CREATE ROLE "${roleName}" WITH LOGIN PASSWORD '${escapedPassword}'`);
    await this.pg.query(`GRANT app_group TO "${roleName}"`);
  }
}
