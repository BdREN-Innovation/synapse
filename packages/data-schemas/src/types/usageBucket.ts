import type { Document, Types } from 'mongoose';

export type UsageBucketScope = 'institution' | 'member' | 'model';

export interface IUsageBucket extends Document {
  _id: Types.ObjectId;
  tenantId: string;
  periodStart: Date;
  periodEnd: Date;
  scopeType: UsageBucketScope;
  scopeKey: string;
  policyVersion: number;
  usedTokens: number;
  reservedTokens: number;
  createdAt?: Date;
  updatedAt?: Date;
}
