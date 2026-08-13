import type { Document, Types } from 'mongoose';

export interface IAdminScopeAssignment extends Document {
  _id: Types.ObjectId;
  tenantId: string;
  /** The institution administrator whose authority is being narrowed. */
  userId: Types.ObjectId;
  /** The single group they administer. Enforced unique per tenant while live. */
  groupId: Types.ObjectId;
  grantedBy: Types.ObjectId;
  revokedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}
