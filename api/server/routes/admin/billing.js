const express = require('express');
const mongoose = require('mongoose');
const { SystemCapabilities } = require('@librechat/data-schemas');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const { resolveAdminTenant, requireTenant } = require('~/server/middleware/adminTenant');
const { requireJwtAuth } = require('~/server/middleware');
const db = require('~/models');

const router = express.Router();
const requireAdminAccess = requireCapability(SystemCapabilities.ACCESS_ADMIN);
const requireReadUsers = requireCapability(SystemCapabilities.READ_USERS);
const requireManageUsers = requireCapability(SystemCapabilities.MANAGE_USERS);

router.use(requireJwtAuth, requireAdminAccess, resolveAdminTenant);

function packages(req) {
  return req.config?.creditPackages ?? { currency: 'BDT', list: [] };
}

router.get('/packages', requireReadUsers, (req, res) => res.json(packages(req)));

router.get('/:userId', requireReadUsers, async (req, res) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;
  try {
    const user = await db.findUser({ _id: req.params.userId }, '_id');
    if (!user) return res.status(404).json({ error: 'User not found' });
    const balance = await db.findBalanceByUser(req.params.userId);
    const Grant = mongoose.models.CreditGrant;
    const grants = await Grant.find({ user: user._id, tenantId }).sort({ createdAt: -1 }).limit(100).lean().exec();
    return res.json({ balance: balance?.tokenCredits ?? 0, grants, packages: packages(req) });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.post('/:userId/grant', requireManageUsers, async (req, res) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;
  try {
    const config = packages(req);
    const pkg = config.list.find((item) => item.id === req.body?.packageId);
    if (!pkg) return res.status(400).json({ error: 'Invalid credit package' });
    const user = await db.findUser({ _id: req.params.userId }, '_id');
    if (!user) return res.status(404).json({ error: 'User not found' });
    const result = await db.createTransaction({ user: user._id, tokenType: 'credits', context: 'purchase', rawAmount: pkg.credits, balance: req.config?.balance, tenantId });
    if (!result) return res.status(503).json({ error: 'Balance is disabled' });
    const Grant = mongoose.models.CreditGrant;
    const grant = await Grant.create({ user: user._id, tenantId, packageId: pkg.id, credits: pkg.credits, price: pkg.price, currency: config.currency, reference: req.body.reference || null, note: req.body.note || '', source: 'topup', grantedBy: req.user?._id || null });
    return res.status(201).json({ balance: result.balance, grant });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

module.exports = router;
