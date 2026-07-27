const mongoose = require('mongoose');
const { getTransactionSupport, runAsSystem } = require('@librechat/data-schemas');
const { checkEmailConfig, matchModelName } = require('@librechat/api');
const models = require('~/db/models');
const { sendEmail } = require('~/server/utils');

const DEFAULT_TIMEZONE = 'Asia/Dhaka';
const DEFAULT_RESERVATION_TTL_MS = 15 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
let transactionSupportCache = null;

class QuotaError extends Error {
  constructor(details) {
    super('Token quota exceeded');
    this.name = 'QuotaError';
    this.statusCode = 429;
    this.details = {
      code: 'TOKEN_QUOTA_EXCEEDED',
      ...details,
    };
    this.body = { error: this.details };
  }
}

/**
 * Codes that must reach the caller as a refusal. Everything else raised by the
 * quota engine is an availability problem: chat must keep working, because a
 * shadow-mode institution has not opted into having requests blocked at all.
 */
const FAIL_CLOSED_QUOTA_CODES = new Set([
  'TOKEN_QUOTA_EXCEEDED',
  'QUOTA_ENFORCEMENT_REQUIRES_TRANSACTIONS',
]);

function isEnforcementDenial(error) {
  return error instanceof QuotaError && FAIL_CLOSED_QUOTA_CODES.has(error.details?.code);
}

function normalizeProviderKey(provider) {
  return String(provider || 'unknown')
    .trim()
    .toLowerCase();
}

function canonicalizeModel({ provider, model }) {
  const providerKey = normalizeProviderKey(provider);
  const rawModel = String(model || '').trim();
  const lowerModel = rawModel.toLowerCase();
  const prefix = `${providerKey}/`;
  const providerModelId = lowerModel.startsWith(prefix) ? rawModel.slice(prefix.length) : rawModel;
  const modelKey =
    matchModelName(providerModelId) || matchModelName(rawModel) || providerModelId.toLowerCase();
  return {
    providerKey,
    providerModelId,
    modelKey,
  };
}

function zonedParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  return Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );
}

function zonedDateTimeToUtc({ year, month, day, hour = 0, minute = 0, second = 0 }, timeZone) {
  let candidate = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = zonedParts(candidate, timeZone);
    const represented = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    const desired = Date.UTC(year, month - 1, day, hour, minute, second);
    const correction = desired - represented;
    if (correction === 0) {
      break;
    }
    candidate = new Date(candidate.getTime() + correction);
  }
  return candidate;
}

function getCalendarMonthRange(timeZone = DEFAULT_TIMEZONE, now = new Date()) {
  let parts;
  try {
    parts = zonedParts(now, timeZone);
  } catch {
    throw new QuotaError({
      code: 'INVALID_INSTITUTION_TIMEZONE',
      scope: 'institution',
      timezone: timeZone,
    });
  }
  const nextMonth = parts.month === 12 ? 1 : parts.month + 1;
  const nextYear = parts.month === 12 ? parts.year + 1 : parts.year;
  return {
    timezone: timeZone,
    start: zonedDateTimeToUtc({ year: parts.year, month: parts.month, day: 1 }, timeZone),
    end: zonedDateTimeToUtc({ year: nextYear, month: nextMonth, day: 1 }, timeZone),
  };
}

async function supportsTransactions() {
  const supported = await getTransactionSupport(mongoose, transactionSupportCache);
  transactionSupportCache = supported;
  return supported;
}

async function getActivePolicy(tenantId) {
  const institution = await runAsSystem(() =>
    models.Institution.findOne({ tenantId }).lean().exec(),
  );
  if (!institution) {
    throw new QuotaError({
      code: 'INSTITUTION_NOT_FOUND',
      scope: 'institution',
      tenantId,
    });
  }

  const version = institution.usagePolicyVersion ?? 0;
  if (version < 1) {
    return {
      tenantId,
      version: 0,
      mode: 'shadow',
      timezone: institution.timezone || DEFAULT_TIMEZONE,
      period: 'calendar_month',
      limits: {
        institutionTokens: null,
        memberTokens: null,
        modelTokens: [],
      },
      warningThresholds: [0.8, 0.9],
      inputSafetyFactor: 1.15,
      inputSafetyTokens: 256,
      effectiveAt: institution.createdAt || new Date(0),
    };
  }

  const policy = await runAsSystem(() =>
    models.UsagePolicy.findOne({ tenantId, version }).lean().exec(),
  );
  if (!policy) {
    throw new QuotaError({
      code: 'USAGE_POLICY_NOT_FOUND',
      scope: 'institution',
      tenantId,
      policyVersion: version,
    });
  }
  return policy;
}

function getModelLimit(policy, modelKey) {
  return (
    policy.limits?.modelTokens?.find((entry) => entry.modelKey === modelKey)?.maxTokens ?? null
  );
}

function buildScopes({ tenantId, userId, modelKey, policy }) {
  return [
    {
      scopeType: 'institution',
      scopeKey: tenantId,
      limit: policy.limits?.institutionTokens ?? null,
    },
    {
      scopeType: 'member',
      scopeKey: String(userId),
      limit: policy.limits?.memberTokens ?? null,
    },
    {
      scopeType: 'model',
      scopeKey: modelKey,
      limit: getModelLimit(policy, modelKey),
    },
  ];
}

async function loadBucket({ tenantId, range, scope, policyVersion, session }) {
  const query = {
    tenantId,
    periodStart: range.start,
    scopeType: scope.scopeType,
    scopeKey: scope.scopeKey,
  };
  await models.UsageBucket.updateOne(
    query,
    {
      $setOnInsert: {
        ...query,
        periodEnd: range.end,
        policyVersion,
        usedTokens: 0,
        reservedTokens: 0,
      },
    },
    { upsert: true, session },
  ).exec();
  return query;
}

async function reserveBucket({ tenantId, range, scope, policyVersion, tokens, enforce, session }) {
  const query = await loadBucket({ tenantId, range, scope, policyVersion, session });
  const capacityFilter =
    enforce && scope.limit != null
      ? {
          $expr: {
            $lte: [
              {
                $add: [
                  { $ifNull: ['$usedTokens', 0] },
                  { $ifNull: ['$reservedTokens', 0] },
                  tokens,
                ],
              },
              scope.limit,
            ],
          },
        }
      : {};
  const bucket = await models.UsageBucket.findOneAndUpdate(
    { ...query, ...capacityFilter },
    {
      $inc: { reservedTokens: tokens },
      $set: { policyVersion, periodEnd: range.end },
    },
    { new: true, session },
  )
    .lean()
    .exec();

  if (bucket) {
    return {
      bucket,
      wouldDeny: scope.limit != null && bucket.usedTokens + bucket.reservedTokens > scope.limit,
    };
  }

  const current = await models.UsageBucket.findOne(query).session(session).lean().exec();
  const used = current?.usedTokens ?? 0;
  const reserved = current?.reservedTokens ?? 0;
  throw new QuotaError({
    scope: scope.scopeType,
    modelKey: scope.scopeType === 'model' ? scope.scopeKey : undefined,
    limit: scope.limit,
    used,
    reserved,
    remaining: Math.max((scope.limit ?? 0) - used - reserved, 0),
    resetAt: range.end.toISOString(),
  });
}

function conservativeInputTokens(policy, estimatedInputTokens) {
  return Math.ceil(
    Math.max(estimatedInputTokens, 0) * (policy.inputSafetyFactor ?? 1.15) +
      (policy.inputSafetyTokens ?? 256),
  );
}

async function reserveUsage({
  tenantId,
  userId,
  provider,
  model,
  reservationKey,
  estimatedInputTokens,
  requestedOutputTokens,
  metadata,
}) {
  if (!tenantId || !userId || !reservationKey) {
    throw new QuotaError({
      code: 'INVALID_QUOTA_CONTEXT',
      scope: 'institution',
    });
  }

  const canonical = canonicalizeModel({ provider, model });
  const policy = await getActivePolicy(tenantId);
  const range = getCalendarMonthRange(policy.timezone);
  const existing = await runAsSystem(() =>
    models.UsageReservation.findOne({ tenantId, reservationKey }).lean().exec(),
  );
  if (existing) {
    const enforcing = policy.mode === 'enforce';
    return {
      reservation: existing,
      policy,
      range,
      canonical,
      outputTokenCap: enforcing ? existing.outputTokenCap : null,
      outputCapped:
        enforcing &&
        existing.outputTokenCap < (existing.metadata?.requestedOutputTokens ?? Infinity),
      idempotentReplay: true,
    };
  }

  const transactionCapable = await supportsTransactions();
  if (policy.mode === 'enforce' && !transactionCapable) {
    throw new QuotaError({
      code: 'QUOTA_ENFORCEMENT_REQUIRES_TRANSACTIONS',
      scope: 'institution',
      tenantId,
    });
  }

  const inputReservation = conservativeInputTokens(policy, estimatedInputTokens);
  const requestedOutput = Math.max(
    Number.isFinite(requestedOutputTokens) ? requestedOutputTokens : DEFAULT_MAX_OUTPUT_TOKENS,
    0,
  );
  const scopes = buildScopes({ tenantId, userId, modelKey: canonical.modelKey, policy });
  const finiteRemaining = [];
  for (const scope of scopes) {
    if (scope.limit == null) {
      continue;
    }
    const bucket = await runAsSystem(() =>
      models.UsageBucket.findOne({
        tenantId,
        periodStart: range.start,
        scopeType: scope.scopeType,
        scopeKey: scope.scopeKey,
      })
        .lean()
        .exec(),
    );
    finiteRemaining.push(
      Math.max(scope.limit - (bucket?.usedTokens ?? 0) - (bucket?.reservedTokens ?? 0), 0),
    );
  }
  const smallestRemaining =
    finiteRemaining.length > 0 ? Math.min(...finiteRemaining) : Number.POSITIVE_INFINITY;
  const proposedOutputCap = Math.max(
    Math.min(requestedOutput, smallestRemaining - inputReservation),
    0,
  );
  const enforcing = policy.mode === 'enforce';
  const outputTokenCap = enforcing ? proposedOutputCap : requestedOutput;
  const reservedTokens = inputReservation + outputTokenCap;

  if (enforcing && outputTokenCap < 1) {
    const limitingScope =
      scopes.find((scope) => {
        if (scope.limit == null) {
          return false;
        }
        return scope.limit <= inputReservation;
      }) ?? scopes.find((scope) => scope.limit != null);
    throw new QuotaError({
      scope: limitingScope?.scopeType ?? 'institution',
      modelKey: limitingScope?.scopeType === 'model' ? canonical.modelKey : undefined,
      limit: limitingScope?.limit ?? 0,
      used: Math.max((limitingScope?.limit ?? 0) - smallestRemaining, 0),
      reserved: 0,
      remaining: Math.max(smallestRemaining, 0),
      resetAt: range.end.toISOString(),
    });
  }

  const session = transactionCapable ? await mongoose.startSession() : null;
  let result;
  let concurrentReplay = false;
  const execute = async () => {
    const reservation = await models.UsageReservation.create(
      [
        {
          tenantId,
          reservationKey,
          userId,
          providerKey: canonical.providerKey,
          modelKey: canonical.modelKey,
          policyVersion: Math.max(policy.version, 1),
          periodStart: range.start,
          periodEnd: range.end,
          estimatedInputTokens: inputReservation,
          outputTokenCap,
          reservedTokens,
          status: 'reserved',
          expiresAt: new Date(Date.now() + DEFAULT_RESERVATION_TTL_MS),
          metadata: {
            ...metadata,
            requestedOutputTokens: requestedOutput,
            proposedOutputCap,
            shadowWouldDeny:
              policy.mode === 'shadow' &&
              finiteRemaining.some((remaining) => remaining < inputReservation + requestedOutput),
          },
        },
      ],
      { session },
    );
    result = reservation[0].toObject();
    for (const scope of scopes) {
      await reserveBucket({
        tenantId,
        range,
        scope,
        policyVersion: Math.max(policy.version, 1),
        tokens: reservedTokens,
        enforce: policy.mode === 'enforce',
        session,
      });
    }
  };

  try {
    if (session) {
      await session.withTransaction(execute);
    } else {
      await runAsSystem(execute);
    }
  } catch (error) {
    if (error?.code === 11000) {
      const replay = await runAsSystem(() =>
        models.UsageReservation.findOne({ tenantId, reservationKey }).lean().exec(),
      );
      if (replay) {
        result = replay;
        concurrentReplay = true;
      } else {
        throw error;
      }
    } else {
      throw error;
    }
  } finally {
    if (session) {
      await session.endSession();
    }
  }

  return {
    reservation: result,
    policy,
    range,
    canonical,
    outputTokenCap: enforcing ? result.outputTokenCap : null,
    outputCapped: enforcing && result.outputTokenCap < requestedOutput,
    proposedOutputCap,
    idempotentReplay: concurrentReplay,
  };
}

function reservationScopes(reservation) {
  return [
    { scopeType: 'institution', scopeKey: reservation.tenantId },
    { scopeType: 'member', scopeKey: reservation.userId.toString() },
    { scopeType: 'model', scopeKey: reservation.modelKey },
  ];
}

async function transitionReservation({ tenantId, reservationKey, actualTokens, status }) {
  const transactionCapable = await supportsTransactions();
  const session = transactionCapable ? await mongoose.startSession() : null;
  let updated;
  const execute = async () => {
    /** Claim the state transition before touching buckets. This makes settle,
     * release, retry, and abort handlers idempotent even when they race. In a
     * transaction, any later bucket failure rolls the claim back with it. */
    const reservation = await models.UsageReservation.findOneAndUpdate(
      { tenantId, reservationKey, status: 'reserved' },
      {
        $set: {
          status,
          ...(status === 'settled'
            ? { actualTokens: Math.max(actualTokens ?? 0, 0), settledAt: new Date() }
            : { releasedAt: new Date() }),
        },
      },
      { new: true, session },
    )
      .lean()
      .exec();
    if (!reservation) {
      updated = await models.UsageReservation.findOne({ tenantId, reservationKey })
        .session(session)
        .lean()
        .exec();
      return;
    }

    for (const scope of reservationScopes(reservation)) {
      const increment =
        status === 'settled'
          ? {
              usedTokens: Math.max(actualTokens ?? 0, 0),
              reservedTokens: -reservation.reservedTokens,
            }
          : { reservedTokens: -reservation.reservedTokens };
      await models.UsageBucket.updateOne(
        {
          tenantId,
          periodStart: reservation.periodStart,
          scopeType: scope.scopeType,
          scopeKey: scope.scopeKey,
          reservedTokens: { $gte: reservation.reservedTokens },
        },
        { $inc: increment },
        { session },
      ).exec();
    }
    updated = reservation;
  };
  try {
    if (session) {
      await session.withTransaction(execute);
    } else {
      await runAsSystem(execute);
    }
  } finally {
    if (session) {
      await session.endSession();
    }
  }
  return updated;
}

async function settleUsage({ tenantId, reservationKey, usage }) {
  const actualTokens =
    Math.max(usage?.inputTokens ?? 0, 0) +
    Math.max(usage?.cacheWriteTokens ?? 0, 0) +
    Math.max(usage?.cacheReadTokens ?? 0, 0) +
    Math.max(usage?.outputTokens ?? 0, 0);
  const reservation = await transitionReservation({
    tenantId,
    reservationKey,
    actualTokens,
    status: 'settled',
  });
  if (reservation?.status === 'settled') {
    await emitUsageWarnings(reservation);
  }
  return reservation;
}

async function releaseUsage({ tenantId, reservationKey }) {
  return await transitionReservation({ tenantId, reservationKey, status: 'released' });
}

async function reconcileExpiredReservations({ limit = 100 } = {}) {
  const stale = await runAsSystem(() =>
    models.UsageReservation.find({
      status: 'reserved',
      expiresAt: { $lte: new Date() },
    })
      .sort({ expiresAt: 1 })
      .limit(Math.min(Math.max(limit, 1), 1000))
      .lean()
      .exec(),
  );
  let reconciled = 0;
  for (const reservation of stale) {
    const released = await transitionReservation({
      tenantId: reservation.tenantId,
      reservationKey: reservation.reservationKey,
      status: 'expired',
    });
    if (released?.status === 'expired') {
      reconciled += 1;
    }
  }
  return { inspected: stale.length, reconciled };
}

/**
 * Idempotently repairs bucket totals for periods with no in-flight
 * reservations. Active periods are skipped so reconciliation can never race a
 * live reserve/settle transaction and overwrite capacity.
 */
async function reconcileQuotaState({ limit = 100 } = {}) {
  const expiry = await reconcileExpiredReservations({ limit });
  const periods = await runAsSystem(() =>
    models.UsageReservation.aggregate([
      {
        $group: {
          _id: {
            tenantId: '$tenantId',
            periodStart: '$periodStart',
            periodEnd: '$periodEnd',
            policyVersion: '$policyVersion',
          },
          active: { $sum: { $cond: [{ $eq: ['$status', 'reserved'] }, 1, 0] } },
        },
      },
      { $match: { active: 0 } },
      { $sort: { '_id.periodStart': -1 } },
      { $limit: Math.min(Math.max(limit, 1), 1000) },
    ]),
  );
  let repairedPeriods = 0;
  for (const period of periods) {
    const key = period._id;
    const reservations = await runAsSystem(() =>
      models.UsageReservation.find({
        tenantId: key.tenantId,
        periodStart: key.periodStart,
      })
        .lean()
        .exec(),
    );
    const totals = new Map();
    for (const reservation of reservations) {
      for (const scope of reservationScopes(reservation)) {
        const mapKey = `${scope.scopeType}:${scope.scopeKey}`;
        const current = totals.get(mapKey) ?? {
          scopeType: scope.scopeType,
          scopeKey: scope.scopeKey,
          usedTokens: 0,
        };
        if (reservation.status === 'settled') {
          current.usedTokens += reservation.actualTokens ?? 0;
        }
        totals.set(mapKey, current);
      }
    }
    if (totals.size === 0) {
      continue;
    }
    await runAsSystem(() =>
      models.UsageBucket.bulkWrite(
        [...totals.values()].map((total) => ({
          updateOne: {
            filter: {
              tenantId: key.tenantId,
              periodStart: key.periodStart,
              scopeType: total.scopeType,
              scopeKey: total.scopeKey,
            },
            update: {
              $set: {
                periodEnd: key.periodEnd,
                policyVersion: key.policyVersion,
                usedTokens: total.usedTokens,
                reservedTokens: 0,
              },
            },
            upsert: true,
          },
        })),
      ),
    );
    repairedPeriods += 1;
  }
  return { ...expiry, inspectedPeriods: periods.length, repairedPeriods };
}

async function getQuotaHealth({ tenantId, now = new Date() }) {
  const policy = await getActivePolicy(tenantId);
  const range = getCalendarMonthRange(policy.timezone, now);
  const buckets = await runAsSystem(() =>
    models.UsageBucket.find({ tenantId, periodStart: range.start }).lean().exec(),
  );
  const warnings = await runAsSystem(() =>
    models.UsageWarning.find({ tenantId, periodStart: range.start })
      .sort({ createdAt: -1 })
      .lean()
      .exec(),
  );
  return {
    policy,
    range,
    warnings,
    buckets: buckets.map((bucket) => {
      const scope = buildScopes({
        tenantId,
        userId: bucket.scopeType === 'member' ? bucket.scopeKey : '',
        modelKey: bucket.scopeType === 'model' ? bucket.scopeKey : '',
        policy,
      }).find(
        (candidate) =>
          candidate.scopeType === bucket.scopeType && candidate.scopeKey === bucket.scopeKey,
      );
      const limit = scope?.limit ?? null;
      const consumed = bucket.usedTokens + bucket.reservedTokens;
      return {
        ...bucket,
        limit,
        remaining: limit == null ? null : Math.max(limit - consumed, 0),
        utilization: limit == null || limit === 0 ? null : consumed / limit,
        blocked: limit != null && consumed >= limit,
      };
    }),
  };
}

async function emailUsageWarning(warning) {
  if (!checkEmailConfig()) {
    return;
  }
  const [institution, admins] = await runAsSystem(() =>
    Promise.all([
      models.Institution.findOne({ tenantId: warning.tenantId }).select('name').lean().exec(),
      models.User.find({
        tenantId: warning.tenantId,
        role: 'INSTITUTION_ADMIN',
        membershipStatus: 'active',
      })
        .select('name email')
        .lean()
        .exec(),
    ]),
  );
  if (admins.length === 0) {
    return;
  }
  await Promise.all(
    admins.map((admin) =>
      sendEmail({
        email: admin.email,
        subject: `${institution?.name ?? warning.tenantId} token usage warning`,
        payload: {
          name: admin.name || admin.email,
          institutionName: institution?.name ?? warning.tenantId,
          threshold: String(Math.round(warning.threshold * 100)),
          scope: warning.scopeType,
          scopeKey: warning.scopeKey,
          used: String(warning.usedTokens),
          reserved: String(warning.reservedTokens),
          limit: String(warning.limit),
          resetAt: warning.periodEnd.toISOString(),
        },
        template: 'usageWarning.handlebars',
        throwError: false,
      }),
    ),
  );
  await runAsSystem(() =>
    models.UsageWarning.updateOne({ _id: warning._id }, { $set: { emailedAt: new Date() } }),
  );
}

async function emitUsageWarnings(reservation) {
  const policy = await getActivePolicy(reservation.tenantId);
  const thresholds = policy.warningThresholds ?? [0.8, 0.9];
  const scopes = reservationScopes(reservation);
  for (const scope of scopes) {
    const limit = buildScopes({
      tenantId: reservation.tenantId,
      userId: reservation.userId,
      modelKey: reservation.modelKey,
      policy,
    }).find((candidate) => candidate.scopeType === scope.scopeType)?.limit;
    if (limit == null || limit <= 0) {
      continue;
    }
    const bucket = await runAsSystem(() =>
      models.UsageBucket.findOne({
        tenantId: reservation.tenantId,
        periodStart: reservation.periodStart,
        scopeType: scope.scopeType,
        scopeKey: scope.scopeKey,
      })
        .lean()
        .exec(),
    );
    if (!bucket) {
      continue;
    }
    const utilization = (bucket.usedTokens + bucket.reservedTokens) / limit;
    for (const threshold of thresholds) {
      if (utilization < threshold) {
        continue;
      }
      const result = await runAsSystem(() =>
        models.UsageWarning.updateOne(
          {
            tenantId: reservation.tenantId,
            periodStart: reservation.periodStart,
            scopeType: scope.scopeType,
            scopeKey: scope.scopeKey,
            threshold,
          },
          {
            $setOnInsert: {
              periodEnd: reservation.periodEnd,
              utilization,
              usedTokens: bucket.usedTokens,
              reservedTokens: bucket.reservedTokens,
              limit,
            },
          },
          { upsert: true },
        ),
      );
      if (result.upsertedCount === 1) {
        const warning = await runAsSystem(() =>
          models.UsageWarning.findOne({
            tenantId: reservation.tenantId,
            periodStart: reservation.periodStart,
            scopeType: scope.scopeType,
            scopeKey: scope.scopeKey,
            threshold,
          })
            .lean()
            .exec(),
        );
        if (warning) {
          await emailUsageWarning(warning);
        }
      }
    }
  }
}

async function assertEnforcementTopology() {
  const enforcingPolicy = await runAsSystem(() => models.UsagePolicy.exists({ mode: 'enforce' }));
  if (!enforcingPolicy) {
    return { enforcing: false, transactionCapable: await supportsTransactions() };
  }
  const transactionCapable = await supportsTransactions();
  if (!transactionCapable) {
    throw new Error(
      'Quota enforce mode requires MongoDB replica-set or mongos transaction support',
    );
  }
  return { enforcing: true, transactionCapable };
}

async function getShadowReadiness({ tenantId, minimumDays = 7, minimumCalls = 1000 }) {
  const now = new Date();
  const cutoff = new Date(now.getTime() - minimumDays * 24 * 60 * 60 * 1000);
  const [reservations, unattributedEvents, duplicateGroups, ledgerCallGroups] = await runAsSystem(
    () =>
      Promise.all([
        models.UsageReservation.find({ tenantId, createdAt: { $gte: cutoff } })
          .lean()
          .exec(),
        mongoose.models.Transaction.countDocuments({
          tenantId,
          createdAt: { $gte: cutoff },
          $or: [
            { requestKey: { $exists: false } },
            { providerKey: { $exists: false } },
            { modelKey: { $exists: false } },
            { user: { $exists: false } },
          ],
        }),
        mongoose.models.Transaction.aggregate([
          { $match: { tenantId, createdAt: { $gte: cutoff }, requestKey: { $type: 'string' } } },
          {
            $group: {
              _id: { requestKey: '$requestKey', tokenType: '$tokenType', valueKey: '$valueKey' },
              count: { $sum: 1 },
            },
          },
          { $match: { count: { $gt: 1 } } },
          { $count: 'groups' },
        ]),
        mongoose.models.Transaction.aggregate([
          {
            $match: {
              tenantId,
              createdAt: { $gte: cutoff },
              requestKey: { $type: 'string' },
            },
          },
          { $group: { _id: '$requestKey' } },
          { $count: 'calls' },
        ]),
      ]),
  );
  const settled = reservations.filter((item) => item.status === 'settled');
  const stale = reservations.filter(
    (item) => item.status === 'expired' || (item.status === 'reserved' && item.expiresAt <= now),
  );
  const underestimated = settled.filter((item) => (item.actualTokens ?? 0) > item.reservedTokens);
  const totalActual = settled.reduce((sum, item) => sum + (item.actualTokens ?? 0), 0);
  const totalUnderestimate = settled.reduce(
    (sum, item) => sum + Math.max((item.actualTokens ?? 0) - item.reservedTokens, 0),
    0,
  );
  const observedDays =
    reservations.length === 0
      ? 0
      : (now.getTime() -
          Math.min(...reservations.map((item) => new Date(item.createdAt).getTime()))) /
        (24 * 60 * 60 * 1000);
  const staleRate = reservations.length === 0 ? 0 : stale.length / reservations.length;
  const underestimateRate = settled.length === 0 ? 0 : underestimated.length / settled.length;
  const estimationOverageRate = totalActual === 0 ? 0 : totalUnderestimate / totalActual;
  const ledgerCalls = ledgerCallGroups[0]?.calls ?? 0;
  const reservationCoverageRate =
    ledgerCalls === 0 ? 0 : Math.min(reservations.length / ledgerCalls, 1);
  const metrics = {
    observedDays,
    attributableCalls: reservations.length,
    settledCalls: settled.length,
    unattributedEvents,
    duplicateGroups: duplicateGroups[0]?.groups ?? 0,
    staleReservations: stale.length,
    staleRate,
    underestimatedCalls: underestimated.length,
    underestimateRate,
    estimationOverageRate,
    ledgerCalls,
    uncoveredLedgerCalls: Math.max(ledgerCalls - reservations.length, 0),
    reservationCoverageRate,
  };
  return {
    tenantId,
    generatedAt: now,
    requirements: {
      minimumDays,
      minimumCalls,
      maximumStaleRate: 0.001,
      maximumUnderestimateRate: 0.001,
      maximumEstimationOverageRate: 0.005,
      minimumReservationCoverageRate: 1,
    },
    metrics,
    ready:
      observedDays >= minimumDays &&
      reservations.length >= minimumCalls &&
      unattributedEvents === 0 &&
      (duplicateGroups[0]?.groups ?? 0) === 0 &&
      staleRate < 0.001 &&
      underestimateRate <= 0.001 &&
      estimationOverageRate < 0.005 &&
      reservationCoverageRate === 1,
  };
}

module.exports = {
  DEFAULT_TIMEZONE,
  QuotaError,
  assertEnforcementTopology,
  canonicalizeModel,
  getActivePolicy,
  getCalendarMonthRange,
  getQuotaHealth,
  getShadowReadiness,
  isEnforcementDenial,
  reconcileExpiredReservations,
  reconcileQuotaState,
  releaseUsage,
  reserveUsage,
  settleUsage,
};
