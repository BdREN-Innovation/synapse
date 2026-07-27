import { Schema } from 'mongoose';
import { PlatformRoles } from '~/common';
import type { IPlatformAdmin } from '~/types';

const platformAdminSchema: Schema<IPlatformAdmin> = new Schema<IPlatformAdmin>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    role: {
      type: String,
      enum: Object.values(PlatformRoles),
      default: PlatformRoles.SUPERADMIN,
    },
    active: {
      type: Boolean,
      default: true,
      index: true,
    },
    grantedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    revokedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

platformAdminSchema.index({ email: 1 }, { unique: true });
platformAdminSchema.index({ userId: 1 }, { unique: true, sparse: true });

export default platformAdminSchema;
