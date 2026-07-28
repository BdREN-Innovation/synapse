import { Schema } from 'mongoose';
import type { IAdminScopeAssignment } from '~/types';

/**
 * Grants one institution administrator authority over exactly one group inside
 * their institution (Phase 8, subgroup admins).
 *
 * Not yet enforced anywhere. The schema exists so the shape is settled and
 * reviewable before any query starts trusting it; scoping every read path is a
 * separate, deliberate change. See `docs/phase8-subgroup-admins.md`.
 */
const adminScopeAssignmentSchema: Schema<IAdminScopeAssignment> = new Schema<IAdminScopeAssignment>(
  {
    tenantId: { type: String, required: true, trim: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    groupId: { type: Schema.Types.ObjectId, ref: 'Group', required: true },
    grantedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

/**
 * One live assignment per administrator, per tenant.
 *
 * This is the constraint that makes billing attribution unambiguous by
 * construction rather than by rule: a member cannot sit under two group budgets,
 * so no usage event ever has to choose between them. Revoked rows are excluded
 * so history is retained without blocking a re-grant.
 */
adminScopeAssignmentSchema.index(
  { tenantId: 1, userId: 1 },
  {
    unique: true,
    partialFilterExpression: { revokedAt: null },
    name: 'admin_scope_single_group',
  },
);

adminScopeAssignmentSchema.index({ tenantId: 1, groupId: 1, revokedAt: 1 });

export default adminScopeAssignmentSchema;
