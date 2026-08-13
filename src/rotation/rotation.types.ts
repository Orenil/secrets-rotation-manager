export type RotationState = 'overlapping' | 'alerted' | 'revoked';

export interface RotationRow {
  id: number;
  secretName: string;
  oldSecretId: number;
  newSecretId: number;
  state: RotationState;
  gracePeriodEndsAt: Date;
  consecutiveZeroChecks: number;
  createdAt: Date;
  completedAt: Date | null;
}

export interface AlertRow {
  id: number;
  rotationId: number;
  message: string;
  createdAt: Date;
}
