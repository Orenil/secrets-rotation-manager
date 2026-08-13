import { Controller, Get, Param } from '@nestjs/common';
import { SecretsService } from './secrets.service';

@Controller('secrets')
export class SecretsController {
  constructor(private readonly secrets: SecretsService) {}

  /** Consumed by RotatingSecretClient. Returns the currently-active
   * credential for `name` - the dependent's short-TTL cache re-hits this
   * once its cached copy expires, which is how it picks up a rotation
   * without redeploying. */
  @Get(':name/active')
  getActive(@Param('name') name: string) {
    return this.secrets.getConnectionPayload(name);
  }

  @Get(':name/versions')
  listVersions(@Param('name') name: string) {
    return this.secrets.listByName(name);
  }
}
