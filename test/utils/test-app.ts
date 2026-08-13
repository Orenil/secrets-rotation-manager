import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { PgService } from '../../src/db/pg.service';
import { RotationService } from '../../src/rotation/rotation.service';
import { AlertsService } from '../../src/rotation/alerts.service';
import { RotationsRepo } from '../../src/rotation/rotations.repo';
import { TelemetryService } from '../../src/rotation/telemetry.service';
import { SecretsService } from '../../src/secrets/secrets.service';

export interface TestApp {
  app: INestApplication;
  baseUrl: string;
  pg: PgService;
  rotation: RotationService;
  alerts: AlertsService;
  rotations: RotationsRepo;
  telemetry: TelemetryService;
  secrets: SecretsService;
}

export async function createTestApp(): Promise<TestApp> {
  const app = await NestFactory.create(AppModule, { logger: false });
  const port = Number(process.env.PORT);
  await app.listen(port);
  return {
    app,
    baseUrl: `http://127.0.0.1:${port}`,
    pg: app.get(PgService),
    rotation: app.get(RotationService),
    alerts: app.get(AlertsService),
    rotations: app.get(RotationsRepo),
    telemetry: app.get(TelemetryService),
    secrets: app.get(SecretsService),
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`);
    await sleep(intervalMs);
  }
}

/** Unique, identifier-safe secret name so parallel test files sharing one
 * long-lived Postgres cluster never collide. */
export function uniqueSecretName(prefix: string): string {
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  return `${prefix}_${suffix}`.toLowerCase();
}
