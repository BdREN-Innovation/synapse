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

/**
 * One reservation is written per model call, so this collection grows with
 * traffic and nothing else prunes it.
 *
 * Aging them out is safe: the ledger — not this collection — is the record of
 * usage, and bucket reconciliation derives the periods it repairs *from* these
 * rows, so a period with no surviving reservations is simply never revisited
 * rather than recomputed to zero. The readiness report only looks back seven
 * days, well inside the default.
 *
 * Set `USAGE_RESERVATION_RETENTION_DAYS=0` to retain indefinitely.
 */
const retentionDays = Number(process.env.USAGE_RESERVATION_RETENTION_DAYS ?? 90);
if (Number.isFinite(retentionDays) && retentionDays > 0) {
  usageReservationSchema.index(
    { createdAt: 1 },
    { expireAfterSeconds: Math.round(retentionDays * 24 * 60 * 60) },
  );
}

export default usageReservationSchema;
