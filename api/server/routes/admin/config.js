const express = require('express');
const { createAdminConfigHandlers } = require('@librechat/api');
const { SystemCapabilities } = require('@librechat/data-schemas');
const {
  hasCapability,
  requireCapability,
  hasConfigCapability,
  hasAnyConfigReadAccess,
  getReadableConfigSections,
} = require('~/server/middleware/roles/capabilities');
const { getAppConfig, invalidateConfigCaches } = require('~/server/services/Config');
const { requireJwtAuth } = require('~/server/middleware');
const db = require('~/models');
const { BASE_CONFIG_PRINCIPAL_ID } = require('@librechat/data-schemas');

const router = express.Router();

const requireAdminAccess = requireCapability(SystemCapabilities.ACCESS_ADMIN);

const handlers = createAdminConfigHandlers({
  listAllConfigs: db.listAllConfigs,
  findConfigByPrincipal: db.findConfigByPrincipal,
  upsertConfig: db.upsertConfig,
  patchConfigFields: db.patchConfigFields,
  tombstoneConfigField: db.tombstoneConfigField,
  unsetConfigField: db.unsetConfigField,
  deleteConfig: db.deleteConfig,
  toggleConfigActive: db.toggleConfigActive,
  hasAnyConfigReadAccess,
  getReadableConfigSections,
  hasConfigCapability,
  hasCapability,
  getAppConfig,
  invalidateConfigCaches,
});

router.use(requireJwtAuth, requireAdminAccess);

const rejectGlobalMutation = (req, res, next) => {
  const isMutation = ['PUT', 'PATCH', 'POST', 'DELETE'].includes(req.method);
  if (isMutation && req.params.principalId === BASE_CONFIG_PRINCIPAL_ID) {
    return res.status(403).json({
      code: 'GLOBAL_CONFIG_ROUTE_REQUIRED',
      error: 'Global configuration changes require the platform Superadmin API',
    });
  }
  return next();
};

router.get('/', handlers.listConfigs);
router.get('/base', handlers.getBaseConfig);
router.get('/:principalType/:principalId', handlers.getConfig);
router.put('/:principalType/:principalId', rejectGlobalMutation, handlers.upsertConfigOverrides);
router.patch('/:principalType/:principalId/fields', rejectGlobalMutation, handlers.patchConfigField);
router.post('/:principalType/:principalId/fields/tombstone', rejectGlobalMutation, handlers.tombstoneConfigField);
router.delete('/:principalType/:principalId/fields', rejectGlobalMutation, handlers.deleteConfigField);
router.delete('/:principalType/:principalId', rejectGlobalMutation, handlers.deleteConfigOverrides);
router.patch('/:principalType/:principalId/active', rejectGlobalMutation, handlers.toggleConfig);

module.exports = router;
