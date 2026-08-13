import { Module } from '@nestjs/common';
import { PgModule } from '../db/pg.module';
import { CryptoModule } from '../crypto/crypto.module';
import { SecretsService } from './secrets.service';
import { SecretsController } from './secrets.controller';

@Module({
  imports: [PgModule, CryptoModule],
  controllers: [SecretsController],
  providers: [SecretsService],
  exports: [SecretsService],
})
export class SecretsModule {}
