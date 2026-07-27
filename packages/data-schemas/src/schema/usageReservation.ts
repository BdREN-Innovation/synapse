import { Schema } from 'mongoose';
import type { IUsageReservation } from '~/types';

const usageReservationSchema: Schema<IUsageReservation> = new Schema<IUsageReservation>(
  {
    tenantId: { type: String, required: true, trim: true },
    reservationKey: { type: String, required: true, trim: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    providerKey: { type: String, required: true, trim: true },
    modelKey: { type: String, required: true, trim: true },
    policyVersion: { type: Number, required: true, min: 1 },
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },
    estimatedInputTokens: { type: Number, required: true, min: 0 },
    outputTokenCap: { type: Number, required: true, min: 0 },
    reservedTokens: { type: Number, required: true, min: 0 },
    actualTokens: { type: Number, min: 0 },
    status: {
      type: String,
      enum: ['reserved', 'settled', 'released', 'expired'],
      default: 'reserved',
      index: true,
    },
    expiresAt: { type: Date, required: true, index: true },
    settledAt: { type: Date, default: null },
    releasedAt: { type: Date, default: null },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

usageReservationSchema.index(
  { tenantId: 1, reservationKey: 1 },
  { unique: true, name: 'usage_reservation_idempotency' },
);
usageReservationSchema.index({ tenantId: 1, periodStart: 1, modelKey: 1 });

export default usageReservationSchema;
