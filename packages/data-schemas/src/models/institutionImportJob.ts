import { Model } from 'mongoose';
import institutionImportJobSchema from '~/schema/institutionImportJob';
import type { IInstitutionImportJob } from '~/types';

export function createInstitutionImportJobModel(
  mongoose: typeof import('mongoose'),
): Model<IInstitutionImportJob> {
  return (
    mongoose.models.InstitutionImportJob ||
    mongoose.model<IInstitutionImportJob>('InstitutionImportJob', institutionImportJobSchema)
  );
}
