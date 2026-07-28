import type { Document, Types } from 'mongoose';
import type { PlatformRole } from '~/common';

export interface IPlatformAdmin extends Document {
  _id: Types.ObjectId;
  userId?: Types.ObjectId | string;
  email: string;
  role: PlatformRole;
  active: boolean;
  grantedBy?: Types.ObjectId | string;
  revokedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}
