import type { Document, Types } from 'mongoose';

export type UsageReservationStatus = 'reserved' | 'settled' | 'released' | 'expired';

export interface IUsageReservation extends Document {
  _id: Types.ObjectId;
  tenantId: string;
  reservationKey: string;
  userId: Types.ObjectId;
  providerKey: string;
  modelKey: string;
  policyVersion: number;
  periodStart: Date;
  periodEnd: Date;
  estimatedInputTokens: number;
  outputTokenCap: number;
  reservedTokens: number;
  actualTokens?: number;
  status: UsageReservationStatus;
  expiresAt: Date;
  settledAt?: Date | null;
  releasedAt?: Date | null;
  metadata?: Record<string, unknown>;
  createdAt?: Date;
  updatedAt?: Date;
}
