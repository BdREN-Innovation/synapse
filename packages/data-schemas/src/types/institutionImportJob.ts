import type { Document, Types } from 'mongoose';
import type { InstitutionImportJobStatus } from '~/common';

export interface InstitutionImportRowResult {
  rowNumber: number;
  email?: string;
  name?: string;
  requestedRole?: string;
  action: 'invite' | 'update_member' | 'skip' | 'error';
  message: string;
}

export interface IInstitutionImportJob extends Document {
  _id: Types.ObjectId;
  tenantId: string;
  idempotencyKey: string;
  status: InstitutionImportJobStatus;
  initiatedBy?: Types.ObjectId | string | null;
  summary: {
    totalRows: number;
    invitesCreated: number;
    membersUpdated: number;
    skipped: number;
    errors: number;
  };
  results: InstitutionImportRowResult[];
  createdAt?: Date;
  updatedAt?: Date;
}
