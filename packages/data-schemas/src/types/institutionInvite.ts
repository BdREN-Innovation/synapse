import type { Document, Types } from 'mongoose';
import type {
  InstitutionInviteAccountScope,
  InstitutionInviteSource,
  InstitutionInviteStatus,
} from '~/common';

export interface IInstitutionInvite extends Document {
  _id: Types.ObjectId;
  tenantId?: string | null;
  accountScope?: InstitutionInviteAccountScope;
  email: string;
  name?: string;
  requestedUsername?: string | null;
  requestedRole: string;
  creditPackageId?: string | null;
  status: InstitutionInviteStatus;
  tokenHash: string;
  expiresAt: Date;
  invitedBy?: Types.ObjectId | string | null;
  lastSentAt?: Date | null;
  acceptedAt?: Date | null;
  acceptedUserId?: Types.ObjectId | string | null;
  revokedAt?: Date | null;
  revokedBy?: Types.ObjectId | string | null;
  source?: InstitutionInviteSource;
  createdAt?: Date;
  updatedAt?: Date;
}
