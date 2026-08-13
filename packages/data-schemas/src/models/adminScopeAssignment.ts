import type { Model } from 'mongoose';
import type { IAdminScopeAssignment } from '~/types';
import adminScopeAssignmentSchema from '~/schema/adminScopeAssignment';

export function createAdminScopeAssignmentModel(
  mongoose: typeof import('mongoose'),
): Model<IAdminScopeAssignment> {
  return (
    mongoose.models.AdminScopeAssignment ||
    mongoose.model<IAdminScopeAssignment>('AdminScopeAssignment', adminScopeAssignmentSchema)
  );
}
