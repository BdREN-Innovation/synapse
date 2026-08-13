import { Schema } from 'mongoose';
import type { IUsagePolicy } from '~/types';

const usagePolicySchema: Schema<IUsagePolicy> = new Schema<IUsagePolicy>(
  {
    tenantId: { type: String, required: true, trim: true, index: true, immutable: true },
    version: { type: Number, required: true, min: 1, immutable: true },
    mode: { type: String, enum: ['shadow', 'enforce'], default: 'shadow', immutable: true },
    timezone: {
      type: String,
      required: true,
      default: 'Asia/Dhaka',
      trim: true,
      immutable: true,
    },
    period: {
      type: String,
      enum: ['calendar_month'],
      default: 'calendar_month',
      immutable: true,
    },
    limits: {
      type: {
        institutionTokens: { type: Number, default: null, min: 0 },
        memberTokens: { type: Number, default: null, min: 0 },
        modelTokens: {
          type: [
            {
              _id: false,
              modelKey: { type: String, required: true, trim: true },
              maxTokens: { type: Number, default: null, min: 0 },
            },
          ],
          default: [],
        },
      },
      default: {},
      immutable: true,
    },
    warningThresholds: {
      type: [Number],
      default: [0.8, 0.9],
      immutable: true,
    },
    inputSafetyFactor: { type: Number, default: 1.15, min: 1, immutable: true },
    inputSafetyTokens: { type: Number, default: 256, min: 0, immutable: true },
    effectiveAt: { type: Date, required: true, default: Date.now, immutable: true },
    reason: { type: String, trim: true, immutable: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', immutable: true },
  },
  { timestamps: true },
);

usagePolicySchema.index({ tenantId: 1, version: 1 }, { unique: true });
usagePolicySchema.index({ tenantId: 1, effectiveAt: -1 });

export default usagePolicySchema;
