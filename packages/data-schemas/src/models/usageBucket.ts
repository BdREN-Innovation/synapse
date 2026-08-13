import type { Model } from 'mongoose';
import type { IUsageBucket } from '~/types';
import usageBucketSchema from '~/schema/usageBucket';

export function createUsageBucketModel(mongoose: typeof import('mongoose')): Model<IUsageBucket> {
  return mongoose.models.UsageBucket || mongoose.model<IUsageBucket>('UsageBucket', usageBucketSchema);
}
