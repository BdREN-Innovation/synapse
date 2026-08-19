import { Model } from 'mongoose';
import institutionPackageSchema from '~/schema/institutionPackage';
import type { IInstitutionPackage } from '~/types';

export function createInstitutionPackageModel(
  mongoose: typeof import('mongoose'),
): Model<IInstitutionPackage> {
  return (
    mongoose.models.InstitutionPackage ||
    mongoose.model<IInstitutionPackage>('InstitutionPackage', institutionPackageSchema)
  );
}
