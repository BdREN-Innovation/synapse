import type { Document, Types } from 'mongoose';

export interface IInstitutionPackage extends Document {
  _id: Types.ObjectId;
  id: string;
  name: string;
  description?: string;
  price: number;
  currency: string;
  monthlyTokenLimit: number;
  active: boolean;
  createdBy?: Types.ObjectId | string;
  updatedBy?: Types.ObjectId | string;
  createdAt?: Date;
  updatedAt?: Date;
}
