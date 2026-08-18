const express = require('express');
const { logger, runAsSystem, INSTITUTION_ADMIN_ROLE } = require('@librechat/data-schemas');
const {
  AccessRoleIds,
  PermissionBits,
  PrincipalType,
  ResourceType,
} = require('librechat-data-provider');
const { requireJwtAuth } = require('~/server/middleware');
const requirePlatformSuperadmin = require('~/server/middleware/platformAdmin');
const {
  appointInstitutionAdmin,
  ensureInstitutionAdminRole,
  revokeInstitutionAdmin,
} = require('~/server/services/tenancy');
const {
  assertSeatLimitChangeAllowed,
  createInstitutionInvite,
  listInstitutionMembers,
  HttpError,
} = require('~/server/services/institutionMembers');
const db = require('~/models');
const models = require('~/db/models');
const {
  PolicyError,
  createUsagePolicy,
  getPolicyConsole,
  listUsagePolicies,
  previewUsagePolicy,
} = require('~/server/services/usagePolicy');
const {
  getUsageSummary,
  listUsageByMember,
  listUsageByModel,
} = require('~/server/services/institutionUsage');
const { getShadowReadiness } = require('~/server/services/usageQuota');

const router = express.Router();

router.use(requireJwtAuth, requirePlatformSuperadmin);

/**
 * Fields a platform superadmin may set through the institution mutation
 * contracts. Lifecycle-owned fields (`status`, `suspendedAt`, `suspendedBy`),
 * derived counters (`stats`), provenance (`createdBy`, `tenantId`), and
 * timestamps are deliberately excluded and can only change through their
 * dedicated endpoints. See P1-2 in the reconciliation plan.
 */
const INSTITUTION_UPDATABLE_FIELDS = ['name', 'slug', 'authDomains', 'timezone'];
const INSTITUTION_UPDATABLE_LIMITS = ['maxActiveMembers'];

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

function actorFromRequest(req) {
  return {
    type: 'user',
    id: req.user?.id ?? req.user?._id?.toString(),
    name: req.user?.name || req.user?.email || 'platform-superadmin',
  };
}

/**
 * Emits an append-only platform audit entry. Platform mutations are
 * security-sensitive, so the write is fail-closed by default: a failed audit
 * surfaces as a request error rather than a silently missing record.
 */
async function recordPlatformAudit(req, { action, target, metadata, outcome, severity }) {
  await db.recordAuditEntry(
    {
      action,
      actor: actorFromRequest(req),
      target,
      ...(metadata ? { metadata } : null),
      ...(outcome ? { outcome } : null),
      ...(severity ? { severity } : null),
      context: buildAuditContext(req),
      tenantId: undefined,
    },
    { failClosed: true },
  );
}

/**
 * A seat limit of zero or below cannot be satisfied by any member, so it would
 * silently brick onboarding for that institution; `null` is the explicit way to
 * say "unlimited". `findOneAndUpdate` does not run schema validators, so the
 * schema's own `min: 1` never fires on an update and this is the only guard.
 */
function normalizeSeatLimit(value) {
  if (value === null) {
    return null;
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new HttpError(
      400,
      'limits.maxActiveMembers must be a positive whole number, or null for unlimited',
    );
  }
  return parsed;
}

/** Keeps only allowlisted institution fields, dropping everything else. */
function pickInstitutionUpdates(body) {
  const updates = {};
  for (const field of INSTITUTION_UPDATABLE_FIELDS) {
    if (body[field] !== undefined) {
      updates[field] = body[field];
    }
  }
  if (body.limits && typeof body.limits === 'object') {
    const limits = {};
    for (const field of INSTITUTION_UPDATABLE_LIMITS) {
      if (body.limits[field] !== undefined) {
        limits[field] =
          field === 'maxActiveMembers'
            ? normalizeSeatLimit(body.limits[field])
            : body.limits[field];
      }
    }
    if (Object.keys(limits).length > 0) {
      updates.limits = limits;
    }
  }
  return updates;
}

async function resolveInstitutionAdminTarget({ tenantId, userId, email, name, actor, context }) {
  if (userId) {
    const user = await appointInstitutionAdmin({ tenantId, userId });
    if (!user) {
      throw new HttpError(404, 'User not found');
    }
    return { user };
  }

  const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!normalizedEmail) {
    return {};
  }

  const existingUser = await runAsSystem(() =>
    db.findUser({ email: normalizedEmail }, '_id id email tenantId'),
  );

  if (existingUser?._id && existingUser.tenantId === tenantId) {
    const user = await appointInstitutionAdmin({
      tenantId,
      userId: existingUser._id.toString(),
    });
    if (!user) {
      throw new HttpError(404, 'User not found');
    }
    return { user };
  }

  if (existingUser?.tenantId && existingUser.tenantId !== tenantId) {
    throw new HttpError(409, 'This email already belongs to a different institution');
  }

  // A tenant-less existing identity must accept the invitation before it is
  // attached to the institution. This keeps tenant assignment explicit and
  // lets the shared invite-acceptance path enforce the seat limit.
  const inviteResult = await createInstitutionInvite({
    tenantId,
    email: normalizedEmail,
    name,
    requestedRole: 'INSTITUTION_ADMIN',
    invitedBy: actor,
    context,
  });

  return {
    invite: inviteResult.invite,
    inviteLink: inviteResult.inviteLink ?? null,
  };
}

router.get('/', async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const filter = {};
    if (typeof req.query.status === 'string' && req.query.status) {
      filter.status = req.query.status;
    } else {
      filter.status = { $ne: 'closed' };
    }
    if (typeof req.query.q === 'string' && req.query.q.trim()) {
      const escaped = req.query.q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const search = new RegExp(escaped, 'i');
      filter.$or = [{ name: search }, { tenantId: search }, { slug: search }];
    }
    const [institutions, total] = await runAsSystem(() =>
      Promise.all([db.listInstitutions({ filter, limit, offset }), db.countInstitutions(filter)]),
    );
    return res.status(200).json({ institutions, total, limit, offset });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to list institutions' });
  }
});

router.delete('/:tenantId', async (req, res) => {
  const { tenantId } = req.params;
  try {
    const institution = await runAsSystem(() =>
      models.Institution.findOneAndUpdate(
        { tenantId: tenantId.trim(), status: { $ne: 'closed' } },
        { $set: { status: 'closed' } },
        { new: true },
      )
        .lean()
        .exec(),
    );
    if (!institution) {
      return res.status(404).json({ error: 'Institution not found or already removed' });
    }

    await recordPlatformAudit(req, {
      action: 'institution.updated',
      severity: 'warning',
      target: { type: 'institution', id: tenantId, name: institution.name },
      metadata: { operation: 'closed', status: 'closed' },
    });
    return res.status(200).json({ institution });
  } catch (error) {
    logger.error('[platform/institutions] close failed', error);
    return res.status(500).json({ error: 'Failed to remove institution' });
  }
});

router.post('/', async (req, res) => {
  try {
    const {
      tenantId,
      name,
      slug,
      authDomains,
      timezone,
      adminUserId,
      adminEmail,
      adminName,
      limits,
      packageId,
      monthlyTokenLimit,
    } = req.body ?? {};
    if (!tenantId || !name) {
      return res.status(400).json({ error: 'tenantId and name are required' });
    }
    if (!adminUserId && !adminEmail) {
      return res.status(400).json({
        error: 'An initial institution admin email or user ID is required',
      });
    }

    if (adminEmail) {
      const normalizedAdminEmail = String(adminEmail).trim().toLowerCase();
      const conflictingUser = await runAsSystem(() =>
        db.findUser({ email: normalizedAdminEmail }, '_id tenantId'),
      );
      if (conflictingUser?.tenantId && conflictingUser.tenantId !== tenantId) {
        return res.status(409).json({
          error: 'The initial admin email already belongs to a different institution',
        });
      }
    }

    const safeLimits =
      limits && typeof limits === 'object' ? pickInstitutionUpdates({ limits }).limits : undefined;

    const institution = await runAsSystem(async () => {
      const existing = await db.getInstitutionByTenantId(tenantId);
      if (existing) {
        return null;
      }
      const created = await db.createInstitution({
        tenantId,
        name,
        slug,
        authDomains,
        ...(timezone !== undefined ? { timezone } : null),
        ...(safeLimits ? { limits: safeLimits } : null),
        stats: { activeMembers: 0 },
        createdBy: req.user.id ?? req.user._id,
      });
      if (packageId) {
        const pkg = await models.InstitutionPackage.findOne({ id: packageId, active: true }).lean().exec();
        if (!pkg) throw new HttpError(400, 'Active institution package not found');
        const effectiveLimit = Number.isInteger(monthlyTokenLimit) && monthlyTokenLimit > 0 ? monthlyTokenLimit : pkg.monthlyTokenLimit;
        created.packageAssignment = { packageId: pkg.id, packageSnapshot: { name: pkg.name, description: pkg.description, price: pkg.price, currency: pkg.currency, monthlyTokenLimit: pkg.monthlyTokenLimit }, monthlyTokenLimit: effectiveLimit, assignedAt: new Date(), assignedBy: req.user.id ?? req.user._id };
        await created.save();
      }
      return created;
    });

    if (!institution) {
      return res.status(409).json({ error: 'Institution already exists' });
    }

    await recordPlatformAudit(req, {
      action: 'institution.created',
      target: { type: 'institution', id: tenantId, name },
      metadata: {
        slug: institution.slug ?? null,
        maxActiveMembers: institution.limits?.maxActiveMembers ?? null,
      },
    });

    /**
     * An institution with no administrator cannot be administered, and the
     * unique tenantId means a retry would collide with the row just written.
     * Roll the institution back so the operator can simply try again.
     */
    let adminResult;
    try {
      await ensureInstitutionAdminRole(tenantId);
      adminResult = await resolveInstitutionAdminTarget({
        tenantId,
        userId: adminUserId,
        email: adminEmail,
        name: adminName,
        actor: req.user,
        context: buildAuditContext(req),
      });
    } catch (error) {
      await runAsSystem(() => db.deleteInstitutionByTenantId(tenantId)).catch((cleanupError) => {
        logger.error(
          '[platform/institutions] failed to roll back institution after admin appointment failed',
          { tenantId, cleanupError },
        );
      });
      await recordPlatformAudit(req, {
        action: 'institution.create_rolled_back',
        target: { type: 'institution', id: tenantId, name },
        metadata: { reason: error?.message ?? 'admin appointment failed' },
        outcome: 'failure',
      });
      throw error;
    }

    if (adminResult.user) {
      await recordPlatformAudit(req, {
        action: 'institution.admin_appointed',
        target: {
          type: 'user',
          id: adminResult.user.id ?? adminResult.user._id?.toString(),
          name: adminResult.user.email ?? adminName,
        },
        metadata: { tenantId, via: 'create' },
      });
    }

    return res.status(201).json({
      institution,
      ...(adminResult.user ? { user: adminResult.user } : null),
      ...(adminResult.invite ? { invite: adminResult.invite } : null),
      ...(adminResult.inviteLink ? { inviteLink: adminResult.inviteLink } : null),
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    logger.error('[platform/institutions] create failed', error);
    return res.status(500).json({ error: 'Failed to create institution' });
  }
});

router.get('/:tenantId', async (req, res) => {
  try {
    const institution = await runAsSystem(() => db.getInstitutionByTenantId(req.params.tenantId));
    if (!institution) {
      return res.status(404).json({ error: 'Institution not found' });
    }
    return res.status(200).json({ institution });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to get institution' });
  }
});

/**
 * Lists the user-facing agents and the institution groups that can receive
 * access. The sync script uses group ACLs; keeping the same shape here lets
 * platform administrators manage that ACL without changing the YAML agent
 * registration.
 */
router.get('/:tenantId/agent-access', async (req, res) => {
  const { tenantId } = req.params;
  const groupId = typeof req.query.groupId === 'string' ? req.query.groupId.trim() : '';

  try {
    const result = await runAsSystem(async () => {
      const institutionUsers = await models.User.find({ tenantId })
        .select('_id idOnTheSource')
        .lean()
        .exec();
      const memberKeys = institutionUsers.flatMap((user) =>
        [user._id?.toString(), user.idOnTheSource].filter(Boolean),
      );
      const groupFilter = memberKeys.length
        ? { $or: [{ tenantId }, { memberIds: { $in: memberKeys } }] }
        : { tenantId };

      const [agents, groups] = await Promise.all([
        models.Agent.find({
          orchestrationOnly: { $ne: true },
          $or: [{ tenantId }, { tenantId: { $exists: false } }, { tenantId: null }],
        })
          .select('_id id name description tenantId edges')
          .sort({ name: 1 })
          .lean()
          .exec(),
        models.Group.find(groupFilter)
          .select('_id name description source memberIds tenantId')
          .sort({ name: 1 })
          .lean()
          .exec(),
      ]);

      const selectedGroup = groupId ? groups.find((group) => group._id.toString() === groupId) : null;
      if (groupId && !selectedGroup) {
        throw new HttpError(404, 'Institution group not found');
      }

      const accessByAgent = selectedGroup
        ? await models.AclEntry.find({
            principalType: PrincipalType.GROUP,
            principalId: selectedGroup._id,
            resourceType: ResourceType.AGENT,
            resourceId: { $in: agents.map((agent) => agent._id) },
          })
            .select('resourceId permBits')
            .lean()
            .exec()
        : [];
      const access = new Map(
        accessByAgent.map((entry) => [entry.resourceId.toString(), (entry.permBits & PermissionBits.VIEW) !== 0]),
      );

      return {
        agents: agents.map((agent) => ({
          id: agent.id,
          name: agent.name,
          description: agent.description,
          tenantId: agent.tenantId ?? null,
          enabled: selectedGroup ? access.get(agent._id.toString()) === true : false,
        })),
        groups: groups.map((group) => ({
          id: group._id.toString(),
          name: group.name,
          description: group.description ?? '',
          source: group.source,
          memberCount: group.memberIds?.length ?? 0,
        })),
        selectedGroupId: selectedGroup?._id.toString() ?? null,
      };
    });

    return res.status(200).json(result);
  } catch (error) {
    if (error instanceof HttpError) return res.status(error.statusCode).json({ error: error.message });
    logger.error('[platform/institutions] agent access read failed', error);
    return res.status(500).json({ error: 'Failed to load agent access' });
  }
});

router.patch('/:tenantId/agent-access', async (req, res) => {
  const { tenantId } = req.params;
  const { agentId, groupId, enabled } = req.body ?? {};
  if (typeof agentId !== 'string' || !agentId.trim() || typeof groupId !== 'string' || !groupId.trim()) {
    return res.status(400).json({ error: 'agentId and groupId are required' });
  }
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be a boolean' });
  }

  try {
    const result = await runAsSystem(async () => {
      const institutionUsers = await models.User.find({ tenantId })
        .select('_id idOnTheSource')
        .lean()
        .exec();
      const memberKeys = institutionUsers.flatMap((user) =>
        [user._id?.toString(), user.idOnTheSource].filter(Boolean),
      );
      const groupFilter = memberKeys.length
        ? { $or: [{ tenantId }, { memberIds: { $in: memberKeys } }] }
        : { tenantId };
      const [agent, group] = await Promise.all([
        models.Agent.findOne({
          id: agentId.trim(),
          orchestrationOnly: { $ne: true },
          $or: [{ tenantId }, { tenantId: { $exists: false } }, { tenantId: null }],
        })
          .select('_id id name edges')
          .lean()
          .exec(),
        models.Group.findOne({ _id: groupId.trim(), ...groupFilter })
          .select('_id name tenantId')
          .lean()
          .exec(),
      ]);
      if (!agent) throw new HttpError(404, 'Agent not found or not available to this institution');
      if (!group) throw new HttpError(404, 'Institution group not found');

      const targetAgents = [agent];
      const specialistIds = (agent.edges ?? [])
        .map((edge) => edge.to)
        .filter((id) => typeof id === 'string' && id.length > 0);
      if (specialistIds.length) {
        const specialists = await models.Agent.find({ id: { $in: specialistIds } })
          .select('_id id')
          .lean()
          .exec();
        targetAgents.push(...specialists);
      }

      if (enabled) {
        const { grantPermission } = require('~/server/services/PermissionService');
        await grantPermission({
          principalType: PrincipalType.GROUP,
          principalId: group._id,
          resourceType: ResourceType.AGENT,
          resourceId: agent._id,
          accessRoleId: AccessRoleIds.AGENT_VIEWER,
          grantedBy: req.user.id ?? req.user._id,
        });
        for (const specialist of targetAgents.slice(1)) {
          await grantPermission({
            principalType: PrincipalType.GROUP,
            principalId: group._id,
            resourceType: ResourceType.REMOTE_AGENT,
            resourceId: specialist._id,
            accessRoleId: AccessRoleIds.REMOTE_AGENT_VIEWER,
            grantedBy: req.user.id ?? req.user._id,
          });
        }
      } else {
        await models.AclEntry.deleteMany({
          principalType: PrincipalType.GROUP,
          principalId: group._id,
          $or: [
            { resourceType: ResourceType.AGENT, resourceId: { $in: targetAgents.map((item) => item._id) } },
            { resourceType: ResourceType.REMOTE_AGENT, resourceId: { $in: targetAgents.slice(1).map((item) => item._id) } },
          ],
        }).exec();
      }

      return { enabled, agentId: agent.id, groupId: group._id.toString() };
    });

    await recordPlatformAudit(req, {
      action: 'institution.updated',
      severity: 'warning',
      target: { type: 'institution', id: tenantId },
      metadata: { operation: enabled ? 'agent_access_granted' : 'agent_access_revoked', agentId, groupId },
    });
    return res.status(200).json(result);
  } catch (error) {
    if (error instanceof HttpError) return res.status(error.statusCode).json({ error: error.message });
    logger.error('[platform/institutions] agent access mutation failed', error);
    return res.status(500).json({ error: 'Failed to update agent access' });
  }
});

router.post('/:tenantId/package', async (req, res) => {
  try {
    const institution = await runAsSystem(() => db.getInstitutionByTenantId(req.params.tenantId));
    if (!institution) return res.status(404).json({ error: 'Institution not found' });
    const pkg = await runAsSystem(() => models.InstitutionPackage.findOne({ id: req.body?.packageId, active: true }).lean().exec());
    if (!pkg) return res.status(400).json({ error: 'Active institution package not found' });
    const monthlyTokenLimit = Number.isInteger(req.body?.monthlyTokenLimit) && req.body.monthlyTokenLimit > 0 ? req.body.monthlyTokenLimit : pkg.monthlyTokenLimit;
    const updated = await runAsSystem(() => models.Institution.findOneAndUpdate({ tenantId: req.params.tenantId }, { $set: { packageAssignment: { packageId: pkg.id, packageSnapshot: { name: pkg.name, description: pkg.description, price: pkg.price, currency: pkg.currency, monthlyTokenLimit: pkg.monthlyTokenLimit }, monthlyTokenLimit, assignedAt: new Date(), assignedBy: req.user.id ?? req.user._id } } }, { new: true }).lean().exec());
    await recordPlatformAudit(req, { action: 'institution.updated', target: { type: 'institution', id: req.params.tenantId }, metadata: { packageId: pkg.id, monthlyTokenLimit } });
    return res.json({ institution: updated });
  } catch (error) {
    logger.error('[platform/institutions] package assignment failed', error);
    return res.status(500).json({ error: 'Failed to assign institution package' });
  }
});

router.get('/:tenantId/quota', async (req, res) => {
  try {
    return res.status(200).json(await getPolicyConsole({ tenantId: req.params.tenantId }));
  } catch (error) {
    if (error instanceof PolicyError || error?.statusCode) {
      return res.status(error.statusCode ?? 400).json({
        error: {
          code: error.code ?? error.details?.code,
          message: error.message,
          ...error.details,
        },
      });
    }
    logger.error('[platform/institutions] quota read failed', error);
    return res.status(500).json({ error: 'Failed to load quota health' });
  }
});

router.get('/:tenantId/quota/readiness', async (req, res) => {
  try {
    return res.status(200).json(await getShadowReadiness({ tenantId: req.params.tenantId }));
  } catch (error) {
    logger.error('[platform/institutions] quota readiness failed', error);
    return res.status(500).json({ error: 'Failed to build quota readiness report' });
  }
});

router.get('/:tenantId/policies', async (req, res) => {
  try {
    return res.status(200).json(
      await listUsagePolicies({
        tenantId: req.params.tenantId,
        limit: req.query.limit,
        offset: req.query.offset,
      }),
    );
  } catch (error) {
    logger.error('[platform/institutions] policy history failed', error);
    return res.status(500).json({ error: 'Failed to load policy history' });
  }
});

router.post('/:tenantId/policies/preview', async (req, res) => {
  try {
    return res
      .status(200)
      .json(await previewUsagePolicy({ tenantId: req.params.tenantId, input: req.body ?? {} }));
  } catch (error) {
    if (error instanceof PolicyError || error?.statusCode) {
      return res.status(error.statusCode ?? 400).json({
        error: {
          code: error.code ?? error.details?.code,
          message: error.message,
          ...error.details,
        },
      });
    }
    logger.error('[platform/institutions] policy preview failed', error);
    return res.status(500).json({ error: 'Failed to preview policy' });
  }
});

router.post('/:tenantId/policies', async (req, res) => {
  try {
    const before = await getPolicyConsole({ tenantId: req.params.tenantId });
    const result = await createUsagePolicy({
      tenantId: req.params.tenantId,
      expectedVersion: req.body?.expectedVersion,
      input: req.body?.policy ?? {},
      actorId: req.user?.id ?? req.user?._id,
      reason: req.body?.reason,
      acknowledgeOverage: req.body?.acknowledgeOverage,
    });
    await recordPlatformAudit(req, {
      action: 'institution.usage_policy_changed',
      target: { type: 'institution', id: req.params.tenantId },
      metadata: {
        before: before.policy,
        after: result.policy,
        policyVersion: result.policy.version,
        reason: result.policy.reason,
      },
    });
    return res.status(201).json(result);
  } catch (error) {
    if (error instanceof PolicyError || error?.statusCode) {
      return res.status(error.statusCode ?? 400).json({
        error: {
          code: error.code ?? error.details?.code,
          message: error.message,
          ...error.details,
        },
      });
    }
    logger.error('[platform/institutions] policy change failed', error);
    return res.status(500).json({ error: 'Failed to change policy' });
  }
});

router.get('/:tenantId/usage/summary', async (req, res) => {
  try {
    return res.status(200).json(
      await getUsageSummary({
        tenantId: req.params.tenantId,
        start: req.query.start,
        end: req.query.end,
      }),
    );
  } catch (error) {
    logger.error('[platform/institutions] usage summary failed', error);
    return res.status(error.statusCode ?? 500).json({ error: error.message });
  }
});

router.get('/:tenantId/usage/members', async (req, res) => {
  try {
    return res.status(200).json(
      await listUsageByMember({
        tenantId: req.params.tenantId,
        start: req.query.start,
        end: req.query.end,
        limit: req.query.limit,
        offset: req.query.offset,
        query: req.query.q,
      }),
    );
  } catch (error) {
    logger.error('[platform/institutions] member usage failed', error);
    return res.status(error.statusCode ?? 500).json({ error: error.message });
  }
});

router.get('/:tenantId/usage/models', async (req, res) => {
  try {
    return res.status(200).json(
      await listUsageByModel({
        tenantId: req.params.tenantId,
        start: req.query.start,
        end: req.query.end,
        limit: req.query.limit,
        offset: req.query.offset,
        query: req.query.q,
      }),
    );
  } catch (error) {
    logger.error('[platform/institutions] model usage failed', error);
    return res.status(error.statusCode ?? 500).json({ error: error.message });
  }
});

router.patch('/:tenantId', async (req, res) => {
  const { tenantId } = req.params;
  try {
    const before = await runAsSystem(() => db.getInstitutionByTenantId(tenantId));
    if (!before) {
      return res.status(404).json({ error: 'Institution not found' });
    }

    const updates = pickInstitutionUpdates(req.body ?? {});
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No updatable institution fields provided' });
    }

    const nextMaxActiveMembers = updates.limits?.maxActiveMembers;
    const seatLimitChanged =
      nextMaxActiveMembers !== undefined &&
      nextMaxActiveMembers !== (before.limits?.maxActiveMembers ?? null);

    if (nextMaxActiveMembers != null) {
      try {
        await assertSeatLimitChangeAllowed(tenantId, nextMaxActiveMembers);
      } catch (error) {
        if (error instanceof HttpError) {
          await recordPlatformAudit(req, {
            action: 'institution.seat_limit_rejected',
            outcome: 'denied',
            target: { type: 'institution', id: tenantId, name: before.name },
            metadata: {
              requested: nextMaxActiveMembers,
              current: before.limits?.maxActiveMembers ?? null,
              reason: error.message,
            },
          });
        }
        throw error;
      }
    }

    const institution = await runAsSystem(() => db.updateInstitutionByTenantId(tenantId, updates));
    if (!institution) {
      return res.status(404).json({ error: 'Institution not found' });
    }

    await recordPlatformAudit(req, {
      action: 'institution.updated',
      target: { type: 'institution', id: tenantId, name: institution.name },
      metadata: {
        fields: Object.keys(updates).join(','),
        beforeSlug: before.slug ?? null,
        beforeMaxActiveMembers: before.limits?.maxActiveMembers ?? null,
        afterSlug: institution.slug ?? null,
        afterMaxActiveMembers: institution.limits?.maxActiveMembers ?? null,
      },
    });

    if (seatLimitChanged) {
      await recordPlatformAudit(req, {
        action: 'institution.seat_limit_changed',
        target: { type: 'institution', id: tenantId, name: institution.name },
        metadata: {
          before: before.limits?.maxActiveMembers ?? null,
          after: nextMaxActiveMembers,
        },
      });
    }

    return res.status(200).json({ institution });
  } catch (error) {
    if (error instanceof HttpError) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    logger.error('[platform/institutions] update failed', error);
    return res.status(500).json({ error: 'Failed to update institution' });
  }
});

router.post('/:tenantId/suspend', async (req, res) => {
  const { tenantId } = req.params;
  try {
    const institution = await runAsSystem(() =>
      db.suspendInstitution(tenantId, {
        suspendedBy: req.user.id ?? req.user._id?.toString(),
      }),
    );
    if (!institution) {
      return res.status(404).json({ error: 'Institution not found' });
    }

    await recordPlatformAudit(req, {
      action: 'institution.suspended',
      severity: 'warning',
      target: { type: 'institution', id: tenantId, name: institution.name },
      metadata: { reason: typeof req.body?.reason === 'string' ? req.body.reason : undefined },
    });

    return res.status(200).json({ institution });
  } catch (error) {
    logger.error('[platform/institutions] suspend failed', error);
    return res.status(500).json({ error: 'Failed to suspend institution' });
  }
});

router.post('/:tenantId/reactivate', async (req, res) => {
  const { tenantId } = req.params;
  try {
    const institution = await runAsSystem(() => db.reactivateInstitution(tenantId));
    if (!institution) {
      return res.status(404).json({ error: 'Institution not found' });
    }

    await recordPlatformAudit(req, {
      action: 'institution.reactivated',
      target: { type: 'institution', id: tenantId, name: institution.name },
    });

    return res.status(200).json({ institution });
  } catch (error) {
    logger.error('[platform/institutions] reactivate failed', error);
    return res.status(500).json({ error: 'Failed to reactivate institution' });
  }
});

router.post('/:tenantId/admins', async (req, res) => {
  const { tenantId } = req.params;
  try {
    const { userId, email, name } = req.body ?? {};
    if (!userId && !email) {
      return res.status(400).json({ error: 'userId or email is required' });
    }

    const institution = await runAsSystem(() => db.getInstitutionByTenantId(tenantId));
    if (!institution) {
      return res.status(404).json({ error: 'Institution not found' });
    }

    const result = await resolveInstitutionAdminTarget({
      tenantId,
      userId,
      email,
      name,
      actor: req.user,
      context: buildAuditContext(req),
    });

    if (result.user) {
      await recordPlatformAudit(req, {
        action: 'institution.admin_appointed',
        target: {
          type: 'user',
          id: result.user.id ?? result.user._id?.toString(),
          name: result.user.email ?? name,
        },
        metadata: { tenantId, via: 'appoint' },
      });
    }

    return res.status(200).json({
      ...(result.user ? { user: result.user } : null),
      ...(result.invite ? { invite: result.invite } : null),
      ...(result.inviteLink ? { inviteLink: result.inviteLink } : null),
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    logger.error('[platform/institutions] appoint admin failed', error);
    return res.status(500).json({ error: 'Failed to appoint institution admin' });
  }
});

router.delete('/:tenantId/admins/:userId', async (req, res) => {
  const { tenantId, userId } = req.params;
  try {
    const institution = await runAsSystem(() => db.getInstitutionByTenantId(tenantId));
    if (!institution) {
      return res.status(404).json({ error: 'Institution not found' });
    }

    /** An institution with no administrator can only be repaired by a platform
     *  superadmin, so refuse to remove the last one. */
    const admins = await listInstitutionMembers({
      tenantId,
      limit: 2,
      offset: 0,
      status: 'active',
      role: INSTITUTION_ADMIN_ROLE,
    });
    const activeAdmins = admins?.members ?? [];
    const isLastAdmin =
      activeAdmins.length <= 1 &&
      activeAdmins.some((member) => String(member.id) === String(userId));
    if (isLastAdmin) {
      return res.status(409).json({
        error:
          'This is the only active administrator for the institution. Appoint another administrator before revoking this one.',
      });
    }

    const user = await revokeInstitutionAdmin({ tenantId, userId });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    await recordPlatformAudit(req, {
      action: 'institution.admin_revoked',
      severity: 'warning',
      target: { type: 'user', id: userId, name: user.email },
      metadata: { tenantId },
    });

    return res.status(200).json({ user });
  } catch (error) {
    logger.error('[platform/institutions] revoke admin failed', error);
    return res.status(500).json({ error: 'Failed to revoke institution admin' });
  }
});

module.exports = router;
