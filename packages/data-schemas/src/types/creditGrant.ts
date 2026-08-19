import type { Document, Types } from 'mongoose';

export type CreditGrantSource = 'invite' | 'topup';

export interface ICreditGrant extends Document {
  user: Types.ObjectId;
  tenantId?: string | null;
  packageId: string;
  credits: number;
  price: number;
  currency: string;
  reference?: string | null;
  source: CreditGrantSource;
  grantedBy?: Types.ObjectId | null;
  inviteId?: Types.ObjectId | null;
  note?: string;
  createdAt?: Date;
  updatedAt?: Date;
}
