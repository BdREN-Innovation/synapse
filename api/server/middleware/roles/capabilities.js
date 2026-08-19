const { generateCapabilityCheck, capabilityContextMiddleware } = require('@librechat/api');
const {
  getUserPrincipals,
  hasAnyConfigReadAccess,
  hasCapabilityForPrincipals,
  getHeldCapabilities,
} = require('~/models');
const { ensurePlatformSuperadminForUser } = require('~/server/services/platformAdmin');

const {
  hasCapability,
  requireCapability,
  hasConfigCapability,
  hasAnyConfigReadAccess: checkAnyConfigReadAccess,
  getReadableConfigSections,
} = generateCapabilityCheck({
  getUserPrincipals,
  hasAnyConfigReadAccess,
  hasCapabilityForPrincipals,
  getHeldCapabilities,
  isPlatformSuperadmin: async (user) => {
    const result = await ensurePlatformSuperadminForUser(user);
    return result.isPlatformSuperadmin === true;
  },
});

module.exports = {
  hasCapability,
  requireCapability,
  hasConfigCapability,
  capabilityContextMiddleware,
  hasAnyConfigReadAccess: checkAnyConfigReadAccess,
  getReadableConfigSections,
};
