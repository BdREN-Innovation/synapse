const mongoose = require('mongoose');
const { getTransactionSupport, runAsSystem } = require('@librechat/data-schemas');
const models = require('~/db/models');
const {
  canonicalizeModel,
  getActivePolicy,
  getCalendarMonthRange,
  getQuotaHealth,
  getShadowReadiness,
} = require('./usageQuota');

class PolicyError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

function normalizeNullableLimit(value, label) {
  if (value == null || value === '') {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new PolicyError(400, 'INVALID_POLICY', `${label} must be a non-negative integer or null`);
  }
  return parsed;
}

function normalizePolicyInput(input, fallback) {
  const mode = input.mode ?? fallback.mode;
  if (!['shadow', 'enforce'].includes(mode)) {
    throw new PolicyError(400, 'INVALID_POLICY', 'mode must be shadow or enforce');
  }
  const timezone = String(input.timezone ?? fallback.timezone ?? 'Asia/Dhaka').trim();
  try {
    getCalendarMonthRange(timezone);
  } catch {
    throw new PolicyError(400, 'INVALID_POLICY', 'timezone must be a valid IANA timezone');
  }
  const rawModels = input.limits?.modelTokens ?? fallback.limits?.modelTokens ?? [];
  if (!Array.isArray(rawModels)) {
    throw new PolicyError(400, 'INVALID_POLICY', 'modelTokens must be an array');
  }
  const modelLimits = new Map();
  for (const entry of rawModels) {
    const modelKey = canonicalizeModel({
      provider: entry.providerKey,
      model: entry.modelKey,
    }).modelKey;
    if (!modelKey) {
      throw new PolicyError(400, 'INVALID_POLICY', 'Every model limit needs a modelKey');
    }
    modelLimits.set(modelKey, {
      modelKey,
      maxTokens: normalizeNullableLimit(entry.maxTokens, `Limit for ${modelKey}`),
    });
  }
  const thresholds = input.warningThresholds ?? fallback.warningThresholds ?? [0.8, 0.9];
  if (
    !Array.isArray(thresholds) ||
    thresholds.some((value) => typeof value !== 'number' || value <= 0 || value >= 1)
  ) {
    throw new PolicyError(400, 'INVALID_POLICY', 'Warning thresholds must be between 0 and 1');
  }
  return {
    mode,
    timezone,
    period: 'calendar_month',
    limits: {
      institutionTokens: normalizeNullableLimit(
        input.limits?.institutionTokens ?? fallback.limits?.institutionTokens,
        'Institution limit',
      ),
      memberTokens: normalizeNullableLimit(
        input.limits?.memberTokens ?? fallback.limits?.memberTokens,
        'Member limit',
      ),
      modelTokens: [...modelLimits.values()],
    },
    warningThresholds: [...new Set(thresholds)].sort(),
    inputSafetyFactor: fallback.inputSafetyFactor ?? 1.15,
    inputSafetyTokens: fallback.inputSafetyTokens ?? 256,
  };
}

function limitForBucket(policy, bucket) {
  if (bucket.scopeType === 'institution') {
    return policy.limits.institutionTokens;
  }
  if (bucket.scopeType === 'member') {
    return policy.limits.memberTokens;
  }
  return (
    policy.limits.modelTokens.find((entry) => entry.modelKey === bucket.scopeKey)?.maxTokens ?? null
  );
}

async function previewUsagePolicy({ tenantId, input }) {
  const currentPolicy = await getActivePolicy(tenantId);
  const proposedPolicy = normalizePolicyInput(input, currentPolicy);
  const range = getCalendarMonthRange(proposedPolicy.timezone);
  const buckets = await runAsSystem(() =>
    models.UsageBucket.find({ tenantId, periodStart: range.start }).lean().exec(),
  );
  const impacts = buckets.map((bucket) => {
    const limit = limitForBucket(proposedPolicy, bucket);
    const consumed = bucket.usedTokens + bucket.reservedTokens;
    return {
      scope: bucket.scopeType,
      scopeKey: bucket.scopeKey,
      used: bucket.usedTokens,
      reserved: bucket.reservedTokens,
      limit,
      remaining: limit == null ? null : Math.max(limit - consumed, 0),
      blocked: limit != null && consumed >= limit,
      overLimit: limit != null && consumed > limit,
    };
  });
  const blocked = impacts.filter((impact) => impact.blocked);
  return {
    currentVersion: currentPolicy.version,
    proposedPolicy,
    range,
    impacts,
    blocked,
    requiresOverageAcknowledgement: blocked.some((impact) => impact.overLimit),
  };
}

async function createUsagePolicy({
  tenantId,
  expectedVersion,
  input,
  actorId,
  reason,
  acknowledgeOverage,
}) {
  const preview = await previewUsagePolicy({ tenantId, input });
  if (Number(expectedVersion) !== preview.currentVersion) {
    throw new PolicyError(409, 'POLICY_VERSION_CONFLICT', 'The policy changed; reload and retry', {
      expectedVersion,
      currentVersion: preview.currentVersion,
    });
  }
  if (preview.requiresOverageAcknowledgement && acknowledgeOverage !== true) {
    throw new PolicyError(
      409,
      'POLICY_OVERAGE_ACKNOWLEDGEMENT_REQUIRED',
      'This change would immediately block usage and requires explicit acknowledgement',
      { blocked: preview.blocked },
    );
  }
  if (!String(reason || '').trim()) {
    throw new PolicyError(400, 'POLICY_REASON_REQUIRED', 'A change reason is required');
  }

  const transactionCapable = await getTransactionSupport(mongoose);
  if (preview.proposedPolicy.mode === 'enforce' && !transactionCapable) {
    throw new PolicyError(
      409,
      'QUOTA_ENFORCEMENT_REQUIRES_TRANSACTIONS',
      'Enforce mode requires MongoDB replica-set or mongos transaction support',
    );
  }
  if (preview.proposedPolicy.mode === 'enforce' && preview.currentVersion >= 1) {
    const readiness = await getShadowReadiness({ tenantId });
    if (!readiness.ready) {
      throw new PolicyError(
        409,
        'QUOTA_SHADOW_GATE_NOT_MET',
        'The 7-day/1,000-call shadow acceptance gate has not passed',
        { readiness },
      );
    }
  }

  const nextVersion = preview.currentVersion + 1;
  const session = transactionCapable ? await mongoose.startSession() : null;
  let created;
  const execute = async () => {
    const versionFilter =
      preview.currentVersion === 0
        ? {
            tenantId,
            $or: [
              { usagePolicyVersion: 0 },
              { usagePolicyVersion: null },
              { usagePolicyVersion: { $exists: false } },
            ],
          }
        : { tenantId, usagePolicyVersion: preview.currentVersion };
    const institution = await models.Institution.findOneAndUpdate(
      versionFilter,
      {
        $set: {
          usagePolicyVersion: nextVersion,
          timezone: preview.proposedPolicy.timezone,
        },
      },
      { new: true, session },
    )
      .lean()
      .exec();
    if (!institution) {
      throw new PolicyError(409, 'POLICY_VERSION_CONFLICT', 'The policy changed; reload and retry');
    }
    const docs = await models.UsagePolicy.create(
      [
        {
          tenantId,
          version: nextVersion,
          ...preview.proposedPolicy,
          effectiveAt: new Date(),
          reason: String(reason).trim(),
          createdBy: actorId,
        },
      ],
      { session },
    );
    created = docs[0].toObject();
  };
  try {
    if (session) {
      await session.withTransaction(execute);
    } else {
      await runAsSystem(execute);
    }
  } catch (error) {
    if (!session && error instanceof Error) {
      await runAsSystem(() =>
        models.Institution.updateOne(
          { tenantId, usagePolicyVersion: nextVersion },
          { $set: { usagePolicyVersion: preview.currentVersion } },
        ),
      );
    }
    throw error;
  } finally {
    await session?.endSession();
  }
  return { policy: created, preview };
}

async function listUsagePolicies({ tenantId, limit = 50, offset = 0 }) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const [policies, total] = await runAsSystem(() =>
    Promise.all([
      models.UsagePolicy.find({ tenantId })
        .sort({ version: -1 })
        .skip(safeOffset)
        .limit(safeLimit)
        .lean()
        .exec(),
      models.UsagePolicy.countDocuments({ tenantId }),
    ]),
  );
  return { policies, total, limit: safeLimit, offset: safeOffset };
}

async function getPolicyConsole({ tenantId }) {
  const [policy, health] = await Promise.all([
    getActivePolicy(tenantId),
    getQuotaHealth({ tenantId }),
  ]);
  return { policy, health };
}

module.exports = {
  PolicyError,
  createUsagePolicy,
  getPolicyConsole,
  listUsagePolicies,
  normalizePolicyInput,
  previewUsagePolicy,
};
