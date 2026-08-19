const { CanonicalRoles: providedCanonicalRoles, SystemRoles } = require('librechat-data-provider');
const { INSTITUTION_ADMIN_ROLE: providedInstitutionAdminRole } = require('@librechat/data-schemas');

const CanonicalRoles = providedCanonicalRoles || {
  PLATFORM_SUPERADMIN: 'PLATFORM_SUPERADMIN',
  INSTITUTION_ADMIN: 'INSTITUTION_ADMIN',
  INSTITUTION_MEMBER: 'INSTITUTION_MEMBER',
  STANDALONE_USER: 'STANDALONE_USER',
};
const INSTITUTION_ADMIN_ROLE = providedInstitutionAdminRole || 'INSTITUTION_ADMIN';

/**
 * Resolve the effective SaaS role without requiring callers to understand the
 * legacy role storage model. Platform-superadmin authority is supplied by the
 * platform-admin module because it is deliberately stored separately from a
 * tenant user role.
 */
function resolveEffectiveRole({ user, platformAdmin } = {}) {
  if (platformAdmin?.active === true) {
    return {
      role: CanonicalRoles.PLATFORM_SUPERADMIN,
      scope: 'platform',
      tenantId: undefined,
    };
  }

  const tenantId = user?.tenantId || undefined;
  const accountScope = user?.accountScope;
  if (user?.role === INSTITUTION_ADMIN_ROLE && tenantId) {
    return { role: CanonicalRoles.INSTITUTION_ADMIN, scope: 'institution', tenantId };
  }

  if (accountScope === 'institution' && tenantId) {
    return { role: CanonicalRoles.INSTITUTION_MEMBER, scope: 'institution', tenantId };
  }

  if (tenantId) {
    return { role: CanonicalRoles.INSTITUTION_MEMBER, scope: 'institution', tenantId };
  }

  return { role: CanonicalRoles.STANDALONE_USER, scope: 'standalone', tenantId: undefined };
}

/** Resolve the effective member role for API/UI responses and filters. */
function resolveMemberRole({ role, tenantId, accountScope } = {}) {
  if (role === INSTITUTION_ADMIN_ROLE && tenantId) {
    return CanonicalRoles.INSTITUTION_ADMIN;
  }
  if (accountScope === 'standalone' || !tenantId) {
    return CanonicalRoles.STANDALONE_USER;
  }
  return CanonicalRoles.INSTITUTION_MEMBER;
}

/**
 * Convert a canonical member role back to the legacy user-field value. This
 * keeps registration and older middleware compatible during the migration.
 */
function toStoredUserRole(role) {
  return role === CanonicalRoles.INSTITUTION_ADMIN
    ? INSTITUTION_ADMIN_ROLE
    : SystemRoles.USER;
}

function isPlatformRole(role) {
  return role === CanonicalRoles.PLATFORM_SUPERADMIN || role === SystemRoles.ADMIN;
}

function isInstitutionRole(role) {
  return role === CanonicalRoles.INSTITUTION_ADMIN || role === INSTITUTION_ADMIN_ROLE;
}

function assertTenantScope({ effectiveRole, actorTenantId, targetTenantId }) {
  if (effectiveRole === CanonicalRoles.PLATFORM_SUPERADMIN) return;
  if (effectiveRole !== CanonicalRoles.INSTITUTION_ADMIN) {
    const error = new Error('Institution administrator privileges required');
    error.statusCode = 403;
    throw error;
  }
  if (!actorTenantId || actorTenantId !== targetTenantId) {
    const error = new Error('Institution administrator access is limited to the current institution');
    error.statusCode = 403;
    throw error;
  }
}

module.exports = {
  resolveEffectiveRole,
  resolveMemberRole,
  toStoredUserRole,
  isPlatformRole,
  isInstitutionRole,
};
