import { Schema } from 'mongoose';
import type { IUsageBucket } from '~/types';

const usageBucketSchema: Schema<IUsageBucket> = new Schema<IUsageBucket>(
  {
    tenantId: { type: String, required: true, trim: true },
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },
    scopeType: {
      type: String,
      enum: ['institution', 'member', 'model'],
      required: true,
    },
    scopeKey: { type: String, required: true, trim: true },
    policyVersion: { type: Number, required: true, min: 1 },
    usedTokens: { type: Number, default: 0, min: 0 },
    reservedTokens: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

usageBucketSchema.index(
  { tenantId: 1, periodStart: 1, scopeType: 1, scopeKey: 1 },
  { unique: true, name: 'usage_bucket_scope_period' },
);
usageBucketSchema.index({ tenantId: 1, periodEnd: 1 });

export default usageBucketSchema;
