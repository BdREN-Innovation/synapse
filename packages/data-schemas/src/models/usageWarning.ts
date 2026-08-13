import type { Model } from 'mongoose';
import type { IUsageWarning } from '~/types';
import usageWarningSchema from '~/schema/usageWarning';

export function createUsageWarningModel(mongoose: typeof import('mongoose')): Model<IUsageWarning> {
  return (
    mongoose.models.UsageWarning ||
    mongoose.model<IUsageWarning>('UsageWarning', usageWarningSchema)
  );
}
