import { Schema } from 'mongoose';
import type { ICreditGrant } from '~/types';

const creditGrantSchema: Schema<ICreditGrant> = new Schema<ICreditGrant>({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  tenantId: { type: String, required: false, index: true },
  packageId: { type: String, required: true },
  credits: { type: Number, required: true },
  price: { type: Number, required: true },
  currency: { type: String, required: true },
  reference: { type: String, default: null },
  source: { type: String, enum: ['invite', 'topup'], required: true },
  grantedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  inviteId: { type: Schema.Types.ObjectId, ref: 'InstitutionInvite', default: null },
  note: { type: String, default: '' },
}, { timestamps: true });

creditGrantSchema.index({ tenantId: 1, user: 1, createdAt: -1 });
creditGrantSchema.index({ tenantId: 1, createdAt: -1 });
creditGrantSchema.index({ inviteId: 1 }, { unique: true, sparse: true });

export default creditGrantSchema;
