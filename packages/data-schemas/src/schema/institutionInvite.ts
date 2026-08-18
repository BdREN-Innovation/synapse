import { Schema } from 'mongoose';
import {
  InstitutionInviteAccountScopes,
  InstitutionInviteSources,
  InstitutionInviteStatuses,
} from '~/common';
import type { IInstitutionInvite } from '~/types';

const institutionInviteSchema: Schema<IInstitutionInvite> = new Schema<IInstitutionInvite>(
  {
    tenantId: {
      type: String,
      required: function requiredTenantForInstitutionInvite(this: { accountScope?: string }) {
        return this.accountScope !== InstitutionInviteAccountScopes.STANDALONE;
      },
      trim: true,
      index: true,
    },
    accountScope: {
      type: String,
      enum: Object.values(InstitutionInviteAccountScopes),
      default: InstitutionInviteAccountScopes.INSTITUTION,
      index: true,
    },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    name: {
      type: String,
      trim: true,
      default: '',
    },
    requestedUsername: {
      type: String,
      trim: true,
      lowercase: true,
      default: null,
    },
    requestedRole: {
      type: String,
      required: true,
      trim: true,
    },
    creditPackageId: {
      type: String,
      default: null,
      trim: true,
    },
    status: {
      type: String,
      enum: Object.values(InstitutionInviteStatuses),
      default: InstitutionInviteStatuses.PENDING,
      index: true,
    },
    tokenHash: {
      type: String,
      required: true,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: true,
    },
    invitedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    lastSentAt: {
      type: Date,
      default: null,
    },
    acceptedAt: {
      type: Date,
      default: null,
    },
    acceptedUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    revokedAt: {
      type: Date,
      default: null,
    },
    revokedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    source: {
      type: String,
      enum: Object.values(InstitutionInviteSources),
      default: InstitutionInviteSources.MANUAL,
    },
  },
  { timestamps: true },
);

institutionInviteSchema.index({ tenantId: 1, email: 1, status: 1 });
institutionInviteSchema.index({ accountScope: 1, email: 1, status: 1 });
institutionInviteSchema.index({ tenantId: 1, createdAt: -1 });

export default institutionInviteSchema;
