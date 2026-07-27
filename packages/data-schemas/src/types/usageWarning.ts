import type { Document, Types } from 'mongoose';
import type { UsageBucketScope } from './usageBucket';

export interface IUsageWarning extends Document {
  _id: Types.ObjectId;
  tenantId: string;
  periodStart: Date;
  periodEnd: Date;
  scopeType: UsageBucketScope;
  scopeKey: string;
  threshold: number;
  utilization: number;
  usedTokens: number;
  reservedTokens: number;
  limit: number;
  emailedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}
