export const INSTITUTION_ADMIN_ROLE = 'INSTITUTION_ADMIN' as const;

export const InstitutionStatuses = {
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  CLOSED: 'closed',
} as const;

export type InstitutionStatus =
  (typeof InstitutionStatuses)[keyof typeof InstitutionStatuses];

export const InstitutionMembershipStatuses = {
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  REMOVED: 'removed',
} as const;

export type InstitutionMembershipStatus =
  (typeof InstitutionMembershipStatuses)[keyof typeof InstitutionMembershipStatuses];

export const InstitutionInviteStatuses = {
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  REVOKED: 'revoked',
  EXPIRED: 'expired',
} as const;

export type InstitutionInviteStatus =
  (typeof InstitutionInviteStatuses)[keyof typeof InstitutionInviteStatuses];

export const InstitutionInviteAccountScopes = {
  INSTITUTION: 'institution',
  STANDALONE: 'standalone',
} as const;

export type InstitutionInviteAccountScope =
  (typeof InstitutionInviteAccountScopes)[keyof typeof InstitutionInviteAccountScopes];

export const InstitutionInviteSources = {
  MANUAL: 'manual',
  CSV_IMPORT: 'csv_import',
} as const;

export type InstitutionInviteSource =
  (typeof InstitutionInviteSources)[keyof typeof InstitutionInviteSources];

export const InstitutionImportJobStatuses = {
  PENDING: 'pending',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;

export type InstitutionImportJobStatus =
  (typeof InstitutionImportJobStatuses)[keyof typeof InstitutionImportJobStatuses];

export const PlatformRoles = {
  SUPERADMIN: 'SUPERADMIN',
} as const;

export type PlatformRole = (typeof PlatformRoles)[keyof typeof PlatformRoles];
