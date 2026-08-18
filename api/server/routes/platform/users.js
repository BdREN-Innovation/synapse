const express = require('express');
const mongoose = require('mongoose');
const { runAsSystem } = require('@librechat/data-schemas');
const { requireJwtAuth } = require('~/server/middleware');
const requirePlatformSuperadmin = require('~/server/middleware/platformAdmin');
const models = require('~/db/models');
const db = require('~/models');
const { resendUserVerificationEmail } = require('~/server/services/AuthService');
const { isPlatformAdminEmail } = require('~/server/services/platformAdmin');
const { getMemberUsageSummary } = require('~/server/services/institutionUsage');
const {
  HttpError,
  listPlatformInstitutionMembers,
  createStandaloneInvite,
  reactivateInstitutionMember,
  removeInstitutionMember,
  resendInstitutionInvite,
  resendStandaloneInvite,
  revokeInstitutionInvite,
  revokeStandaloneInvite,
  setInstitutionRole,
  suspendInstitutionMember,
  suspendStandaloneMember,
  removeStandaloneMember,
  reactivateStandaloneMember,
} = require('~/server/services/institutionMembers');

const router = express.Router();

function parsePagination(query) {
  const rawLimit = Number.parseInt(String(query.limit ?? ''), 10);
  const rawOffset = Number.parseInt(String(query.offset ?? ''), 10);
  return {
    limit: Math.min(Math.max(Number.isNaN(rawLimit) ? 25 : rawLimit, 1), 100),
    offset: Math.max(Number.isNaN(rawOffset) ? 0 : rawOffset, 0),
  };
}

function buildAuditContext(req) {
  const forwarded =
    typeof req.headers['x-forwarded-for'] === 'string'
      ? req.headers['x-forwarded-for'].split(',')[0]?.trim()
      : undefined;

  return {
    ip: req.ip || forwarded || req.socket?.remoteAddress,
    userAgent: Array.isArray(req.headers['user-agent'])
      ? req.headers['user-agent'][0]
      : req.headers['user-agent'],
    requestId:
      (Array.isArray(req.headers['x-request-id'])
        ? req.headers['x-request-id'][0]
        : req.headers['x-request-id']) ||
      (Array.isArray(req.headers['x-correlation-id'])
        ? req.headers['x-correlation-id'][0]
        : req.headers['x-correlation-id']),
  };
}

function handleError(res, error, fallback) {
  if (error instanceof HttpError) {
    return res.status(error.statusCode).json({ error: error.message });
  }
  return res.status(500).json({ error: fallback });
}

function requireTenantId(req) {
  const tenantId = req.body?.tenantId;
  if (typeof tenantId !== 'string' || !tenantId.trim()) {
    throw new HttpError(400, 'tenantId is required');
  }
  return tenantId.trim();
}

async function findPlatformUser(id) {
  const user = await runAsSystem(() => models.User.findById(id).lean().exec());
  if (!user) {
    throw new HttpError(404, 'User not found');
  }
  if (await isPlatformAdminEmail(user.email)) {
    throw new HttpError(403, 'Platform administrator details are not available here');
  }
  return user;
}

async function resolvePlatformMutationTarget(id) {
  const user = await findPlatformUser(id);
  if (!user.tenantId) {
    return { user, tenantId: null };
  }
  const institution = await runAsSystem(() =>
    models.Institution.findOne({ tenantId: user.tenantId }).select('_id').lean().exec(),
  );
  return { user, tenantId: institution ? user.tenantId : null };
}

async function mapPlatformUser(user) {
  const institution = user.tenantId
    ? await runAsSystem(() =>
        models.Institution.findOne({ tenantId: user.tenantId }).select('name').lean().exec(),
      )
    : null;
  return {
    id: user._id.toString(),
    kind: 'user',
    tenantId: user.tenantId ?? undefined,
    accountScope: user.tenantId ? 'institution' : 'standalone',
    institutionName: institution?.name ?? 'Others',
    name: user.name ?? '',
    username: user.username ?? null,
    email: user.email ?? '',
    emailVerified: user.emailVerified === true,
    role: user.role === 'INSTITUTION_ADMIN' ? 'INSTITUTION_ADMIN' : 'USER',
    status: user.membershipStatus ?? 'active',
    provider: user.provider ?? 'local',
    createdAt: user.createdAt?.toISOString?.() ?? user.createdAt,
    updatedAt: user.updatedAt?.toISOString?.() ?? user.updatedAt,
    suspendedAt: user.suspendedAt?.toISOString?.() ?? user.suspendedAt ?? null,
    removedAt: user.removedAt?.toISOString?.() ?? user.removedAt ?? null,
  };
}

async function getPlatformCreditPackages() {
  const { getAppConfig } = require('~/server/services/Config');
  const appConfig = await getAppConfig({ baseOnly: true });
  return appConfig?.config?.creditPackages ?? appConfig?.creditPackages ?? { currency: 'BDT', list: [] };
}

async function getCreditPackagesForUser(user) {
  const { getAppConfig } = require('~/server/services/Config');
  const appConfig = user.tenantId
    ? await getAppConfig({ tenantId: user.tenantId })
    : await getAppConfig({ baseOnly: true });
  return appConfig?.config?.creditPackages ?? appConfig?.creditPackages ?? { currency: 'BDT', list: [] };
}

router.use(requireJwtAuth, requirePlatformSuperadmin);

router.get('/', async (req, res) => {
  try {
    const { limit, offset } = parsePagination(req.query);
    const result = await listPlatformInstitutionMembers({
      tenantId: typeof req.query.tenantId === 'string' ? req.query.tenantId.trim() : undefined,
      ...(typeof req.query.accountScope === 'string' ? { accountScope: req.query.accountScope } : null),
      limit,
      offset,
      query: req.query.q,
      status: req.query.status,
      role: req.query.role,
    });
    return res.status(200).json(result);
  } catch (error) {
    return handleError(res, error, 'Failed to list platform members');
  }
});

router.get('/standalone/packages', async (req, res) => {
  return res.status(200).json(await getPlatformCreditPackages());
});

router.post('/standalone/invites', async (req, res) => {
  try {
    const result = await createStandaloneInvite({
      email: req.body?.email,
      username: req.body?.username,
      creditPackageId: req.body?.creditPackageId,
      invitedBy: req.user,
      context: buildAuditContext(req),
    });
    return res.status(201).json({ invite: result.invite, ...(result.inviteLink ? { inviteLink: result.inviteLink } : null) });
  } catch (error) {
    return handleError(res, error, 'Failed to create individual user invitation');
  }
});

router.get('/:id', async (req, res) => {
  try {
    const user = await findPlatformUser(req.params.id);
    return res.status(200).json({ member: await mapPlatformUser(user) });
  } catch (error) {
    return handleError(res, error, 'Failed to load user details');
  }
});

router.get('/:id/usage', async (req, res) => {
  try {
    const user = await findPlatformUser(req.params.id);
    const result = await getMemberUsageSummary({
      tenantId: user.tenantId ?? null,
      userId: req.params.id,
      start: req.query.start,
      end: req.query.end,
    });
    return res.status(200).json(result);
  } catch (error) {
    return handleError(res, error, 'Failed to load user usage');
  }
});

router.get('/:id/credits', async (req, res) => {
  try {
    const user = await findPlatformUser(req.params.id);
    const tenantFilter = user.tenantId
      ? { tenantId: user.tenantId }
      : { $or: [{ tenantId: null }, { tenantId: { $exists: false } }] };
    const packages = await getCreditPackagesForUser(user);
    const balance = await models.Balance.findOne({ user: user._id }).lean().exec();
    const Grant = mongoose.models.CreditGrant;
    const grants = await Grant.find({ user: user._id, ...tenantFilter })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean()
      .exec();
    return res.json({ balance: balance?.tokenCredits ?? 0, grants, packages });
  } catch (error) {
    return handleError(res, error, 'Failed to load user credits');
  }
});

router.post('/:id/credits/grant', async (req, res) => {
  try {
    const user = await findPlatformUser(req.params.id);
    const config = await getCreditPackagesForUser(user);
    const pkg = config.list.find((item) => item.id === req.body?.packageId);
    if (!pkg) {
      throw new HttpError(400, 'Invalid credit package');
    }
    const appConfig = require('~/server/services/Config');
    const loadedConfig = user.tenantId
      ? await appConfig.getAppConfig({ tenantId: user.tenantId })
      : await appConfig.getAppConfig({ baseOnly: true });
    const result = await db.createTransaction({
      user: user._id,
      tokenType: 'credits',
      context: 'purchase',
      rawAmount: pkg.credits,
      balance: loadedConfig?.config?.balance ?? loadedConfig?.balance,
      tenantId: user.tenantId ?? null,
    });
    if (!result) {
      throw new HttpError(503, 'Balance is disabled');
    }
    const Grant = mongoose.models.CreditGrant;
    const grant = await Grant.create({
      user: user._id,
      tenantId: user.tenantId ?? null,
      packageId: pkg.id,
      credits: pkg.credits,
      price: pkg.price,
      currency: config.currency,
      reference: req.body.reference || null,
      note: req.body.note || '',
      source: 'topup',
      grantedBy: req.user?._id || null,
    });
    return res.status(201).json({ balance: result.balance, grant });
  } catch (error) {
    return handleError(res, error, 'Failed to grant credits');
  }
});

router.post('/standalone/invites/:inviteId/resend', async (req, res) => {
  try {
    const result = await resendStandaloneInvite({ inviteId: req.params.inviteId, actor: req.user, context: buildAuditContext(req) });
    return res.json({ invite: result.invite, ...(result.inviteLink ? { inviteLink: result.inviteLink } : null) });
  } catch (error) { return handleError(res, error, 'Failed to resend invitation'); }
});

router.post('/standalone/invites/:inviteId/revoke', async (req, res) => {
  try { return res.json({ invite: await revokeStandaloneInvite({ inviteId: req.params.inviteId, actor: req.user, context: buildAuditContext(req) }) }); }
  catch (error) { return handleError(res, error, 'Failed to revoke invitation'); }
});

router.post('/invites/:inviteId/resend', async (req, res) => {
  try {
    const result = await resendInstitutionInvite({
      tenantId: requireTenantId(req),
      inviteId: req.params.inviteId,
      actor: req.user,
      context: buildAuditContext(req),
    });
    return res.status(200).json({
      invite: result.invite,
      ...(result.inviteLink ? { inviteLink: result.inviteLink } : null),
    });
  } catch (error) {
    return handleError(res, error, 'Failed to resend invitation');
  }
});

router.post('/invites/:inviteId/revoke', async (req, res) => {
  try {
    const invite = await revokeInstitutionInvite({
      tenantId: requireTenantId(req),
      inviteId: req.params.inviteId,
      actor: req.user,
      context: buildAuditContext(req),
    });
    return res.status(200).json({ invite });
  } catch (error) {
    return handleError(res, error, 'Failed to revoke invitation');
  }
});

router.post('/:id/resend-verification', async (req, res) => {
  try {
    const tenantId = requireTenantId(req);
    const user = await runAsSystem(() =>
      models.User.findOne({ _id: req.params.id, tenantId })
        .select('_id email name username emailVerified')
        .lean()
        .exec(),
    );
    if (!user) {
      throw new HttpError(404, 'Member not found');
    }
    if (user.emailVerified) {
      throw new HttpError(409, 'This member email is already verified');
    }

    await resendUserVerificationEmail(user);
    return res.status(200).json({ message: 'Verification email sent' });
  } catch (error) {
    return handleError(res, error, 'Failed to resend verification email');
  }
});

router.post('/:id/suspend', async (req, res) => {
  try {
    const target = await resolvePlatformMutationTarget(req.params.id);
    const member = target.tenantId
      ? await suspendInstitutionMember({
          tenantId: target.tenantId,
          userId: req.params.id,
          actor: req.user,
          context: buildAuditContext(req),
        })
      : await suspendStandaloneMember({
          userId: req.params.id,
          actor: req.user,
          context: buildAuditContext(req),
        });
    return res.status(200).json({ member });
  } catch (error) {
    return handleError(res, error, 'Failed to suspend member');
  }
});

router.post('/:id/reactivate', async (req, res) => {
  try {
    const target = await resolvePlatformMutationTarget(req.params.id);
    const member = target.tenantId
      ? await reactivateInstitutionMember({
          tenantId: target.tenantId,
          userId: req.params.id,
          actor: req.user,
          context: buildAuditContext(req),
        })
      : await reactivateStandaloneMember({
          userId: req.params.id,
          actor: req.user,
          context: buildAuditContext(req),
        });
    return res.status(200).json({ member });
  } catch (error) {
    return handleError(res, error, 'Failed to reactivate member');
  }
});

router.post('/:id/remove', async (req, res) => {
  try {
    const target = await resolvePlatformMutationTarget(req.params.id);
    const member = target.tenantId
      ? await removeInstitutionMember({
          tenantId: target.tenantId,
          userId: req.params.id,
          actor: req.user,
          context: buildAuditContext(req),
        })
      : await removeStandaloneMember({
          userId: req.params.id,
          actor: req.user,
          context: buildAuditContext(req),
        });
    return res.status(200).json({ member });
  } catch (error) {
    return handleError(res, error, 'Failed to remove member');
  }
});

router.post('/:id/role', async (req, res) => {
  try {
    const member = await setInstitutionRole({
      tenantId: requireTenantId(req),
      userId: req.params.id,
      role: req.body?.role,
      actor: req.user,
      context: buildAuditContext(req),
    });
    return res.status(200).json({ member });
  } catch (error) {
    return handleError(res, error, 'Failed to update member role');
  }
});

module.exports = router;
