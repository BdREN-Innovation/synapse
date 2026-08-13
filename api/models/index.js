const mongoose = require('mongoose');
const { createMethods } = require('@librechat/data-schemas');
const { matchModelName, findMatchingPattern, isDeploymentSkillId } = require('@librechat/api');
const getLogStores = require('~/cache/getLogStores');

const methods = createMethods(mongoose, {
  matchModelName,
  findMatchingPattern,
  isExternalSkillId: isDeploymentSkillId,
  getCache: getLogStores,
});

const parsePlatformSuperadminEmails = () =>
  (process.env.PLATFORM_SUPERADMIN_EMAILS || '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);

const seedDatabase = async () => {
  await methods.initializeRoles();
  await methods.seedDefaultRoles();
  await methods.ensureDefaultCategories();
  await methods.seedSystemGrants();
  await methods.seedPlatformSuperadmins(parsePlatformSuperadminEmails());
};

module.exports = {
  ...methods,
  seedDatabase,
};
