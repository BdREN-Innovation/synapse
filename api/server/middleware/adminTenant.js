const { logger } = require('@librechat/data-schemas');
const { ensurePlatformSuperadminForUser } = require('~/server/services/platformAdmin');

/**
 * Resolves which institution an admin request applies to.
 *
 * An institution admin is bound to their own tenant and may never address
 * another. A platform superadmin has no tenant of their own, so without an
 * explicit selection there is nothing to scope these routes to; they may name
 * one, which grants no authority they lack on the platform routes already.
 */
async function resolveAdminTenant(req, _res, next) {
  const ownTenantId = req.user?.tenantId;
  if (ownTenantId) {
    req.adminTenantId = ownTenantId;
    return next();
  }

  try {
    const { isPlatformSuperadmin } = await ensurePlatformSuperadminForUser(req.user);
    req.isPlatformSuperadmin = isPlatformSuperadmin === true;
  } catch (error) {
    logger.error('[adminTenant] failed to resolve platform superadmin status', error);
    req.isPlatformSuperadmin = false;
  }

  if (!req.isPlatformSuperadmin) {
    return next();
  }

  const requested = String(req.query?.tenantId ?? req.body?.tenantId ?? '').trim();
  if (requested) {
    req.adminTenantId = requested;
  }
  return next();
}

function requireTenant(req, res) {
  if (req.adminTenantId) {
    return req.adminTenantId;
  }
  if (req.isPlatformSuperadmin) {
    res.status(400).json({
      error: 'Select an institution to scope this request',
      code: 'TENANT_SELECTION_REQUIRED',
    });
    return null;
  }
  res.status(403).json({ error: 'Institution admin access requires a tenant context' });
  return null;
}

module.exports = { resolveAdminTenant, requireTenant };
