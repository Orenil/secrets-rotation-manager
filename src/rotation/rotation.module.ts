import { Module } from '@nestjs/common';
import { SecretsModule } from '../secrets/secrets.module';
import { RotationService } from './rotation.service';
import { RotationController } from './rotation.controller';
import { RotationsRepo } from './rotations.repo';
import { TelemetryService } from './telemetry.service';
import { AlertsService } from './alerts.service';

@Module({
  imports: [SecretsModule],
  controllers: [RotationController],
  providers: [RotationService, RotationsRepo, TelemetryService, AlertsService],
  exports: [RotationService, TelemetryService, AlertsService, RotationsRepo],
})
export class RotationModule {}
