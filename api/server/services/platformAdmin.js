const { PlatformRoles, logger } = require('@librechat/data-schemas');
const db = require('~/models');

const NOT_SUPERADMIN = { isPlatformSuperadmin: false, admin: null };

function parsePlatformSuperadminEmails() {
  return new Set(
    (process.env.PLATFORM_SUPERADMIN_EMAILS || '')
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : undefined;
}

function isActiveSuperadmin(admin) {
  return admin?.active === true && admin.role === PlatformRoles.SUPERADMIN;
}

/**
 * Resolves platform superadmin status for a request user.
 *
 * Platform superadmins are tenant-less by construction. Institution members are
 * rejected up front because user email uniqueness is scoped per tenant, so an
 * email match alone can never be treated as proof of identity.
 */
async function ensurePlatformSuperadminForUser(user) {
  if (!user || user.tenantId) {
    return NOT_SUPERADMIN;
  }

  const userId = user.id ?? user._id?.toString();
  const email = normalizeEmail(user.email);

  const boundAdmin = userId ? await db.getPlatformAdminForUser({ userId }) : null;
  if (boundAdmin) {
    return isActiveSuperadmin(boundAdmin)
      ? { isPlatformSuperadmin: true, admin: boundAdmin }
      : { isPlatformSuperadmin: false, admin: boundAdmin };
  }

  const emailAdmin = email ? await db.getPlatformAdminForUser({ email }) : null;
  if (emailAdmin) {
    if (emailAdmin.userId && emailAdmin.userId.toString() !== userId) {
      logger.warn(
        '[platformAdmin] refused email match for a record already bound to another account',
        { email, attemptedUserId: userId },
      );
      return NOT_SUPERADMIN;
    }
    if (!isActiveSuperadmin(emailAdmin)) {
      return { isPlatformSuperadmin: false, admin: emailAdmin };
    }
    if (!userId) {
      return { isPlatformSuperadmin: true, admin: emailAdmin };
    }
    const claimed = await db.upsertPlatformAdmin({
      userId,
      email: emailAdmin.email,
      role: emailAdmin.role,
      active: emailAdmin.active,
    });
    return { isPlatformSuperadmin: true, admin: claimed };
  }

  if (!email || !parsePlatformSuperadminEmails().has(email)) {
    return NOT_SUPERADMIN;
  }

  const admin = await db.upsertPlatformAdmin({
    userId,
    email,
    role: PlatformRoles.SUPERADMIN,
    active: true,
  });

  return { isPlatformSuperadmin: true, admin };
}

/**
 * Reports whether an email is reserved for platform administration, so tenant
 * onboarding flows can never absorb or re-credential a platform admin account.
 */
async function isPlatformAdminEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) {
    return false;
  }
  if (parsePlatformSuperadminEmails().has(normalized)) {
    return true;
  }
  const existing = await db.getPlatformAdminForUser({ email: normalized });
  return existing?.active === true;
}

module.exports = {
  ensurePlatformSuperadminForUser,
  isPlatformAdminEmail,
};
