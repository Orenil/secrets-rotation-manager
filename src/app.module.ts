import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PgModule } from './db/pg.module';
import { CryptoModule } from './crypto/crypto.module';
import { SecretsModule } from './secrets/secrets.module';
import { RotationModule } from './rotation/rotation.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), PgModule, CryptoModule, SecretsModule, RotationModule],
})
export class AppModule {}
