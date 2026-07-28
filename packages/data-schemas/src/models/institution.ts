import { Model } from 'mongoose';
import type { IInstitution } from '~/types';
import institutionSchema from '~/schema/institution';

/**
 * Institution is a platform control-plane registry. It intentionally does not
 * use ambient tenant isolation because platform routes must resolve a tenant
 * before they can enter tenant-scoped context.
 */
export function createInstitutionModel(
  mongoose: typeof import('mongoose'),
): Model<IInstitution> {
  return (
    mongoose.models.Institution || mongoose.model<IInstitution>('Institution', institutionSchema)
  );
}
