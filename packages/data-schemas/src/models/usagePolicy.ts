import type { Model } from 'mongoose';
import type { IUsagePolicy } from '~/types';
import usagePolicySchema from '~/schema/usagePolicy';

export function createUsagePolicyModel(mongoose: typeof import('mongoose')): Model<IUsagePolicy> {
  return mongoose.models.UsagePolicy || mongoose.model<IUsagePolicy>('UsagePolicy', usagePolicySchema);
}
