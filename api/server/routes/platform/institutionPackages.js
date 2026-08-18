const express = require('express');
const { runAsSystem } = require('@librechat/data-schemas');
const { requireJwtAuth } = require('~/server/middleware');
const requirePlatformSuperadmin = require('~/server/middleware/platformAdmin');
const models = require('~/db/models');

const router = express.Router();
router.use(requireJwtAuth, requirePlatformSuperadmin);

router.get('/', async (req, res) => {
  const filter = req.query.includeInactive === 'true' ? {} : { active: true };
  const packages = await runAsSystem(() => models.InstitutionPackage.find(filter).sort({ createdAt: -1 }).lean().exec());
  return res.json({ packages });
});

router.post('/', async (req, res) => {
  try {
    const { id, name, description, price, currency = 'USD', monthlyTokenLimit } = req.body ?? {};
    if (!id || !name || !Number.isInteger(monthlyTokenLimit) || monthlyTokenLimit < 1) return res.status(400).json({ error: 'id, name, and a positive monthlyTokenLimit are required' });
    const pkg = await runAsSystem(() => models.InstitutionPackage.create({ id, name, description, price: Number(price) || 0, currency, monthlyTokenLimit, createdBy: req.user.id ?? req.user._id, updatedBy: req.user.id ?? req.user._id }));
    return res.status(201).json({ package: pkg });
  } catch (error) {
    return res.status(error?.code === 11000 ? 409 : 400).json({ error: error.message });
  }
});

router.patch('/:id', async (req, res) => {
  const updates = {};
  for (const field of ['name', 'description', 'price', 'currency', 'monthlyTokenLimit', 'active']) if (req.body?.[field] !== undefined) updates[field] = req.body[field];
  if (updates.monthlyTokenLimit !== undefined && (!Number.isInteger(updates.monthlyTokenLimit) || updates.monthlyTokenLimit < 1)) return res.status(400).json({ error: 'monthlyTokenLimit must be positive' });
  const pkg = await runAsSystem(() => models.InstitutionPackage.findOneAndUpdate({ id: req.params.id }, { $set: { ...updates, updatedBy: req.user.id ?? req.user._id } }, { new: true, runValidators: true }).lean().exec());
  if (!pkg) return res.status(404).json({ error: 'Institution package not found' });
  return res.json({ package: pkg });
});

router.post('/:id/deactivate', async (req, res) => {
  const pkg = await runAsSystem(() => models.InstitutionPackage.findOneAndUpdate({ id: req.params.id }, { $set: { active: false, updatedBy: req.user.id ?? req.user._id } }, { new: true }).lean().exec());
  if (!pkg) return res.status(404).json({ error: 'Institution package not found' });
  return res.json({ package: pkg });
});

module.exports = router;
