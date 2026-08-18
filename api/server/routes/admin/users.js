const express = require('express');
const { SystemCapabilities } = require('@librechat/data-schemas');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const { resolveAdminTenant, requireTenant } = require('~/server/middleware/adminTenant');
const { requireJwtAuth } = require('~/server/middleware');
const {
  HttpError,
  createInstitutionImportJob,
  createInstitutionInvite,
  dryRunInstitutionImport,
  getInstitutionImportJob,
  getInstitutionMemberDetail,
  getSeatSummary,
  listInstitutionMembers,
  reactivateInstitutionMember,
  removeInstitutionMember,
  resendInstitutionInvite,
  revokeInstitutionInvite,
  searchInstitutionMembers,
  setInstitutionRole,
  suspendInstitutionMember,
} = require('~/server/services/institutionMembers');
const { getMemberUsageSummary } = require('~/server/services/institutionUsage');

const router = express.Router();

const requireAdminAccess = requireCapability(SystemCapabilities.ACCESS_ADMIN);
const requireReadUsers = requireCapability(SystemCapabilities.READ_USERS);
const requireManageUsers = requireCapability(SystemCapabilities.MANAGE_USERS);

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

router.use(requireJwtAuth, requireAdminAccess, resolveAdminTenant);

router.get('/', requireReadUsers, async (req, res) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) {
    return;
  }

  try {
    const { limit, offset } = parsePagination(req.query);
    const result = await listInstitutionMembers({
      tenantId,
      limit,
      offset,
      query: req.query.q,
      status: req.query.status,
      role: req.query.role,
    });
    return res.status(200).json(result);
  } catch (error) {
    return handleError(res, error, 'Failed to list institution members');
  }
});

router.get('/summary', requireReadUsers, async (req, res) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) {
    return;
  }

  try {
    const summary = await getSeatSummary(tenantId);
    return res.status(200).json(summary);
  } catch (error) {
    return handleError(res, error, 'Failed to load seat summary');
  }
});

router.get('/search', requireReadUsers, async (req, res) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) {
    return;
  }

  const query = typeof req.query.q === 'string' ? req.query.q : '';
  if (!query.trim()) {
    return res.status(400).json({ error: 'Query parameter "q" is required' });
  }

  try {
    const limit = Math.min(
      Math.max(Number.parseInt(String(req.query.limit ?? '20'), 10) || 20, 1),
      50,
    );
    const members = await searchInstitutionMembers({ tenantId, query, limit });
    return res.status(200).json({ members, total: members.length });
  } catch (error) {
    return handleError(res, error, 'Failed to search members');
  }
});

router.post('/invite', requireManageUsers, async (req, res) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) {
    return;
  }

  try {
    const result = await createInstitutionInvite({
      tenantId,
      email: req.body?.email,
      name: req.body?.name,
      requestedRole: req.body?.role,
      creditPackageId: req.body?.creditPackageId,
      invitedBy: req.user,
      context: buildAuditContext(req),
    });
    return res.status(201).json({
      invite: result.invite,
      ...(result.inviteLink ? { inviteLink: result.inviteLink } : null),
    });
  } catch (error) {
    return handleError(res, error, 'Failed to create institution invitation');
  }
});

router.post('/invites/import/dry-run', requireManageUsers, async (req, res) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) {
    return;
  }

  try {
    const result = await dryRunInstitutionImport({
      tenantId,
      csvText: req.body?.csvText,
    });
    return res.status(200).json(result);
  } catch (error) {
    return handleError(res, error, 'Failed to validate CSV import');
  }
});

router.post('/invites/import', requireManageUsers, async (req, res) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) {
    return;
  }

  try {
    const job = await createInstitutionImportJob({
      tenantId,
      csvText: req.body?.csvText,
      actor: req.user,
      context: buildAuditContext(req),
    });
    return res.status(201).json({ job });
  } catch (error) {
    return handleError(res, error, 'Failed to create import job');
  }
});

router.get('/imports/:jobId', requireReadUsers, async (req, res) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) {
    return;
  }

  try {
    const job = await getInstitutionImportJob({
      tenantId,
      jobId: req.params.jobId,
    });
    return res.status(200).json({ job });
  } catch (error) {
    return handleError(res, error, 'Failed to load import job');
  }
});

router.post('/invites/:inviteId/resend', requireManageUsers, async (req, res) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) {
    return;
  }

  try {
    const result = await resendInstitutionInvite({
      tenantId,
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

router.post('/invites/:inviteId/revoke', requireManageUsers, async (req, res) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) {
    return;
  }

  try {
    const invite = await revokeInstitutionInvite({
      tenantId,
      inviteId: req.params.inviteId,
      actor: req.user,
      context: buildAuditContext(req),
    });
    return res.status(200).json({ invite });
  } catch (error) {
    return handleError(res, error, 'Failed to revoke invitation');
  }
});

router.get('/:id', requireReadUsers, async (req, res) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) {
    return;
  }

  try {
    const detail = await getInstitutionMemberDetail({
      tenantId,
      id: req.params.id,
      kind: req.query.kind === 'invite' ? 'invite' : 'user',
    });
    return res.status(200).json({ member: detail });
  } catch (error) {
    return handleError(res, error, 'Failed to load member details');
  }
});

router.get('/:id/usage', requireReadUsers, async (req, res) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) {
    return;
  }

  try {
    await getInstitutionMemberDetail({ tenantId, id: req.params.id, kind: 'user' });
    const result = await getMemberUsageSummary({
      tenantId,
      userId: req.params.id,
      start: req.query.start,
      end: req.query.end,
    });
    return res.status(200).json(result);
  } catch (error) {
    return handleError(res, error, 'Failed to load user usage');
  }
});

router.post('/:id/suspend', requireManageUsers, async (req, res) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) {
    return;
  }

  try {
    const member = await suspendInstitutionMember({
      tenantId,
      userId: req.params.id,
      actor: req.user,
      context: buildAuditContext(req),
    });
    return res.status(200).json({ member });
  } catch (error) {
    return handleError(res, error, 'Failed to suspend member');
  }
});

router.post('/:id/reactivate', requireManageUsers, async (req, res) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) {
    return;
  }

  try {
    const member = await reactivateInstitutionMember({
      tenantId,
      userId: req.params.id,
      actor: req.user,
      context: buildAuditContext(req),
    });
    return res.status(200).json({ member });
  } catch (error) {
    return handleError(res, error, 'Failed to reactivate member');
  }
});

router.post('/:id/remove', requireManageUsers, async (req, res) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) {
    return;
  }

  try {
    const member = await removeInstitutionMember({
      tenantId,
      userId: req.params.id,
      actor: req.user,
      context: buildAuditContext(req),
    });
    return res.status(200).json({ member });
  } catch (error) {
    return handleError(res, error, 'Failed to remove member');
  }
});

router.post('/:id/role', requireManageUsers, async (req, res) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) {
    return;
  }

  try {
    const member = await setInstitutionRole({
      tenantId,
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
