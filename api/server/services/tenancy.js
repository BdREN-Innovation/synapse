const { PrincipalType, SystemRoles, roleDefaults } = require('librechat-data-provider');
const {
  INSTITUTION_ADMIN_ROLE,
  SystemCapabilities,
  tenantStorage,
} = require('@librechat/data-schemas');
const db = require('~/models');

/** Resolved on use rather than at module load: this module sits on the require
 * chain of routes whose tests stub `@librechat/data-schemas`, and dereferencing
 * the enum during import makes the whole chain fail to load. */
function getInstitutionAdminCapabilities() {
  return [
    SystemCapabilities.ACCESS_ADMIN,
    SystemCapabilities.READ_USERS,
    SystemCapabilities.MANAGE_USERS,
    SystemCapabilities.READ_GROUPS,
    SystemCapabilities.MANAGE_GROUPS,
    SystemCapabilities.READ_ROLES,
    SystemCapabilities.READ_USAGE,
  ];
}

const institutionAdminDescription =
  'Tenant-scoped institution administrator. Platform authority is not inherited.';

async function ensureInstitutionAdminRole(tenantId) {
  await tenantStorage.run({ tenantId }, async () => {
    const role = await db.getRoleByName(INSTITUTION_ADMIN_ROLE);
    if (!role) {
      await db.createRoleByName({
        name: INSTITUTION_ADMIN_ROLE,
        description: institutionAdminDescription,
        permissions: roleDefaults[SystemRoles.USER].permissions,
      });
    }
  });

  await Promise.all(
    getInstitutionAdminCapabilities().map((capability) =>
      db.grantCapability({
        principalType: PrincipalType.ROLE,
        principalId: INSTITUTION_ADMIN_ROLE,
        capability,
        tenantId,
      }),
    ),
  );
}

async function appointInstitutionAdmin({ tenantId, userId }) {
  await ensureInstitutionAdminRole(tenantId);

  return await tenantStorage.run({ tenantId }, async () => {
    const user = await db.getUserById(userId, '_id id email role tenantId');
    if (!user) {
      return null;
    }
    return await db.updateUser(userId, { role: INSTITUTION_ADMIN_ROLE });
  });
}

async function revokeInstitutionAdmin({ tenantId, userId }) {
  return await tenantStorage.run({ tenantId }, async () => {
    const user = await db.getUserById(userId, '_id id email role tenantId');
    if (!user) {
      return null;
    }
    if (user.role !== INSTITUTION_ADMIN_ROLE) {
      return user;
    }
    return await db.updateUser(userId, { role: SystemRoles.USER });
  });
}

module.exports = {
  getInstitutionAdminCapabilities,
  ensureInstitutionAdminRole,
  appointInstitutionAdmin,
  revokeInstitutionAdmin,
};
