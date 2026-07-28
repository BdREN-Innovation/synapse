const express = require('express');
const { createAdminGrantsHandlers, getCachedPrincipals } = require('@librechat/api');
const { SystemCapabilities } = require('@librechat/data-schemas');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const { requireJwtAuth } = require('~/server/middleware');
const db = require('~/models');
const { ensurePlatformSuperadminForUser } = require('~/server/services/platformAdmin');

const router = express.Router();

const requireAdminAccess = requireCapability(SystemCapabilities.ACCESS_ADMIN);
const requireAuditLogRead = requireCapability(SystemCapabilities.READ_AUDIT_LOG);
const requireManageRoles = requireCapability(SystemCapabilities.MANAGE_ROLES);
const requirePlatformSuperadmin = require('~/server/middleware/platformAdmin');

const handlers = createAdminGrantsHandlers({
  listGrants: db.listGrants,
  countGrants: db.countGrants,
  getCapabilitiesForPrincipal: db.getCapabilitiesForPrincipal,
  getCapabilitiesForPrincipals: db.getCapabilitiesForPrincipals,
  grantCapability: db.grantCapability,
  revokeCapability: db.revokeCapability,
  getUserPrincipals: db.getUserPrincipals,
  hasCapabilityForPrincipals: db.hasCapabilityForPrincipals,
  getHeldCapabilities: db.getHeldCapabilities,
  getCachedPrincipals,
  checkRoleExists: async (name) => (await db.getRoleByName(name)) != null,
  recordAuditEntry: db.recordAuditEntry,
  /** Opt-in: fail the grant request if its audit entry can't be persisted. */
  auditFailClosed: process.env.AUDIT_LOG_FAIL_CLOSED === 'true',
});

router.use(requireJwtAuth, requireAdminAccess);

router.get('/effective', async (req, res) => {
  try {
    const platformState = await ensurePlatformSuperadminForUser(req.user);
    if (platformState.isPlatformSuperadmin) {
      return res.status(200).json({ capabilities: Object.values(SystemCapabilities) });
    }
  } catch (error) {
    return res.status(500).json({ error: 'Failed to get effective capabilities' });
  }

  return handlers.getEffectiveCapabilities(req, res);
});
router.get('/', requireAuditLogRead, requirePlatformSuperadmin, handlers.listGrants);
router.get(
  '/:principalType/:principalId',
  requireAuditLogRead,
  requirePlatformSuperadmin,
  handlers.getPrincipalGrants,
);
router.post('/', requireManageRoles, requirePlatformSuperadmin, handlers.assignGrant);
/** Callers should encodeURIComponent the capability for client compatibility (e.g. manage%3Aconfigs%3Aendpoints). */
router.delete(
  '/:principalType/:principalId/:capability',
  requireManageRoles,
  requirePlatformSuperadmin,
  handlers.revokeGrant,
);

module.exports = router;
