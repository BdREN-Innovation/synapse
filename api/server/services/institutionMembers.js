const crypto = require('crypto');
const mongoose = require('mongoose');
const { checkEmailConfig } = require('@librechat/api');
const { SystemRoles } = require('librechat-data-provider');
const {
  getRandomValues,
  getTransactionSupport,
  hashToken,
  logger,
  runAsSystem,
  tenantStorage,
  InstitutionInviteStatuses,
  InstitutionInviteSources,
  InstitutionInviteAccountScopes,
  InstitutionMembershipStatuses,
  InstitutionImportJobStatuses,
  INSTITUTION_ADMIN_ROLE,
} = require('@librechat/data-schemas');
const db = require('~/models');
const models = require('~/db/models');
const { sendEmail } = require('~/server/utils');
const { isPlatformAdminEmail } = require('./platformAdmin');
const { appointInstitutionAdmin, revokeInstitutionAdmin } = require('./tenancy');
const { getAppConfig } = require('./Config');

const INVITE_EXPIRY_MS = 1000 * 60 * 60 * 24 * 7;
const MAX_IMPORT_ROWS = 1000;
const ALLOWED_MEMBER_ROLES = new Set([SystemRoles.USER, INSTITUTION_ADMIN_ROLE]);
let transactionSupportCache = null;
let standaloneWarningLogged = false;

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
  }
}

function normalizeEmail(email) {
  return String(email || '')
    .trim()
    .toLowerCase();
}

function getCreditPackages(appConfig) {
  return appConfig?.creditPackages ?? appConfig?.config?.creditPackages ?? { currency: 'BDT', list: [] };
}

const usernameAllowedCharactersRegex = /^[a-zA-Z0-9_.@#$%&*()\p{Script=Latin}\p{Script=Common}\p{Script=Cyrillic}\p{Script=Devanagari}\p{Script=Han}\p{Script=Arabic}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u;
const usernameInjectionRegex = /('|--|\$ne|\$gt|\$lt|\$or|\{|\}|\*|;|<|>|\/|=)/i;

function normalizeUsername(username) {
  const value = String(username || '').trim();
  if (!value) return null;
  if (value.length < 2 || value.length > 80 || !usernameAllowedCharactersRegex.test(value) || usernameInjectionRegex.test(value)) {
    throw new HttpError(400, 'Invalid username');
  }
  return value.toLowerCase();
}

function normalizeRole(role) {
  return role === INSTITUTION_ADMIN_ROLE ? INSTITUTION_ADMIN_ROLE : SystemRoles.USER;
}

function toObjectId(value) {
  if (!value) {
    return null;
  }
  return typeof value === 'string' ? new mongoose.Types.ObjectId(value) : value;
}

function activeMembershipFilter() {
  return {
    $or: [
      { membershipStatus: InstitutionMembershipStatuses.ACTIVE },
      { membershipStatus: { $exists: false } },
      { membershipStatus: null },
    ],
  };
}

function visibleMembershipFilter() {
  return {
    $or: [
      { membershipStatus: InstitutionMembershipStatuses.ACTIVE },
      { membershipStatus: InstitutionMembershipStatuses.SUSPENDED },
      { membershipStatus: { $exists: false } },
      { membershipStatus: null },
    ],
  };
}

function formatDate(value) {
  return value ? new Date(value).toISOString() : undefined;
}

function actorFromUser(user) {
  return {
    type: 'user',
    id: user?.id ?? user?._id?.toString(),
    name: user?.name || user?.email || 'Unknown user',
  };
}

async function recordMemberAudit({
  tenantId,
  action,
  actor,
  target,
  metadata,
  context,
  outcome,
  severity,
}) {
  try {
    await db.recordAuditEntry({
      tenantId,
      action,
      actor,
      target,
      metadata,
      context,
      ...(outcome ? { outcome } : null),
      ...(severity ? { severity } : null),
    });
  } catch (error) {
    logger.error('[institutionMembers] failed to record audit entry', { action, tenantId, error });
  }
}

async function getInstitutionOrThrow(tenantId) {
  const institution = await runAsSystem(() =>
    models.Institution.findOne({ tenantId }).lean().exec(),
  );
  if (!institution) {
    throw new HttpError(404, 'Institution not found');
  }
  return institution;
}

async function ensureSeatStats(tenantId) {
  const institution = await getInstitutionOrThrow(tenantId);
  if (typeof institution?.stats?.activeMembers === 'number') {
    return institution;
  }

  const activeMembers = await tenantStorage.run({ tenantId }, async () =>
    models.User.countDocuments({ tenantId, ...activeMembershipFilter() }),
  );

  return await runAsSystem(() =>
    models.Institution.findOneAndUpdate(
      { tenantId },
      { $set: { 'stats.activeMembers': activeMembers } },
      { new: true },
    )
      .lean()
      .exec(),
  );
}

async function getSeatSummary(tenantId) {
  const institution = await ensureSeatStats(tenantId);
  const pendingInvites = await runAsSystem(() =>
    models.InstitutionInvite.countDocuments({
      tenantId,
      status: InstitutionInviteStatuses.PENDING,
    }),
  );

  return {
    activeMembers: institution?.stats?.activeMembers ?? 0,
    maxActiveMembers: institution?.limits?.maxActiveMembers ?? null,
    pendingInvites,
  };
}

/**
 * Refuses to hand out more invitations than there are seats to accept them.
 *
 * A pending invitation is a claim on a seat: the invitee will occupy one the
 * moment they register. Counting only active members would let an admin issue
 * invitations that are guaranteed to fail at the very last step, after the
 * invitee has already filled in the registration form.
 */
async function assertSeatsAvailable(tenantId, additionalSeats = 1) {
  const { activeMembers, maxActiveMembers, pendingInvites } = await getSeatSummary(tenantId);
  if (maxActiveMembers == null) {
    return { activeMembers, maxActiveMembers, pendingInvites, remaining: Infinity };
  }

  const claimed = activeMembers + pendingInvites;
  const remaining = Math.max(maxActiveMembers - claimed, 0);
  if (additionalSeats > remaining) {
    throw new HttpError(
      409,
      remaining === 0
        ? `Seat limit reached (${claimed} of ${maxActiveMembers} seats used, including pending invitations). Raise the seat limit or remove a member before inviting anyone else.`
        : `Only ${remaining} seat${remaining === 1 ? '' : 's'} remain (${claimed} of ${maxActiveMembers} used, including pending invitations), but ${additionalSeats} were requested.`,
    );
  }

  return { activeMembers, maxActiveMembers, pendingInvites, remaining };
}

async function assertSeatLimitChangeAllowed(tenantId, nextMaxActiveMembers) {
  if (nextMaxActiveMembers == null) {
    return;
  }

  const institution = await ensureSeatStats(tenantId);
  const activeMembers = institution?.stats?.activeMembers ?? 0;
  if (nextMaxActiveMembers < activeMembers) {
    throw new HttpError(
      409,
      `Seat limit cannot be lowered below the current active-member count (${activeMembers})`,
    );
  }
}

async function withInstitutionUserTransaction(tenantId, userId, mutator, standaloneMutator) {
  const supportsTransactions = await getTransactionSupport(mongoose, transactionSupportCache);
  transactionSupportCache = supportsTransactions;

  if (!supportsTransactions) {
    if (!standaloneWarningLogged) {
      logger.warn(
        '[institutionMembers] MongoDB transactions are unavailable; using atomic seat-counter operations with compensation',
      );
      standaloneWarningLogged = true;
    }
    return await tenantStorage.run({ tenantId }, standaloneMutator);
  }

  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await tenantStorage.run({ tenantId }, async () => {
        const institution = await models.Institution.findOne({ tenantId }).session(session);
        if (!institution) {
          throw new HttpError(404, 'Institution not found');
        }

        const user = await models.User.findOne({ _id: userId, tenantId }).session(session);
        if (!user) {
          throw new HttpError(404, 'Member not found');
        }

        return await mutator({ institution, user, session });
      });
    });
    return result;
  } finally {
    await session.endSession();
  }
}

async function reserveActiveSeat(tenantId) {
  await ensureSeatStats(tenantId);
  const institution = await runAsSystem(() =>
    models.Institution.findOneAndUpdate(
      {
        tenantId,
        $or: [
          { 'limits.maxActiveMembers': { $exists: false } },
          { 'limits.maxActiveMembers': null },
          {
            $expr: {
              $lt: [{ $ifNull: ['$stats.activeMembers', 0] }, '$limits.maxActiveMembers'],
            },
          },
        ],
      },
      { $inc: { 'stats.activeMembers': 1 } },
      { new: true },
    )
      .lean()
      .exec(),
  );

  if (institution) {
    return institution;
  }
  await getInstitutionOrThrow(tenantId);
  throw new HttpError(409, 'Seat limit reached');
}

async function releaseActiveSeat(tenantId) {
  const institution = await runAsSystem(() =>
    models.Institution.findOneAndUpdate(
      {
        tenantId,
        'stats.activeMembers': { $gt: 0 },
      },
      { $inc: { 'stats.activeMembers': -1 } },
      { new: true },
    )
      .lean()
      .exec(),
  );

  if (!institution) {
    throw new Error(`Unable to release an active seat for institution "${tenantId}"`);
  }
  return institution;
}

async function activateMemberWithoutTransaction(tenantId, userId) {
  const user = await models.User.findOne({ _id: userId, tenantId }).lean().exec();
  if (!user) {
    throw new HttpError(404, 'Member not found');
  }
  if (isActiveStatus(user.membershipStatus)) {
    return user;
  }

  await reserveActiveSeat(tenantId);
  try {
    const activated = await models.User.findOneAndUpdate(
      {
        _id: userId,
        tenantId,
        membershipStatus: user.membershipStatus,
      },
      {
        $set: {
          membershipStatus: InstitutionMembershipStatuses.ACTIVE,
          suspendedAt: null,
          suspendedBy: null,
          removedAt: null,
          removedBy: null,
        },
      },
      { new: true },
    )
      .lean()
      .exec();

    if (activated) {
      return activated;
    }

    await releaseActiveSeat(tenantId);
    const current = await models.User.findOne({ _id: userId, tenantId }).lean().exec();
    if (current && isActiveStatus(current.membershipStatus)) {
      return current;
    }
    throw new HttpError(409, 'Member state changed; please try again');
  } catch (error) {
    if (
      !(error instanceof HttpError && error.message === 'Member state changed; please try again')
    ) {
      try {
        await releaseActiveSeat(tenantId);
      } catch (compensationError) {
        logger.error(
          '[institutionMembers] failed to release a reserved seat after activation error',
          {
            tenantId,
            userId,
            compensationError,
          },
        );
      }
    }
    throw error;
  }
}

async function suspendMemberWithoutTransaction(tenantId, userId, actorId) {
  const suspendedAt = new Date();
  const user = await models.User.findOneAndUpdate(
    {
      _id: userId,
      tenantId,
      ...activeMembershipFilter(),
    },
    {
      $set: {
        membershipStatus: InstitutionMembershipStatuses.SUSPENDED,
        suspendedAt,
        suspendedBy: toObjectId(actorId),
      },
    },
    { new: false },
  )
    .lean()
    .exec();

  if (!user) {
    const current = await models.User.findOne({ _id: userId, tenantId }).lean().exec();
    if (!current) {
      throw new HttpError(404, 'Member not found');
    }
    if (current.membershipStatus === InstitutionMembershipStatuses.REMOVED) {
      throw new HttpError(409, 'Removed members cannot be suspended');
    }
    return current;
  }

  try {
    await releaseActiveSeat(tenantId);
  } catch (error) {
    await models.User.updateOne(
      {
        _id: userId,
        tenantId,
        membershipStatus: InstitutionMembershipStatuses.SUSPENDED,
        suspendedAt,
      },
      {
        $set: { membershipStatus: InstitutionMembershipStatuses.ACTIVE },
        $unset: { suspendedAt: 1, suspendedBy: 1 },
      },
    ).exec();
    throw error;
  }

  return await models.User.findOne({ _id: userId, tenantId }).lean().exec();
}

async function deleteUserAccountData(user) {
  const userId = user._id.toString();
  const deleteTasks = [
    models.Action.deleteMany({ user: user._id }).exec(),
    models.Agent.deleteMany({ author: user._id }).exec(),
    models.AgentApiKey.deleteMany({ user: user._id }).exec(),
    models.Assistant.deleteMany({ user: user._id }).exec(),
    models.Balance.deleteMany({ user: user._id }).exec(),
    models.ConversationTag.deleteMany({ user: user._id }).exec(),
    models.Conversation.deleteMany({ user: user._id }).exec(),
    models.Message.deleteMany({ user: user._id }).exec(),
    models.File.deleteMany({ user: user._id }).exec(),
    models.Key.deleteMany({ userId }).exec(),
    models.MemoryEntry.deleteMany({ userId }).exec(),
    models.PluginAuth.deleteMany({ userId }).exec(),
    models.Prompt.deleteMany({ author: user._id }).exec(),
    models.PromptGroup.deleteMany({ author: user._id }).exec(),
    models.Preset.deleteMany({ user: user._id }).exec(),
    models.Session.deleteMany({ user: user._id }).exec(),
    models.SharedLink.deleteMany({ user: user._id }).exec(),
    models.ToolCall.deleteMany({ user: user._id }).exec(),
    models.Token.deleteMany({ userId }).exec(),
    models.Transaction.deleteMany({ user: user._id }).exec(),
    models.CreditGrant.deleteMany({ user: user._id }).exec(),
    models.AclEntry.deleteMany({ principalId: user._id }).exec(),
    models.InstitutionInvite.deleteMany({
      $or: [{ email: user.email }, { acceptedUserId: user._id }],
    }).exec(),
    runAsSystem(() => db.deleteUserById(userId)),
  ];

  await Promise.all(deleteTasks);
  await models.Group.updateMany(
    { memberIds: user._id },
    { $pull: { memberIds: user._id } },
  ).exec();
}

async function removeMemberWithoutTransaction(tenantId, userId, actorId) {
  const user = await models.User.findOne({ _id: userId, tenantId }).lean().exec();
  if (!user) {
    throw new HttpError(404, 'Member not found');
  }
  if (user.role === SystemRoles.ADMIN) {
    throw new HttpError(403, 'Platform admins cannot be removed from tenant flows');
  }
  const wasActive = isActiveStatus(user.membershipStatus);
  await deleteUserAccountData(user);
  if (wasActive) {
    await releaseActiveSeat(tenantId);
  }
  return { ...user, membershipStatus: InstitutionMembershipStatuses.REMOVED };
}

async function findStandaloneUser(userId) {
  const user = await runAsSystem(() => models.User.findById(userId).lean().exec());
  if (!user) {
    return null;
  }
  if (!user.tenantId || user.tenantId === '') {
    return user;
  }
  const institution = await runAsSystem(() =>
    models.Institution.findOne({ tenantId: user.tenantId }).select('_id').lean().exec(),
  );
  return institution ? null : user;
}

async function suspendStandaloneMember({ userId, actor, context }) {
  const user = await findStandaloneUser(userId);
  if (!user) {
    throw new HttpError(404, 'Standalone user not found');
  }
  if (user.role === SystemRoles.ADMIN) {
    throw new HttpError(403, 'Platform admins cannot be suspended');
  }
  if (user.membershipStatus === InstitutionMembershipStatuses.REMOVED) {
    throw new HttpError(409, 'Removed users cannot be suspended');
  }
  if (user.membershipStatus !== InstitutionMembershipStatuses.SUSPENDED) {
    await runAsSystem(() =>
      db.updateUser(userId, {
        membershipStatus: InstitutionMembershipStatuses.SUSPENDED,
        suspendedAt: new Date(),
        suspendedBy: toObjectId(actor?.id ?? actor?._id),
      }),
    );
  }
  const result = await runAsSystem(() => models.User.findById(userId).lean().exec());
  await recordMemberAudit({
    tenantId: undefined,
    action: 'member.suspended',
    actor: actorFromUser(actor),
    target: { type: 'user', id: userId, name: user.email },
    context,
  });
  return result;
}

async function reactivateStandaloneMember({ userId, actor, context }) {
  const user = await findStandaloneUser(userId);
  if (!user) {
    throw new HttpError(404, 'Standalone user not found');
  }
  if (user.role === SystemRoles.ADMIN) {
    throw new HttpError(403, 'Platform admins cannot be reactivated');
  }
  if (user.membershipStatus === InstitutionMembershipStatuses.REMOVED) {
    throw new HttpError(409, 'Removed users cannot be reactivated');
  }
  if (user.membershipStatus === InstitutionMembershipStatuses.SUSPENDED) {
    await runAsSystem(() =>
      db.updateUser(userId, {
        membershipStatus: InstitutionMembershipStatuses.ACTIVE,
        suspendedAt: null,
        suspendedBy: null,
      }),
    );
  }
  const result = await runAsSystem(() => models.User.findById(userId).lean().exec());
  await recordMemberAudit({
    tenantId: undefined,
    action: 'member.reactivated',
    actor: actorFromUser(actor),
    target: { type: 'user', id: userId, name: user.email },
    context,
  });
  return result;
}

async function removeStandaloneMember({ userId, actor, context }) {
  const user = await findStandaloneUser(userId);
  if (!user) {
    throw new HttpError(404, 'Standalone user not found');
  }
  if (user.role === SystemRoles.ADMIN) {
    throw new HttpError(403, 'Platform admins cannot be removed');
  }
  await deleteUserAccountData(user);
  await recordMemberAudit({
    tenantId: undefined,
    action: 'member.removed',
    actor: actorFromUser(actor),
    target: { type: 'user', id: userId, name: user.email },
    context,
  });
  return { ...user, membershipStatus: InstitutionMembershipStatuses.REMOVED };
}

function isActiveStatus(status) {
  return status == null || status === InstitutionMembershipStatuses.ACTIVE;
}

function mapRequestedRole(role) {
  return normalizeRole(role);
}

function mapUserMember(user) {
  return {
    id: user._id.toString(),
    kind: 'user',
    tenantId: user.tenantId,
    name: user.name ?? '',
    username: user.username ?? null,
    email: user.email ?? '',
    emailVerified: user.emailVerified === true,
    role: mapRequestedRole(user.role),
    status: user.membershipStatus ?? InstitutionMembershipStatuses.ACTIVE,
    provider: user.provider ?? 'local',
    createdAt: formatDate(user.createdAt),
    updatedAt: formatDate(user.updatedAt),
    suspendedAt: formatDate(user.suspendedAt) ?? null,
    removedAt: formatDate(user.removedAt) ?? null,
  };
}

function mapInviteMember(invite) {
  return {
    id: invite._id.toString(),
    kind: 'invite',
    tenantId: invite.tenantId,
    name: invite.name ?? '',
    username: invite.requestedUsername ?? null,
    email: invite.email ?? '',
    role: mapRequestedRole(invite.requestedRole),
    status:
      invite.status === InstitutionInviteStatuses.EXPIRED
        ? InstitutionInviteStatuses.EXPIRED
        : 'invited',
    inviteStatus: invite.status,
    inviteSource: invite.source,
    createdAt: formatDate(invite.createdAt),
    updatedAt: formatDate(invite.updatedAt),
    lastSentAt: formatDate(invite.lastSentAt),
    expiresAt: formatDate(invite.expiresAt),
    acceptedAt: formatDate(invite.acceptedAt) ?? null,
  };
}

function sortMembersDesc(a, b) {
  return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function platformUserStatusFilter(status) {
  if (status === InstitutionMembershipStatuses.ACTIVE) {
    return activeMembershipFilter();
  }
  if (status && status !== 'invited' && status !== InstitutionInviteStatuses.EXPIRED) {
    return { membershipStatus: status };
  }
  return {};
}

function platformInviteStatusFilter(status) {
  if (status === InstitutionInviteStatuses.EXPIRED) {
    return InstitutionInviteStatuses.EXPIRED;
  }
  if (status === 'invited') {
    return InstitutionInviteStatuses.PENDING;
  }
  if (!status) {
    return {
      $in: [InstitutionInviteStatuses.PENDING, InstitutionInviteStatuses.EXPIRED],
    };
  }
  return null;
}

async function ensureNoCrossTenantConflict(email, tenantId) {
  const existing = await runAsSystem(() =>
    models.User.findOne({ email }).select('_id tenantId membershipStatus').lean().exec(),
  );
  if (existing && existing.tenantId && existing.tenantId !== tenantId) {
    throw new HttpError(409, 'This email already belongs to a different institution');
  }
  return existing;
}

async function sendInstitutionInviteEmail({ email, token, appName, name }) {
  /** DOMAIN_CLIENT is where a browser reaches the app, which in local dev is the
   *  Vite server, not the API. */
  const appUrl = (process.env.DOMAIN_CLIENT || '').replace(/\/+$/, '');
  const inviteLink = `${appUrl}/register?token=${encodeURIComponent(token)}`;

  if (!checkEmailConfig()) {
    return { inviteLink };
  }

  try {
    await sendEmail({
      email,
      subject: `You're invited to join ${appName}`,
      payload: {
        appName,
        appUrl,
        inviteLink,
        year: new Date().getFullYear(),
        name: String(name || '').trim(),
      },
      template: 'inviteUser.handlebars',
    });
  } catch (error) {
    logger.error('[institutionMembers] failed to send invitation email; returning invite link', {
      email,
      error,
    });
    return { inviteLink };
  }

  return { inviteLink: null };
}

async function createInstitutionInvite({
  tenantId,
  email,
  name,
  requestedRole,
  creditPackageId,
  invitedBy,
  source = InstitutionInviteSources.MANUAL,
  context,
}) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    throw new HttpError(400, 'Email is required');
  }

  const role = normalizeRole(requestedRole);
  if (!ALLOWED_MEMBER_ROLES.has(role)) {
    throw new HttpError(400, 'Invalid institution role');
  }

  if (creditPackageId) {
    const appConfig = await getAppConfig({ tenantId });
    if (!getCreditPackages(appConfig).list.some((item) => item.id === creditPackageId)) {
      throw new HttpError(400, 'Invalid credit package');
    }
  }

  if (await isPlatformAdminEmail(normalizedEmail)) {
    throw new HttpError(409, 'This email address cannot be invited');
  }

  await assertSeatsAvailable(tenantId, 1);

  const existingUser = await ensureNoCrossTenantConflict(normalizedEmail, tenantId);
  if (
    existingUser &&
    existingUser.tenantId === tenantId &&
    isActiveStatus(existingUser.membershipStatus)
  ) {
    throw new HttpError(409, 'An active member with this email already exists');
  }

  const existingInvite = await runAsSystem(() =>
    models.InstitutionInvite.findOne({
      tenantId,
      email: normalizedEmail,
      status: InstitutionInviteStatuses.PENDING,
    })
      .lean()
      .exec(),
  );
  if (existingInvite) {
    throw new HttpError(409, 'A pending invitation already exists for this email');
  }

  const rawToken = await getRandomValues(32);
  const tokenHash = await hashToken(rawToken);
  const appName = process.env.APP_TITLE || 'LibreChat';
  const invite = await runAsSystem(() =>
    models.InstitutionInvite.create({
      tenantId,
      email: normalizedEmail,
      name: String(name || '').trim(),
      requestedRole: role,
      creditPackageId: creditPackageId || null,
      status: InstitutionInviteStatuses.PENDING,
      tokenHash,
      invitedBy: toObjectId(invitedBy?.id ?? invitedBy?._id ?? invitedBy),
      lastSentAt: new Date(),
      expiresAt: new Date(Date.now() + INVITE_EXPIRY_MS),
      source,
    }),
  );

  const emailResult = await sendInstitutionInviteEmail({
    email: normalizedEmail,
    token: rawToken,
    appName,
    name: invite.name,
  });

  await recordMemberAudit({
    tenantId,
    action: 'member.invited',
    actor: actorFromUser(invitedBy),
    target: { type: 'institution_invite', id: invite._id, name: normalizedEmail },
    metadata: { role, source },
    context,
  });

  return { invite, ...emailResult };
}

async function createStandaloneInvite({ email, username, creditPackageId, invitedBy, context }) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) throw new HttpError(400, 'Email is required');
  if (!creditPackageId) throw new HttpError(400, 'A package is required');
  const requestedUsername = normalizeUsername(username);
  if (await isPlatformAdminEmail(normalizedEmail)) throw new HttpError(409, 'This email address cannot be invited');
  const existingUser = await runAsSystem(() => models.User.findOne({ email: normalizedEmail }).select('_id tenantId').lean().exec());
  if (existingUser) throw new HttpError(409, 'This email is already attached to an account');
  const existingInvite = await runAsSystem(() => models.InstitutionInvite.findOne({ accountScope: InstitutionInviteAccountScopes.STANDALONE, email: normalizedEmail, status: InstitutionInviteStatuses.PENDING }).lean().exec());
  if (existingInvite) throw new HttpError(409, 'A pending invitation already exists for this email');
  const appConfig = await getAppConfig({ baseOnly: true });
  const pkg = getCreditPackages(appConfig).list.find((item) => item.id === creditPackageId);
  if (!pkg) throw new HttpError(400, 'Invalid credit package');
  const rawToken = await getRandomValues(32);
  const tokenHash = await hashToken(rawToken);
  const name = requestedUsername || normalizedEmail.split('@')[0];
  const invite = await runAsSystem(() => models.InstitutionInvite.create({ accountScope: InstitutionInviteAccountScopes.STANDALONE, tenantId: null, email: normalizedEmail, name, requestedUsername, requestedRole: SystemRoles.USER, creditPackageId: pkg.id, status: InstitutionInviteStatuses.PENDING, tokenHash, invitedBy: toObjectId(invitedBy?.id ?? invitedBy?._id ?? invitedBy), lastSentAt: new Date(), expiresAt: new Date(Date.now() + INVITE_EXPIRY_MS), source: InstitutionInviteSources.MANUAL }));
  const emailResult = await sendInstitutionInviteEmail({ email: normalizedEmail, token: rawToken, appName: process.env.APP_TITLE || 'LibreChat', name: invite.name });
  await recordMemberAudit({ tenantId: undefined, action: 'member.invited', actor: actorFromUser(invitedBy), target: { type: 'standalone_invite', id: invite._id, name: normalizedEmail }, metadata: { accountScope: InstitutionInviteAccountScopes.STANDALONE, packageId: pkg.id }, context });
  return { invite, ...emailResult };
}

async function resendInstitutionInvite({ tenantId, inviteId, actor, context }) {
  const invite = await runAsSystem(() =>
    models.InstitutionInvite.findOne({
      _id: inviteId,
      tenantId,
      status: {
        $in: [InstitutionInviteStatuses.PENDING, InstitutionInviteStatuses.EXPIRED],
      },
    }).exec(),
  );
  if (!invite) {
    throw new HttpError(404, 'Pending or expired invitation not found');
  }

  const rawToken = await getRandomValues(32);
  invite.tokenHash = await hashToken(rawToken);
  invite.status = InstitutionInviteStatuses.PENDING;
  invite.lastSentAt = new Date();
  invite.expiresAt = new Date(Date.now() + INVITE_EXPIRY_MS);
  await invite.save();

  const emailResult = await sendInstitutionInviteEmail({
    email: invite.email,
    token: rawToken,
    appName: process.env.APP_TITLE || 'LibreChat',
    name: invite.name,
  });

  await recordMemberAudit({
    tenantId,
    action: 'member.invite_resent',
    actor: actorFromUser(actor),
    target: { type: 'institution_invite', id: invite._id, name: invite.email },
    context,
  });

  return { invite, ...emailResult };
}

async function resendStandaloneInvite({ inviteId, actor, context }) {
  const invite = await runAsSystem(() => models.InstitutionInvite.findOne({ _id: inviteId, accountScope: InstitutionInviteAccountScopes.STANDALONE, status: { $in: [InstitutionInviteStatuses.PENDING, InstitutionInviteStatuses.EXPIRED] } }).exec());
  if (!invite) throw new HttpError(404, 'Pending or expired invitation not found');
  const rawToken = await getRandomValues(32);
  invite.tokenHash = await hashToken(rawToken);
  invite.status = InstitutionInviteStatuses.PENDING;
  invite.lastSentAt = new Date();
  invite.expiresAt = new Date(Date.now() + INVITE_EXPIRY_MS);
  await invite.save();
  const emailResult = await sendInstitutionInviteEmail({ email: invite.email, token: rawToken, appName: process.env.APP_TITLE || 'LibreChat', name: invite.name });
  await recordMemberAudit({ tenantId: undefined, action: 'member.invite_resent', actor: actorFromUser(actor), target: { type: 'standalone_invite', id: invite._id, name: invite.email }, context });
  return { invite, ...emailResult };
}

async function revokeStandaloneInvite({ inviteId, actor, context }) {
  const invite = await runAsSystem(() => models.InstitutionInvite.findOneAndUpdate({ _id: inviteId, accountScope: InstitutionInviteAccountScopes.STANDALONE, status: InstitutionInviteStatuses.PENDING }, { $set: { status: InstitutionInviteStatuses.REVOKED, revokedAt: new Date(), revokedBy: toObjectId(actor?.id ?? actor?._id) } }, { new: true }).lean().exec());
  if (!invite) throw new HttpError(404, 'Pending invitation not found');
  await recordMemberAudit({ tenantId: undefined, action: 'member.invite_revoked', actor: actorFromUser(actor), target: { type: 'standalone_invite', id: invite._id, name: invite.email }, context });
  return invite;
}

async function revokeInstitutionInvite({ tenantId, inviteId, actor, context }) {
  const invite = await runAsSystem(() =>
    models.InstitutionInvite.findOneAndUpdate(
      {
        _id: inviteId,
        tenantId,
        status: InstitutionInviteStatuses.PENDING,
      },
      {
        $set: {
          status: InstitutionInviteStatuses.REVOKED,
          revokedAt: new Date(),
          revokedBy: toObjectId(actor?.id ?? actor?._id),
        },
      },
      { new: true },
    )
      .lean()
      .exec(),
  );

  if (!invite) {
    throw new HttpError(404, 'Pending invitation not found');
  }

  await recordMemberAudit({
    tenantId,
    action: 'member.invite_revoked',
    actor: actorFromUser(actor),
    target: { type: 'institution_invite', id: invite._id, name: invite.email },
    context,
  });

  return invite;
}

async function listInstitutionMembers({ tenantId, limit = 25, offset = 0, query, status, role }) {
  const normalizedQuery = String(query || '')
    .trim()
    .toLowerCase();

  const [users, invites, summary] = await Promise.all([
    tenantStorage.run({ tenantId }, async () =>
      models.User.find({ tenantId, ...visibleMembershipFilter() })
        .select(
          '_id tenantId name email emailVerified role provider membershipStatus createdAt updatedAt suspendedAt removedAt',
        )
        .lean()
        .exec(),
    ),
    runAsSystem(() =>
      models.InstitutionInvite.find({
        tenantId,
        status: {
          $in: [InstitutionInviteStatuses.PENDING, InstitutionInviteStatuses.EXPIRED],
        },
      })
        .select(
          '_id tenantId name email requestedRole status source createdAt updatedAt lastSentAt expiresAt acceptedAt',
        )
        .lean()
        .exec(),
    ),
    getSeatSummary(tenantId),
  ]);

  const members = [...users.map(mapUserMember), ...invites.map(mapInviteMember)]
    .filter((member) => {
      if (status && member.status !== status) {
        return false;
      }
      if (role && member.role !== role) {
        return false;
      }
      if (!normalizedQuery) {
        return true;
      }
      return (
        member.name.toLowerCase().includes(normalizedQuery) ||
        member.email.toLowerCase().includes(normalizedQuery)
      );
    })
    .sort(sortMembersDesc);

  return {
    members: members.slice(offset, offset + limit),
    total: members.length,
    limit,
    offset,
    summary,
  };
}

async function listPlatformInstitutionMembers({
  tenantId,
  accountScope = 'institution',
  limit = 25,
  offset = 0,
  query,
  status,
  role,
}) {
  if (accountScope === 'standalone') {
    const normalizedQuery = String(query || '').trim();
    const searchFilter = normalizedQuery
      ? { $or: [{ name: { $regex: escapeRegex(normalizedQuery), $options: 'i' } }, { email: { $regex: escapeRegex(normalizedQuery), $options: 'i' } }] }
      : {};
    const configuredAdmins = String(process.env.PLATFORM_SUPERADMIN_EMAILS || '').split(',').map((email) => email.trim().toLowerCase()).filter(Boolean);
    const adminRecords = models.PlatformAdmin
      ? await runAsSystem(() => models.PlatformAdmin.find({ active: true }).select('email').lean().exec())
      : [];
    const adminEmails = [...new Set([...configuredAdmins, ...adminRecords.map((admin) => admin.email).filter(Boolean)])];
    // Older accounts may have been created before institution records existed and
    // can retain a legacy tenantId. Treat those accounts as standalone when the
    // referenced institution no longer exists. This keeps the Others view useful
    // for pre-existing users without treating users belonging to a live
    // institution as standalone.
    const institutionTenantIds = await runAsSystem(() =>
      models.Institution.distinct('tenantId').exec(),
    );
    const tenantlessFilter = {
      $or: [
        { tenantId: { $exists: false } },
        { tenantId: null },
        { tenantId: '' },
        ...(institutionTenantIds.length > 0
          ? [{ tenantId: { $nin: institutionTenantIds } }]
          : []),
      ],
    };
    const statusFilter = platformUserStatusFilter(status);
    const userFilter = { $and: [tenantlessFilter, { email: { $nin: adminEmails } }, visibleMembershipFilter(), searchFilter, statusFilter, ...(status === 'invited' || status === InstitutionInviteStatuses.EXPIRED ? [{ _id: null }] : [])] };
    const inviteFilter = { accountScope: InstitutionInviteAccountScopes.STANDALONE, ...(platformInviteStatusFilter(status) ? { status: platformInviteStatusFilter(status) } : { _id: null }), ...searchFilter };
    const fetchLimit = offset + limit;
    const [users, invites, userTotal, inviteTotal] = await runAsSystem(() => Promise.all([
      models.User.find(userFilter).select('_id name username email emailVerified role provider membershipStatus createdAt updatedAt suspendedAt removedAt').sort({ createdAt: -1 }).limit(fetchLimit).lean().exec(),
      models.InstitutionInvite.find(inviteFilter).select('_id name requestedUsername email requestedRole status source accountScope createdAt updatedAt lastSentAt expiresAt acceptedAt').sort({ createdAt: -1 }).limit(fetchLimit).lean().exec(),
      models.User.countDocuments(userFilter),
      models.InstitutionInvite.countDocuments(inviteFilter),
    ]));
    const members = [...users.map((user) => ({ ...mapUserMember(user), tenantId: undefined, institutionName: 'Others', accountScope: 'standalone' })), ...invites.map((invite) => ({ ...mapInviteMember(invite), tenantId: undefined, institutionName: 'Others', accountScope: 'standalone' }))].sort(sortMembersDesc).slice(offset, offset + limit);
    return { members, total: userTotal + inviteTotal, limit, offset, summary: { activeMembers: userTotal, maxActiveMembers: null, pendingInvites: inviteTotal, institutions: 0 } };
  }
  const normalizedQuery = String(query || '').trim();
  const searchFilter = normalizedQuery
    ? {
        $or: [
          { name: { $regex: escapeRegex(normalizedQuery), $options: 'i' } },
          { email: { $regex: escapeRegex(normalizedQuery), $options: 'i' } },
        ],
      }
    : {};
  const tenantFilter = tenantId ? { tenantId } : { tenantId: { $exists: true, $ne: null } };
  const statusFilter = platformUserStatusFilter(status);
  const userFilter = {
    $and: [
      tenantFilter,
      visibleMembershipFilter(),
      searchFilter,
      statusFilter,
      ...(status === 'invited' || status === InstitutionInviteStatuses.EXPIRED
        ? [{ _id: null }]
        : []),
      ...(role ? [{ role }] : []),
    ],
  };
  const inviteStatus = platformInviteStatusFilter(status);
  const inviteFilter = {
    ...tenantFilter,
    ...(inviteStatus ? { status: inviteStatus } : { _id: null }),
    ...searchFilter,
    ...(role ? { requestedRole: role } : null),
  };
  const fetchLimit = offset + limit;

  const [users, invites, userTotal, inviteTotal, activeMembers, pendingInvites, institutions] =
    await runAsSystem(() =>
      Promise.all([
        models.User.find(userFilter)
          .select(
            '_id tenantId name email emailVerified role provider membershipStatus createdAt updatedAt suspendedAt removedAt',
          )
          .sort({ createdAt: -1 })
          .limit(fetchLimit)
          .lean()
          .exec(),
        models.InstitutionInvite.find(inviteFilter)
          .select(
            '_id tenantId name email requestedRole status source createdAt updatedAt lastSentAt expiresAt acceptedAt',
          )
          .sort({ createdAt: -1 })
          .limit(fetchLimit)
          .lean()
          .exec(),
        models.User.countDocuments(userFilter),
        models.InstitutionInvite.countDocuments(inviteFilter),
        models.User.countDocuments({
          ...tenantFilter,
          ...activeMembershipFilter(),
        }),
        models.InstitutionInvite.countDocuments({
          ...tenantFilter,
          status: InstitutionInviteStatuses.PENDING,
        }),
        models.Institution.find(tenantId ? { tenantId } : {})
          .select('tenantId name')
          .lean()
          .exec(),
      ]),
    );

  const institutionNames = new Map(
    institutions.map((institution) => [institution.tenantId, institution.name]),
  );
  const members = [...users.map(mapUserMember), ...invites.map(mapInviteMember)]
    .sort(sortMembersDesc)
    .slice(offset, offset + limit)
    .map((member) => ({
      ...member,
      institutionName: institutionNames.get(member.tenantId) ?? member.tenantId,
    }));

  return {
    members,
    total: userTotal + inviteTotal,
    limit,
    offset,
    summary: {
      activeMembers,
      maxActiveMembers: null,
      pendingInvites,
      institutions: institutions.length,
    },
  };
}

async function searchInstitutionMembers({ tenantId, query, limit = 20 }) {
  const result = await listInstitutionMembers({ tenantId, query, limit, offset: 0 });
  return result.members.slice(0, limit);
}

async function getInstitutionMemberDetail({ tenantId, id, kind }) {
  if (kind === 'invite') {
    const invite = await runAsSystem(() =>
      models.InstitutionInvite.findOne({ _id: id, tenantId }).lean().exec(),
    );
    if (!invite) {
      throw new HttpError(404, 'Invitation not found');
    }
    return mapInviteMember(invite);
  }

  const user = await tenantStorage.run({ tenantId }, async () =>
    models.User.findOne({ _id: id, tenantId }).lean().exec(),
  );
  if (!user) {
    throw new HttpError(404, 'Member not found');
  }
  return mapUserMember(user);
}

async function setInstitutionRole({ tenantId, userId, role, actor, context }) {
  const nextRole = normalizeRole(role);
  if (!ALLOWED_MEMBER_ROLES.has(nextRole)) {
    throw new HttpError(400, 'Invalid institution role');
  }

  let user;
  if (nextRole === INSTITUTION_ADMIN_ROLE) {
    user = await appointInstitutionAdmin({ tenantId, userId });
  } else {
    user = await revokeInstitutionAdmin({ tenantId, userId });
  }

  if (!user) {
    throw new HttpError(404, 'Member not found');
  }

  await recordMemberAudit({
    tenantId,
    action: 'member.role_changed',
    actor: actorFromUser(actor),
    target: { type: 'user', id: userId, name: user.email },
    metadata: { role: nextRole },
    context,
  });

  return user;
}

async function reactivateInstitutionMember({ tenantId, userId, actor, context }) {
  const result = await withInstitutionUserTransaction(
    tenantId,
    userId,
    async ({ institution, user }) => {
      if (isActiveStatus(user.membershipStatus)) {
        return user;
      }

      const maxActiveMembers = institution?.limits?.maxActiveMembers;
      const activeMembers = institution?.stats?.activeMembers ?? 0;
      if (maxActiveMembers != null && activeMembers >= maxActiveMembers) {
        throw new HttpError(409, 'Seat limit reached');
      }

      institution.stats = institution.stats || {};
      institution.stats.activeMembers = activeMembers + 1;
      user.membershipStatus = InstitutionMembershipStatuses.ACTIVE;
      user.suspendedAt = null;
      user.suspendedBy = null;
      user.removedAt = null;
      user.removedBy = null;

      await institution.save();
      await user.save();
      return user.toObject();
    },
    () => activateMemberWithoutTransaction(tenantId, userId),
  );

  await recordMemberAudit({
    tenantId,
    action: 'member.reactivated',
    actor: actorFromUser(actor),
    target: { type: 'user', id: userId, name: result.email },
    context,
  });

  return result;
}

async function suspendInstitutionMember({ tenantId, userId, actor, context }) {
  const actorId = actor?.id ?? actor?._id;
  const result = await withInstitutionUserTransaction(
    tenantId,
    userId,
    async ({ institution, user }) => {
      if (user.membershipStatus === InstitutionMembershipStatuses.REMOVED) {
        throw new HttpError(409, 'Removed members cannot be suspended');
      }

      if (!isActiveStatus(user.membershipStatus)) {
        return user;
      }

      const activeMembers = institution?.stats?.activeMembers ?? 0;
      institution.stats = institution.stats || {};
      institution.stats.activeMembers = Math.max(activeMembers - 1, 0);
      user.membershipStatus = InstitutionMembershipStatuses.SUSPENDED;
      user.suspendedAt = new Date();
      user.suspendedBy = toObjectId(actorId);
      await institution.save();
      await user.save();
      return user.toObject();
    },
    () => suspendMemberWithoutTransaction(tenantId, userId, actorId),
  );

  await recordMemberAudit({
    tenantId,
    action: 'member.suspended',
    actor: actorFromUser(actor),
    target: { type: 'user', id: userId, name: result.email },
    context,
  });

  return result;
}

async function removeInstitutionMember({ tenantId, userId, actor, context }) {
  const actorId = actor?.id ?? actor?._id;
  const result = await removeMemberWithoutTransaction(tenantId, userId, actorId);

  await recordMemberAudit({
    tenantId,
    action: 'member.removed',
    actor: actorFromUser(actor),
    target: { type: 'user', id: userId, name: result.email },
    context,
  });

  return result;
}

/**
 * Resolves an invitation from its token alone, for prefilling the registration
 * form. The token is the shared secret that was mailed to the invitee, so
 * returning the address it was sent to discloses nothing they do not have.
 * Only pending invitations resolve; nothing else is exposed.
 */
async function resolveInstitutionInviteByToken(encodedToken) {
  const token = decodeURIComponent(String(encodedToken ?? ''));
  if (!token) {
    return null;
  }

  const tokenHash = await hashToken(token);
  const invite = await runAsSystem(() => models.InstitutionInvite.findOne({ tokenHash }).exec());

  if (!invite) {
    return null;
  }

  if (
    invite.status === InstitutionInviteStatuses.PENDING &&
    invite.expiresAt &&
    invite.expiresAt.getTime() < Date.now()
  ) {
    invite.status = InstitutionInviteStatuses.EXPIRED;
    await invite.save();
  }

  return {
    email: invite.email,
    name: invite.name || '',
    ...(invite.requestedUsername ? { username: invite.requestedUsername } : null),
    status: invite.status,
  };
}

async function findInstitutionInviteByToken(encodedToken, email) {
  const token = decodeURIComponent(encodedToken);
  const tokenHash = await hashToken(token);
  const normalizedEmail = normalizeEmail(email);

  const invite = await runAsSystem(() =>
    models.InstitutionInvite.findOne({
      tokenHash,
      email: normalizedEmail,
    }).exec(),
  );

  if (!invite) {
    return null;
  }

  if (
    invite.status === InstitutionInviteStatuses.PENDING &&
    invite.expiresAt &&
    invite.expiresAt.getTime() < Date.now()
  ) {
    invite.status = InstitutionInviteStatuses.EXPIRED;
    await invite.save();
  }

  return invite;
}

async function findPendingInviteByToken(encodedToken, email) {
  const invite = await findInstitutionInviteByToken(encodedToken, email);
  return invite?.status === InstitutionInviteStatuses.PENDING ? invite : null;
}

async function completeInviteAcceptance({ inviteId, userId }) {
  const invite = await runAsSystem(() =>
    models.InstitutionInvite.findOneAndUpdate(
      {
        _id: inviteId,
        status: InstitutionInviteStatuses.PENDING,
      },
      {
        $set: {
          status: InstitutionInviteStatuses.ACCEPTED,
          acceptedAt: new Date(),
          acceptedUserId: toObjectId(userId),
        },
      },
      { new: true },
    )
      .lean()
      .exec(),
  );
  if (invite?.creditPackageId) {
    try {
      const grantPackage = async () => {
        const existingGrant = await models.CreditGrant.findOne({ inviteId: invite._id }).lean().exec();
        if (existingGrant) return;
        const appConfig = await getAppConfig(invite.tenantId ? { tenantId: invite.tenantId } : { baseOnly: true });
        const pkg = getCreditPackages(appConfig).list.find((item) => item.id === invite.creditPackageId);
        if (!pkg) throw new Error(`Invalid credit package: ${invite.creditPackageId}`);
        const result = await db.createTransaction({ user: toObjectId(userId), tokenType: 'credits', context: 'purchase', rawAmount: pkg.credits, balance: appConfig.balance, tenantId: invite.tenantId });
        if (!result) throw new Error('Balance is disabled');
        await models.CreditGrant.create({ user: toObjectId(userId), tenantId: invite.tenantId ?? null, packageId: pkg.id, credits: pkg.credits, price: pkg.price, currency: getCreditPackages(appConfig).currency, source: 'invite', inviteId: invite._id, grantedBy: null });
      };
      if (invite.tenantId) await tenantStorage.run({ tenantId: invite.tenantId }, grantPackage);
      else await grantPackage();
    } catch (error) {
      logger.error('[institutionMembers] invite credit grant failed', { inviteId, userId, error });
    }
  }
  return invite;
}

async function activateProvisionedMember({ userId, tenantId }) {
  return await withInstitutionUserTransaction(
    tenantId,
    userId,
    async ({ institution, user }) => {
      if (isActiveStatus(user.membershipStatus)) {
        return user.toObject();
      }

      const maxActiveMembers = institution?.limits?.maxActiveMembers;
      const activeMembers = institution?.stats?.activeMembers ?? 0;
      if (maxActiveMembers != null && activeMembers >= maxActiveMembers) {
        throw new HttpError(409, 'Seat limit reached');
      }

      institution.stats = institution.stats || {};
      institution.stats.activeMembers = activeMembers + 1;
      user.membershipStatus = InstitutionMembershipStatuses.ACTIVE;
      user.suspendedAt = null;
      user.suspendedBy = null;
      user.removedAt = null;
      user.removedBy = null;

      await institution.save();
      await user.save();
      return user.toObject();
    },
    () => activateMemberWithoutTransaction(tenantId, userId),
  );
}

function parseCsvLine(line) {
  const cells = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === ',' && !inQuotes) {
      cells.push(current);
      current = '';
      continue;
    }
    current += char;
  }

  cells.push(current);
  return cells.map((value) => value.trim());
}

function parseCsv(text) {
  const lines = String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .filter((line) => line.trim().length > 0);

  if (lines.length === 0) {
    throw new HttpError(400, 'CSV content is empty');
  }

  const header = parseCsvLine(lines[0]).map((column) => column.toLowerCase());
  const emailIndex = header.indexOf('email');
  const nameIndex = header.indexOf('name');
  const roleIndex = header.indexOf('role');

  if (emailIndex === -1) {
    throw new HttpError(400, 'CSV must include an email column');
  }

  return lines.slice(1).map((line, index) => {
    const row = parseCsvLine(line);
    return {
      rowNumber: index + 2,
      email: row[emailIndex] ?? '',
      name: row[nameIndex] ?? '',
      role: row[roleIndex] ?? SystemRoles.USER,
    };
  });
}

async function analyzeImportRows({ tenantId, csvText }) {
  const rows = parseCsv(csvText);
  if (rows.length > MAX_IMPORT_ROWS) {
    throw new HttpError(400, `CSV import is limited to ${MAX_IMPORT_ROWS} rows`);
  }

  const results = [];
  const seenEmails = new Set();

  for (const row of rows) {
    const normalizedEmail = normalizeEmail(row.email);
    const requestedRole = normalizeRole(row.role);

    if (!normalizedEmail) {
      results.push({
        rowNumber: row.rowNumber,
        name: row.name,
        action: 'error',
        message: 'Email is required',
      });
      continue;
    }

    if (!/^\S+@\S+\.\S+$/.test(normalizedEmail)) {
      results.push({
        rowNumber: row.rowNumber,
        email: normalizedEmail,
        name: row.name,
        requestedRole,
        action: 'error',
        message: 'Invalid email address',
      });
      continue;
    }

    if (seenEmails.has(normalizedEmail)) {
      results.push({
        rowNumber: row.rowNumber,
        email: normalizedEmail,
        name: row.name,
        requestedRole,
        action: 'error',
        message: 'Duplicate email in CSV',
      });
      continue;
    }
    seenEmails.add(normalizedEmail);

    const [existingUser, pendingInvite] = await Promise.all([
      runAsSystem(() =>
        models.User.findOne({ email: normalizedEmail })
          .select('_id tenantId membershipStatus email role')
          .lean()
          .exec(),
      ),
      runAsSystem(() =>
        models.InstitutionInvite.findOne({
          tenantId,
          email: normalizedEmail,
          status: InstitutionInviteStatuses.PENDING,
        })
          .select('_id')
          .lean()
          .exec(),
      ),
    ]);

    if (pendingInvite) {
      results.push({
        rowNumber: row.rowNumber,
        email: normalizedEmail,
        name: row.name,
        requestedRole,
        action: 'error',
        message: 'A pending invitation already exists',
      });
      continue;
    }

    if (existingUser && existingUser.tenantId && existingUser.tenantId !== tenantId) {
      results.push({
        rowNumber: row.rowNumber,
        email: normalizedEmail,
        name: row.name,
        requestedRole,
        action: 'error',
        message: 'Email already belongs to another institution',
      });
      continue;
    }

    if (existingUser && existingUser.tenantId === tenantId) {
      results.push({
        rowNumber: row.rowNumber,
        email: normalizedEmail,
        name: row.name,
        requestedRole,
        action: 'update_member',
        message: 'Existing institution member will be updated',
      });
      continue;
    }

    results.push({
      rowNumber: row.rowNumber,
      email: normalizedEmail,
      name: row.name,
      requestedRole,
      action: 'invite',
      message: 'A new invitation will be created',
    });
  }

  return results;
}

function summarizeImportResults(results) {
  return results.reduce(
    (summary, row) => {
      summary.totalRows += 1;
      if (row.action === 'invite') {
        summary.invitesCreated += 1;
      } else if (row.action === 'update_member') {
        summary.membersUpdated += 1;
      } else if (row.action === 'skip') {
        summary.skipped += 1;
      } else if (row.action === 'error') {
        summary.errors += 1;
      }
      return summary;
    },
    { totalRows: 0, invitesCreated: 0, membersUpdated: 0, skipped: 0, errors: 0 },
  );
}

async function dryRunInstitutionImport({ tenantId, csvText }) {
  const results = await analyzeImportRows({ tenantId, csvText });
  const summary = summarizeImportResults(results);
  const { activeMembers, maxActiveMembers, pendingInvites } = await getSeatSummary(tenantId);
  const remaining =
    maxActiveMembers == null
      ? null
      : Math.max(maxActiveMembers - (activeMembers + pendingInvites), 0);

  return {
    results,
    summary,
    seats: {
      activeMembers,
      maxActiveMembers,
      pendingInvites,
      remaining,
      requested: summary.invitesCreated,
      overBy: remaining == null ? 0 : Math.max(summary.invitesCreated - remaining, 0),
    },
  };
}

async function createInstitutionImportJob({ tenantId, csvText, actor, context }) {
  const idempotencyKey = crypto.createHash('sha256').update(`${tenantId}:${csvText}`).digest('hex');

  const existingJob = await runAsSystem(() =>
    models.InstitutionImportJob.findOne({ tenantId, idempotencyKey }).lean().exec(),
  );
  if (existingJob) {
    return existingJob;
  }

  const dryRun = await dryRunInstitutionImport({ tenantId, csvText });
  await assertSeatsAvailable(tenantId, dryRun.summary.invitesCreated);

  const createdJob = await runAsSystem(() =>
    models.InstitutionImportJob.create({
      tenantId,
      idempotencyKey,
      initiatedBy: toObjectId(actor?.id ?? actor?._id),
      status: InstitutionImportJobStatuses.PENDING,
      summary: dryRun.summary,
      results: dryRun.results,
    }),
  );

  await recordMemberAudit({
    tenantId,
    action: 'member.import_started',
    outcome: 'pending',
    actor: actorFromUser(actor),
    target: { type: 'institution_import_job', id: createdJob._id, name: idempotencyKey },
    metadata: { totalRows: dryRun.summary.totalRows },
    context,
  });

  const finalResults = [];
  try {
    for (const row of dryRun.results) {
      if (row.action === 'invite') {
        try {
          await createInstitutionInvite({
            tenantId,
            email: row.email,
            name: row.name,
            requestedRole: row.requestedRole,
            invitedBy: actor,
            source: InstitutionInviteSources.CSV_IMPORT,
            context,
          });
          finalResults.push(row);
        } catch (error) {
          finalResults.push({
            ...row,
            action: 'error',
            message: error?.message || 'Failed to create invitation',
          });
        }
        continue;
      }

      if (row.action === 'update_member') {
        const member = await runAsSystem(() =>
          models.User.findOne({ email: row.email, tenantId }).select('_id').lean().exec(),
        );
        if (!member) {
          finalResults.push({
            ...row,
            action: 'error',
            message: 'Member no longer exists',
          });
          continue;
        }

        try {
          await tenantStorage.run({ tenantId }, async () => {
            await models.User.findOneAndUpdate(
              { _id: member._id, tenantId },
              {
                $set: {
                  ...(row.name ? { name: row.name } : null),
                },
              },
              { new: true },
            ).exec();
          });
          if (normalizeRole(row.requestedRole) === INSTITUTION_ADMIN_ROLE) {
            await appointInstitutionAdmin({ tenantId, userId: member._id.toString() });
          } else {
            await revokeInstitutionAdmin({ tenantId, userId: member._id.toString() });
          }
          finalResults.push(row);
        } catch (error) {
          finalResults.push({
            ...row,
            action: 'error',
            message: error?.message || 'Failed to update member',
          });
        }
        continue;
      }

      finalResults.push(row);
    }
  } catch (error) {
    const failedJob = await runAsSystem(() =>
      models.InstitutionImportJob.findOneAndUpdate(
        { _id: createdJob._id },
        {
          $set: {
            status: InstitutionImportJobStatuses.FAILED,
            summary: summarizeImportResults(finalResults),
            results: finalResults,
          },
        },
        { new: true },
      )
        .lean()
        .exec(),
    );

    await recordMemberAudit({
      tenantId,
      action: 'member.import_failed',
      outcome: 'failure',
      severity: 'warning',
      actor: actorFromUser(actor),
      target: { type: 'institution_import_job', id: createdJob._id, name: idempotencyKey },
      metadata: { reason: error?.message || 'Import processing failed' },
      context,
    });

    logger.error('[institutionMembers] import job failed', { tenantId, error });
    return failedJob;
  }

  const finalSummary = summarizeImportResults(finalResults);
  const job = await runAsSystem(() =>
    models.InstitutionImportJob.findOneAndUpdate(
      { _id: createdJob._id },
      {
        $set: {
          status: InstitutionImportJobStatuses.COMPLETED,
          summary: finalSummary,
          results: finalResults,
        },
      },
      { new: true },
    )
      .lean()
      .exec(),
  );

  await recordMemberAudit({
    tenantId,
    action: 'member.import_completed',
    actor: actorFromUser(actor),
    target: { type: 'institution_import_job', id: job._id, name: idempotencyKey },
    metadata: {
      totalRows: finalSummary.totalRows,
      invitesCreated: finalSummary.invitesCreated,
      membersUpdated: finalSummary.membersUpdated,
      errors: finalSummary.errors,
    },
    context,
  });

  return job;
}

async function getInstitutionImportJob({ tenantId, jobId }) {
  const job = await runAsSystem(() =>
    models.InstitutionImportJob.findOne({ _id: jobId, tenantId }).lean().exec(),
  );
  if (!job) {
    throw new HttpError(404, 'Import job not found');
  }
  return job;
}

module.exports = {
  HttpError,
  assertSeatLimitChangeAllowed,
  assertSeatsAvailable,
  completeInviteAcceptance,
  createInstitutionImportJob,
  createInstitutionInvite,
  createStandaloneInvite,
  dryRunInstitutionImport,
  findInstitutionInviteByToken,
  findPendingInviteByToken,
  getInstitutionImportJob,
  getInstitutionMemberDetail,
  getSeatSummary,
  listInstitutionMembers,
  listPlatformInstitutionMembers,
  removeInstitutionMember,
  removeStandaloneMember,
  resolveInstitutionInviteByToken,
  reactivateInstitutionMember,
  resendInstitutionInvite,
  resendStandaloneInvite,
  revokeInstitutionInvite,
  revokeStandaloneInvite,
  searchInstitutionMembers,
  setInstitutionRole,
  suspendInstitutionMember,
  suspendStandaloneMember,
  reactivateStandaloneMember,
  activateProvisionedMember,
  InstitutionMembershipStatuses,
  INSTITUTION_ADMIN_ROLE,
  InstitutionInviteStatuses,
};
