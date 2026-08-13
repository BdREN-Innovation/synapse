import { Schema } from 'mongoose';
import type { IUsageWarning } from '~/types';

const usageWarningSchema: Schema<IUsageWarning> = new Schema<IUsageWarning>(
  {
    tenantId: { type: String, required: true, trim: true },
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },
    scopeType: { type: String, enum: ['institution', 'member', 'model'], required: true },
    scopeKey: { type: String, required: true, trim: true },
    threshold: { type: Number, required: true, min: 0, max: 1 },
    utilization: { type: Number, required: true, min: 0 },
    usedTokens: { type: Number, required: true, min: 0 },
    reservedTokens: { type: Number, required: true, min: 0 },
    limit: { type: Number, required: true, min: 0 },
    emailedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

usageWarningSchema.index(
  { tenantId: 1, periodStart: 1, scopeType: 1, scopeKey: 1, threshold: 1 },
  { unique: true, name: 'usage_warning_scope_period_threshold' },
);

export default usageWarningSchema;
