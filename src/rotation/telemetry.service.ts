import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PgService, assertValidIdentifier } from '../db/pg.service';
import { SecretsService } from '../secrets/secrets.service';
import { RotationsRepo } from './rotations.repo';
import { AlertsService } from './alerts.service';
import { RotationRow } from './rotation.types';

/** Require this many consecutive zero-active-connection readings before
 * treating "the old credential is unused" as confirmed, so one lucky gap
 * between a dependent's reconnects can't trigger a premature revoke. */
const CONFIRMATION_THRESHOLD = 2;

/**
 * The usage-telemetry loop: this is what makes revocation event-driven
 * instead of timer-driven. Every cycle it asks Postgres itself - via
 * pg_stat_activity, not an app-level heuristic - whether anything is still
 * connected as the old role. Only two things ever end the overlap window:
 * confirmed disuse (revoke) or a dependent that never switches over before
 * the grace period elapses (alert, and the old credential stays live).
 */
@Injectable()
export class TelemetryService implements OnModuleDestroy {
  private readonly logger = new Logger(TelemetryService.name);
  private readonly timers = new Map<number, ReturnType<typeof setInterval>>();
  private readonly pollIntervalMs: number;

  constructor(
    private readonly pg: PgService,
    private readonly secrets: SecretsService,
    private readonly rotations: RotationsRepo,
    private readonly alerts: AlertsService,
    config: ConfigService,
  ) {
    this.pollIntervalMs = Number(config.get<string>('TELEMETRY_POLL_INTERVAL_MS'));
  }

  startMonitoring(rotationId: number): void {
    if (this.timers.has(rotationId)) return;
    const timer = setInterval(() => {
      this.check(rotationId).catch((err) =>
        this.logger.error(`telemetry check failed for rotation ${rotationId}: ${err.message}`),
      );
    }, this.pollIntervalMs);
    this.timers.set(rotationId, timer);
  }

  stopMonitoring(rotationId: number): void {
    const timer = this.timers.get(rotationId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(rotationId);
    }
  }

  private stopAll(): void {
    for (const id of [...this.timers.keys()]) this.stopMonitoring(id);
  }

  /** One telemetry cycle for a single rotation. */
  async check(rotationId: number): Promise<void> {
    const rotation = await this.rotations.getById(rotationId);
    if (rotation.state === 'revoked') {
      this.stopMonitoring(rotationId);
      return;
    }

    const oldSecret = await this.secrets.getById(rotation.oldSecretId);
    const activeConnections = await this.countActiveConnections(oldSecret.roleName);
    await this.pg.query(
      `INSERT INTO usage_telemetry (rotation_id, role_name, active_connections) VALUES ($1, $2, $3)`,
      [rotationId, oldSecret.roleName, activeConnections],
    );

    const consecutiveZero = await this.rotations.recordZeroCheck(rotationId, activeConnections === 0);

    if (consecutiveZero >= CONFIRMATION_THRESHOLD) {
      await this.revokeOld(rotation, oldSecret.id, oldSecret.roleName);
      return;
    }

    if (Date.now() >= rotation.gracePeriodEndsAt.getTime() && rotation.state !== 'alerted') {
      await this.alerts.createIfMissing(
        rotationId,
        `Dependent(s) still using role "${oldSecret.roleName}" for secret "${rotation.secretName}" ` +
          `(${activeConnections} active connection(s)) past the grace period that ended ` +
          `${rotation.gracePeriodEndsAt.toISOString()}. Refusing a blind timer-based revoke - ` +
          `keeping the old credential alive until telemetry shows it is actually unused.`,
      );
      await this.rotations.setState(rotationId, 'alerted');
      this.logger.warn(`Rotation ${rotationId}: grace period elapsed with lingering usage, alert raised`);
    }
  }

  private async countActiveConnections(roleName: string): Promise<number> {
    const { rows } = await this.pg.query<{ cnt: number }>(
      `SELECT count(*)::int AS cnt FROM pg_stat_activity WHERE usename = $1`,
      [roleName],
    );
    return Number(rows[0]?.cnt ?? 0);
  }

  private async revokeOld(rotation: RotationRow, oldSecretId: number, oldRoleName: string): Promise<void> {
    assertValidIdentifier(oldRoleName, 'role name');
    await this.pg.query(`REVOKE app_group FROM "${oldRoleName}"`);
    await this.pg.query(`DROP ROLE "${oldRoleName}"`);
    await this.secrets.markRevoked(oldSecretId);
    await this.rotations.setState(rotation.id, 'revoked', true);
    this.stopMonitoring(rotation.id);
    this.logger.log(
      `Revoked old role "${oldRoleName}" for rotation ${rotation.id}: telemetry confirmed zero usage for ${CONFIRMATION_THRESHOLD} consecutive checks`,
    );
  }

  onModuleDestroy() {
    this.stopAll();
  }
}
