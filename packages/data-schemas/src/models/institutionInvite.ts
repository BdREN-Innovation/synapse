import { Model } from 'mongoose';
import institutionInviteSchema from '~/schema/institutionInvite';
import type { IInstitutionInvite } from '~/types';

export function createInstitutionInviteModel(
  mongoose: typeof import('mongoose'),
): Model<IInstitutionInvite> {
  return (
    mongoose.models.InstitutionInvite ||
    mongoose.model<IInstitutionInvite>('InstitutionInvite', institutionInviteSchema)
  );
}
