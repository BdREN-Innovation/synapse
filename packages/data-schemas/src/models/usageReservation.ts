import type { Model } from 'mongoose';
import type { IUsageReservation } from '~/types';
import usageReservationSchema from '~/schema/usageReservation';

export function createUsageReservationModel(
  mongoose: typeof import('mongoose'),
): Model<IUsageReservation> {
  return (
    mongoose.models.UsageReservation ||
    mongoose.model<IUsageReservation>('UsageReservation', usageReservationSchema)
  );
}
