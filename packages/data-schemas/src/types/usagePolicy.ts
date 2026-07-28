import type { Document, Types } from 'mongoose';

export type UsagePolicyMode = 'shadow' | 'enforce';

export interface IUsageModelLimit {
  modelKey: string;
  maxTokens: number | null;
}

export interface IUsagePolicy extends Document {
  _id: Types.ObjectId;
  tenantId: string;
  version: number;
  mode: UsagePolicyMode;
  timezone: string;
  period: 'calendar_month';
  limits: {
    institutionTokens: number | null;
    memberTokens: number | null;
    modelTokens: IUsageModelLimit[];
  };
  warningThresholds: number[];
  inputSafetyFactor: number;
  inputSafetyTokens: number;
  effectiveAt: Date;
  reason?: string;
  createdBy?: Types.ObjectId | string;
  createdAt?: Date;
  updatedAt?: Date;
}
