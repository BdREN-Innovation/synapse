const { generateCapabilityCheck, capabilityContextMiddleware } = require('@librechat/api');
const { getUserPrincipals, hasCapabilityForPrincipals } = require('~/models');
const { ensurePlatformSuperadminForUser } = require('~/server/services/platformAdmin');

const { hasCapability, requireCapability, hasConfigCapability } = generateCapabilityCheck({
  getUserPrincipals,
  hasCapabilityForPrincipals,
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
};
