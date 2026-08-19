const express = require('express');
const { createUserPreferencesHandler } = require('@librechat/api');
const {
  updateUserPluginsController,
  resendVerificationController,
  getTermsStatusController,
  acceptTermsController,
  verifyEmailController,
  deleteUserController,
  getUserController,
} = require('~/server/controllers/UserController');
const {
  verifyEmailLimiter,
  verifyEmailSubmissionLimiter,
  configMiddleware,
  canDeleteAccount,
  requireJwtAuth,
} = require('~/server/middleware');

const settings = require('./settings');
const {
  HttpError: UsageHttpError,
  getMemberUsageSummary,
} = require('~/server/services/institutionUsage');
const { updateUserStatefulCodeEnvironment } = require('~/models');

const router = express.Router();

const updateUserPreferences = createUserPreferencesHandler({
  updateStatefulCodeEnvironment: updateUserStatefulCodeEnvironment,
});

router.use('/settings', settings);
router.get('/', requireJwtAuth, getUserController);
router.get('/usage', requireJwtAuth, async (req, res) => {
  const tenantId = req.user?.tenantId;
  const userId = req.user?.id ?? req.user?._id?.toString();
  if (!tenantId || !userId) {
    return res.status(403).json({ error: 'Institution membership is required' });
  }

  try {
    const result = await getMemberUsageSummary({
      tenantId,
      userId,
      start: req.query.start,
      end: req.query.end,
    });
    return res.status(200).json(result);
  } catch (error) {
    if (error instanceof UsageHttpError) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    return res.status(500).json({ error: 'Failed to load your usage' });
  }
});
router.patch('/preferences', requireJwtAuth, configMiddleware, updateUserPreferences);
router.get('/terms', requireJwtAuth, getTermsStatusController);
router.post('/terms/accept', requireJwtAuth, acceptTermsController);
router.post('/plugins', requireJwtAuth, updateUserPluginsController);
router.delete('/delete', requireJwtAuth, canDeleteAccount, configMiddleware, deleteUserController);
router.post('/verify', verifyEmailSubmissionLimiter, verifyEmailController);
router.post('/verify/resend', verifyEmailLimiter, resendVerificationController);

module.exports = router;
