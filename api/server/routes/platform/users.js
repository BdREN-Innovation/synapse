const express = require('express');
const { runAsSystem } = require('@librechat/data-schemas');
const { requireJwtAuth } = require('~/server/middleware');
const requirePlatformSuperadmin = require('~/server/middleware/platformAdmin');
const models = require('~/db/models');
const { resendUserVerificationEmail } = require('~/server/services/AuthService');
const {
  HttpError,
  listPlatformInstitutionMembers,
  reactivateInstitutionMember,
  removeInstitutionMember,
  resendInstitutionInvite,
  revokeInstitutionInvite,
  setInstitutionRole,
  suspendInstitutionMember,
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

router.use(requireJwtAuth, requirePlatformSuperadmin);

router.get('/', async (req, res) => {
  try {
    const { limit, offset } = parsePagination(req.query);
    const result = await listPlatformInstitutionMembers({
      tenantId: typeof req.query.tenantId === 'string' ? req.query.tenantId.trim() : undefined,
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
    const member = await suspendInstitutionMember({
      tenantId: requireTenantId(req),
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
    const member = await reactivateInstitutionMember({
      tenantId: requireTenantId(req),
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
    const member = await removeInstitutionMember({
      tenantId: requireTenantId(req),
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
