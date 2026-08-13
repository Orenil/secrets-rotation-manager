import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { ConfigService } from '@nestjs/config';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

export interface EncryptedPayload {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

/**
 * Real AES-256-GCM encryption at rest for generated credentials, keyed by
 * ENCRYPTION_KEY (64 hex chars / 32 bytes). This is the encrypted-store
 * building block the spec asks for as an alternative to Vault; swapping in
 * Vault for production means replacing this service's two methods with
 * calls into Vault's transit/kv engine and leaving every caller untouched.
 */
@Injectable()
export class EncryptionService {
  private readonly key: Buffer;

  constructor(config: ConfigService) {
    const keyHex = config.get<string>('ENCRYPTION_KEY');
    if (!keyHex || !/^[0-9a-fA-F]{64}$/.test(keyHex)) {
      throw new Error(
        'ENCRYPTION_KEY must be set to 64 hex characters (32 bytes) for AES-256-GCM',
      );
    }
    this.key = Buffer.from(keyHex, 'hex');
  }

  encrypt(plaintext: string): EncryptedPayload {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    return { ciphertext, iv, authTag: cipher.getAuthTag() };
  }

  decrypt(payload: EncryptedPayload): string {
    const decipher = createDecipheriv(ALGORITHM, this.key, payload.iv);
    decipher.setAuthTag(payload.authTag);
    return Buffer.concat([
      decipher.update(payload.ciphertext),
      decipher.final(),
    ]).toString('utf8');
  }
}
