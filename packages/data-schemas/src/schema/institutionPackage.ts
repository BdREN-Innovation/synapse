import { Schema } from 'mongoose';
import type { IInstitutionPackage } from '~/types';

const institutionPackageSchema: Schema<IInstitutionPackage> = new Schema<IInstitutionPackage>(
  {
    id: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '', trim: true },
    price: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true, trim: true, uppercase: true, default: 'USD' },
    monthlyTokenLimit: { type: Number, required: true, min: 1 },
    active: { type: Boolean, default: true, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

institutionPackageSchema.index({ id: 1 }, { unique: true });

export default institutionPackageSchema;
