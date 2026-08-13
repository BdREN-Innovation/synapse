import { Schema } from 'mongoose';
import { InstitutionImportJobStatuses } from '~/common';
import type { IInstitutionImportJob } from '~/types';

const institutionImportJobSchema: Schema<IInstitutionImportJob> =
  new Schema<IInstitutionImportJob>(
    {
      tenantId: {
        type: String,
        required: true,
        trim: true,
        index: true,
      },
      idempotencyKey: {
        type: String,
        required: true,
        trim: true,
      },
      status: {
        type: String,
        enum: Object.values(InstitutionImportJobStatuses),
        default: InstitutionImportJobStatuses.PENDING,
        index: true,
      },
      initiatedBy: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        default: null,
      },
      summary: {
        totalRows: {
          type: Number,
          default: 0,
        },
        invitesCreated: {
          type: Number,
          default: 0,
        },
        membersUpdated: {
          type: Number,
          default: 0,
        },
        skipped: {
          type: Number,
          default: 0,
        },
        errors: {
          type: Number,
          default: 0,
        },
      },
      results: {
        type: [
          new Schema(
            {
              rowNumber: { type: Number, required: true },
              email: { type: String, default: '' },
              name: { type: String, default: '' },
              requestedRole: { type: String, default: '' },
              action: { type: String, required: true },
              message: { type: String, required: true },
            },
            { _id: false },
          ),
        ],
        default: [],
      },
    },
    { timestamps: true },
  );

institutionImportJobSchema.index({ tenantId: 1, idempotencyKey: 1 }, { unique: true });
institutionImportJobSchema.index({ tenantId: 1, createdAt: -1 });

export default institutionImportJobSchema;
