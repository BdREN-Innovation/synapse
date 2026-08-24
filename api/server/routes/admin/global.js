const express = require('express');
const { createGlobalConfigHandlers } = require('@librechat/api');
const { requireJwtAuth } = require('~/server/middleware');
const requirePlatformSuperadmin = require('~/server/middleware/platformAdmin');
const { getAppConfig, invalidateConfigCaches } = require('~/server/services/Config');
const db = require('~/models');

const router = express.Router();
const handlers = createGlobalConfigHandlers({
  findConfigByPrincipal: db.findConfigByPrincipal,
  upsertConfig: db.upsertConfig,
  patchConfigFields: db.patchConfigFields,
  unsetConfigField: db.unsetConfigField,
  deleteConfig: db.deleteConfig,
  getAppConfig,
  invalidateConfigCaches,
  recordAuditEntry: db.recordAuditEntry,
});

router.use(requireJwtAuth, requirePlatformSuperadmin);
router.get('/config', handlers.read);
router.put('/config', handlers.replace);
router.patch('/config/fields', handlers.patch);
router.delete('/config/fields', handlers.resetField);
router.post('/config/import', handlers.replace);
router.delete('/config', handlers.reset);

module.exports = router;
