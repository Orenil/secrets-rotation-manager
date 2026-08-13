import { Controller, Get, Param, Post } from '@nestjs/common';
import { RotationService } from './rotation.service';
import { AlertsService } from './alerts.service';

@Controller('rotation')
export class RotationController {
  constructor(
    private readonly rotation: RotationService,
    private readonly alerts: AlertsService,
  ) {}

  @Post(':name/bootstrap')
  async bootstrap(@Param('name') name: string) {
    await this.rotation.bootstrap(name);
    return { ok: true };
  }

  @Post(':name/start')
  start(@Param('name') name: string) {
    return this.rotation.startRotation(name);
  }

  @Get(':name/status')
  async status(@Param('name') name: string) {
    const rotation = await this.rotation.getStatus(name);
    if (!rotation) return { rotation: null, alert: null };
    const alert = await this.alerts.getForRotation(rotation.id);
    return { rotation, alert };
  }
}
