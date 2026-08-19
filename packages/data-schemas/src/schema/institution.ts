import { Schema } from 'mongoose';
import { InstitutionStatuses } from '~/common';
import type { IInstitution } from '~/types';

const institutionSchema: Schema<IInstitution> = new Schema<IInstitution>(
  {
    tenantId: {
      type: String,
      required: true,
      immutable: true,
      trim: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    slug: {
      type: String,
      trim: true,
    },
    status: {
      type: String,
      enum: Object.values(InstitutionStatuses),
      default: InstitutionStatuses.ACTIVE,
      index: true,
    },
    authDomains: {
      type: [String],
      default: [],
    },
    timezone: {
      type: String,
      default: 'Asia/Dhaka',
      trim: true,
    },
    usagePolicyVersion: {
      type: Number,
      default: 0,
      min: 0,
    },
    packageAssignment: {
      type: {
        packageId: { type: String, trim: true },
        packageSnapshot: {
          name: { type: String, required: true },
          description: { type: String, default: '' },
          price: { type: Number, min: 0 },
          currency: { type: String, uppercase: true },
          monthlyTokenLimit: { type: Number, min: 1 },
        },
        monthlyTokenLimit: { type: Number, min: 1 },
        assignedAt: { type: Date },
        assignedBy: { type: Schema.Types.ObjectId, ref: 'User' },
      },
      default: null,
    },
    limits: {
      type: {
        maxActiveMembers: {
          type: Number,
          default: null,
          min: 1,
        },
      },
      default: {},
    },
    stats: {
      type: {
        activeMembers: {
          type: Number,
          default: 0,
          min: 0,
        },
      },
      default: {},
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    suspendedAt: {
      type: Date,
      default: null,
    },
    suspendedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true },
);

institutionSchema.index({ tenantId: 1 }, { unique: true });
institutionSchema.index({ slug: 1 }, { unique: true, sparse: true });

export default institutionSchema;
