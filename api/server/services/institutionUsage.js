const mongoose = require('mongoose');
const { runAsSystem, tenantStorage } = require('@librechat/data-schemas');
const { getCalendarMonthRange } = require('./usageQuota');
const models = require('~/db/models');

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function parseDateBoundary(value, label) {
  if (value == null || value === '') {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new HttpError(400, `Invalid ${label} date`);
  }
  return parsed;
}

async function resolveRange(tenantId, { start, end } = {}) {
  let timezone = 'UTC';
  if (tenantId) {
    const institution = await runAsSystem(() =>
      models.Institution.findOne({ tenantId }).select('timezone').lean().exec(),
    );
    if (!institution) {
      throw new HttpError(404, 'Institution not found');
    }
    timezone = institution.timezone;
  }
  const defaults = getCalendarMonthRange(timezone);
  const startDate = parseDateBoundary(start, 'start') ?? defaults.start;
  const endDate = parseDateBoundary(end, 'end') ?? defaults.end;

  if (startDate >= endDate) {
    throw new HttpError(400, 'The start date must be earlier than the end date');
  }

  return { start: startDate, end: endDate, timezone: defaults.timezone };
}

function parsePagination({ limit, offset } = {}) {
  const parsedLimit = Number.parseInt(String(limit ?? '25'), 10);
  const parsedOffset = Number.parseInt(String(offset ?? '0'), 10);
  return {
    limit: Math.min(Math.max(Number.isNaN(parsedLimit) ? 25 : parsedLimit, 1), 100),
    offset: Math.max(Number.isNaN(parsedOffset) ? 0 : parsedOffset, 0),
  };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function csvCell(value) {
  if (value == null) {
    return '';
  }
  const normalized = String(value);
  if (/[",\n]/.test(normalized)) {
    return `"${normalized.replace(/"/g, '""')}"`;
  }
  return normalized;
}

function getTransactionModel() {
  return mongoose.models.Transaction;
}

function getBaseMatch(range) {
  return {
    createdAt: {
      $gte: range.start,
      $lt: range.end,
    },
    tokenType: { $in: ['prompt', 'completion'] },
    $or: [{ usageUnit: { $exists: false } }, { usageUnit: 'tokens' }],
  };
}

/**
 * Canonical provider for a ledger row, resolved in the pipeline.
 *
 * Rows written before provider attribution was mandatory carry no
 * `providerKey`, and older ones carry mixed casing ("openAI" vs "openai").
 * Grouping on the raw field splits one model across several rows and labels
 * half of them "unknown", so it is normalized on read rather than requiring a
 * backfill of historical usage.
 */
function providerKeyExpr() {
  const model = { $toLower: { $ifNull: ['$providerModelId', { $ifNull: ['$model', ''] }] } };
  return {
    $let: {
      vars: {
        declared: { $toLower: { $trim: { input: { $ifNull: ['$providerKey', ''] } } } },
        model,
      },
      in: {
        $switch: {
          branches: [
            { case: { $ne: ['$$declared', ''] }, then: '$$declared' },
            {
              case: {
                $regexMatch: { input: '$$model', regex: '^(gpt-|o1|o3|o4|chat-latest)' },
              },
              then: 'openai',
            },
            { case: { $regexMatch: { input: '$$model', regex: '^claude-' } }, then: 'anthropic' },
            {
              case: { $regexMatch: { input: '$$model', regex: '^(gemini|gemma)' } },
              then: 'google',
            },
            { case: { $regexMatch: { input: '$$model', regex: '^grok-' } }, then: 'xai' },
          ],
          default: 'unknown',
        },
      },
    },
  };
}

/**
 * The model as the operator recognises it. `modelKey` is a pricing bucket and
 * can be coarser than reality (gpt-5.6-luna prices as gpt-5), which reads as a
 * phantom model in a usage report.
 */
function modelIdExpr() {
  return { $ifNull: ['$providerModelId', { $ifNull: ['$model', 'unknown'] }] };
}

function getTokenProjection() {
  return {
    promptTokens: {
      $sum: {
        $cond: [{ $eq: ['$tokenType', 'prompt'] }, { $abs: { $ifNull: ['$rawAmount', 0] } }, 0],
      },
    },
    completionTokens: {
      $sum: {
        $cond: [{ $eq: ['$tokenType', 'completion'] }, { $abs: { $ifNull: ['$rawAmount', 0] } }, 0],
      },
    },
    totalCost: {
      $sum: { $abs: { $ifNull: ['$tokenValue', 0] } },
    },
    lastUsedAt: { $max: '$createdAt' },
    eventCount: { $sum: 1 },
  };
}

async function getUsageSummary({ tenantId, start, end }) {
  const range = await resolveRange(tenantId, { start, end });
  const Transaction = getTransactionModel();

  const [summary] = await tenantStorage.run({ tenantId }, async () =>
    Transaction.aggregate([
      { $match: getBaseMatch(range) },
      {
        $group: {
          _id: null,
          ...getTokenProjection(),
          members: { $addToSet: '$user' },
          models: { $addToSet: modelIdExpr() },
        },
      },
      {
        $project: {
          _id: 0,
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: { $add: ['$promptTokens', '$completionTokens'] },
          totalCost: 1,
          eventCount: 1,
          memberCount: { $size: '$members' },
          modelCount: {
            $size: {
              $filter: {
                input: '$models',
                as: 'model',
                cond: { $ne: ['$$model', null] },
              },
            },
          },
        },
      },
    ]),
  );

  return {
    range,
    summary: summary ?? {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      totalCost: 0,
      eventCount: 0,
      memberCount: 0,
      modelCount: 0,
    },
  };
}

async function listUsageByMember({ tenantId, start, end, limit, offset, query }) {
  const range = await resolveRange(tenantId, { start, end });
  const pagination = parsePagination({ limit, offset });
  const Transaction = getTransactionModel();
  const search = typeof query === 'string' && query.trim() ? query.trim() : null;
  const regex = search ? new RegExp(escapeRegex(search), 'i') : null;

  const [result] = await tenantStorage.run({ tenantId }, async () =>
    Transaction.aggregate([
      { $match: getBaseMatch(range) },
      {
        $group: {
          _id: '$user',
          ...getTokenProjection(),
        },
      },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'user',
        },
      },
      {
        $unwind: {
          path: '$user',
          preserveNullAndEmptyArrays: true,
        },
      },
      ...(regex
        ? [
            {
              $match: {
                $or: [{ 'user.name': regex }, { 'user.email': regex }, { 'user.username': regex }],
              },
            },
          ]
        : []),
      {
        $project: {
          _id: 0,
          userId: { $toString: '$_id' },
          name: { $ifNull: ['$user.name', 'Unknown member'] },
          email: '$user.email',
          role: '$user.role',
          membershipStatus: '$user.membershipStatus',
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: { $add: ['$promptTokens', '$completionTokens'] },
          totalCost: 1,
          eventCount: 1,
          lastUsedAt: 1,
        },
      },
      { $sort: { totalTokens: -1, name: 1 } },
      {
        $facet: {
          rows: [{ $skip: pagination.offset }, { $limit: pagination.limit }],
          meta: [{ $count: 'total' }],
        },
      },
    ]),
  );

  const total = result?.meta?.[0]?.total ?? 0;

  return {
    range,
    members: result?.rows ?? [],
    total,
    limit: pagination.limit,
    offset: pagination.offset,
  };
}

async function listUsageByModel({ tenantId, start, end, limit, offset, query }) {
  const range = await resolveRange(tenantId, { start, end });
  const pagination = parsePagination({ limit, offset });
  const Transaction = getTransactionModel();
  const search = typeof query === 'string' && query.trim() ? query.trim() : null;
  const regex = search ? new RegExp(escapeRegex(search), 'i') : null;

  const [result] = await tenantStorage.run({ tenantId }, async () =>
    Transaction.aggregate([
      { $match: getBaseMatch(range) },
      {
        $group: {
          _id: {
            providerKey: providerKeyExpr(),
            modelKey: modelIdExpr(),
            providerModelId: modelIdExpr(),
          },
          ...getTokenProjection(),
          memberIds: { $addToSet: '$user' },
        },
      },
      ...(regex
        ? [
            {
              $match: {
                $or: [
                  { '_id.modelKey': regex },
                  { '_id.providerKey': regex },
                  { '_id.providerModelId': regex },
                ],
              },
            },
          ]
        : []),
      {
        $project: {
          _id: 0,
          providerKey: '$_id.providerKey',
          modelKey: { $ifNull: ['$_id.modelKey', 'unknown'] },
          providerModelId: '$_id.providerModelId',
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: { $add: ['$promptTokens', '$completionTokens'] },
          totalCost: 1,
          eventCount: 1,
          lastUsedAt: 1,
          memberCount: { $size: '$memberIds' },
        },
      },
      { $sort: { totalTokens: -1, modelKey: 1 } },
      {
        $facet: {
          rows: [{ $skip: pagination.offset }, { $limit: pagination.limit }],
          meta: [{ $count: 'total' }],
        },
      },
    ]),
  );

  const total = result?.meta?.[0]?.total ?? 0;

  return {
    range,
    models: result?.rows ?? [],
    total,
    limit: pagination.limit,
    offset: pagination.offset,
  };
}

async function getUsageTimeseries({ tenantId, start, end }) {
  const range = await resolveRange(tenantId, { start, end });
  const Transaction = getTransactionModel();

  const points = await tenantStorage.run({ tenantId }, async () =>
    Transaction.aggregate([
      { $match: getBaseMatch(range) },
      {
        $group: {
          _id: {
            day: {
              $dateToString: {
                format: '%Y-%m-%d',
                date: '$createdAt',
                timezone: range.timezone,
              },
            },
          },
          ...getTokenProjection(),
        },
      },
      {
        $project: {
          _id: 0,
          day: '$_id.day',
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: { $add: ['$promptTokens', '$completionTokens'] },
          totalCost: 1,
          eventCount: 1,
        },
      },
      { $sort: { day: 1 } },
    ]),
  );

  return { range, points };
}

async function exportUsageCsv({ tenantId, start, end }) {
  const range = await resolveRange(tenantId, { start, end });
  const Transaction = getTransactionModel();

  const rows = await tenantStorage.run({ tenantId }, async () =>
    Transaction.aggregate([
      { $match: getBaseMatch(range) },
      {
        $lookup: {
          from: 'users',
          localField: 'user',
          foreignField: '_id',
          as: 'user',
        },
      },
      {
        $unwind: {
          path: '$user',
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $project: {
          _id: 0,
          createdAt: 1,
          conversationId: 1,
          messageId: 1,
          requestKey: 1,
          userId: { $toString: '$user._id' },
          memberName: '$user.name',
          memberEmail: '$user.email',
          memberRole: '$user.role',
          membershipStatus: '$user.membershipStatus',
          providerKey: providerKeyExpr(),
          modelKey: modelIdExpr(),
          providerModelId: modelIdExpr(),
          tokenType: 1,
          promptTokens: {
            $cond: [{ $eq: ['$tokenType', 'prompt'] }, { $abs: { $ifNull: ['$rawAmount', 0] } }, 0],
          },
          completionTokens: {
            $cond: [
              { $eq: ['$tokenType', 'completion'] },
              { $abs: { $ifNull: ['$rawAmount', 0] } },
              0,
            ],
          },
          rawAmount: '$rawAmount',
          tokenValue: '$tokenValue',
          usageKind: { $ifNull: ['$usageKind', '$context'] },
        },
      },
      { $sort: { createdAt: 1, requestKey: 1, tokenType: 1 } },
    ]),
  );

  const lines = [
    [
      'createdAt',
      'conversationId',
      'messageId',
      'requestKey',
      'userId',
      'memberName',
      'memberEmail',
      'memberRole',
      'membershipStatus',
      'providerKey',
      'modelKey',
      'providerModelId',
      'tokenType',
      'promptTokens',
      'completionTokens',
      'rawAmount',
      'tokenValue',
      'usageKind',
    ].join(','),
    ...rows.map((row) =>
      [
        row.createdAt?.toISOString?.() ?? row.createdAt,
        row.conversationId,
        row.messageId,
        row.requestKey,
        row.userId,
        row.memberName,
        row.memberEmail,
        row.memberRole,
        row.membershipStatus,
        row.providerKey,
        row.modelKey,
        row.providerModelId,
        row.tokenType,
        row.promptTokens,
        row.completionTokens,
        row.rawAmount,
        row.tokenValue,
        row.usageKind,
      ]
        .map(csvCell)
        .join(','),
    ),
  ];

  return {
    range,
    csv: `${lines.join('\n')}\n`,
  };
}

async function getMemberUsageSummary({ tenantId, userId, start, end }) {
  const range = await resolveRange(tenantId, { start, end });
  const Transaction = getTransactionModel();
  const objectId = mongoose.Types.ObjectId.isValid(userId)
    ? new mongoose.Types.ObjectId(userId)
    : userId;
  const aggregate = () =>
    Promise.all([
      Transaction.aggregate([
        { $match: { ...getBaseMatch(range), user: objectId } },
        { $group: { _id: null, ...getTokenProjection() } },
        {
          $project: {
            _id: 0,
            promptTokens: 1,
            completionTokens: 1,
            totalTokens: { $add: ['$promptTokens', '$completionTokens'] },
            totalCost: 1,
            eventCount: 1,
            lastUsedAt: 1,
          },
        },
      ]),
      Transaction.aggregate([
        { $match: { ...getBaseMatch(range), user: objectId } },
        {
          $group: {
            _id: {
              providerKey: { $ifNull: ['$providerKey', 'unknown'] },
              modelKey: { $ifNull: ['$modelKey', '$model'] },
            },
            ...getTokenProjection(),
          },
        },
        {
          $project: {
            _id: 0,
            providerKey: '$_id.providerKey',
            modelKey: '$_id.modelKey',
            promptTokens: 1,
            completionTokens: 1,
            totalTokens: { $add: ['$promptTokens', '$completionTokens'] },
            totalCost: 1,
            eventCount: 1,
            lastUsedAt: 1,
          },
        },
        { $sort: { totalTokens: -1 } },
      ]),
    ]);
  const [summary, modelsUsed] = tenantId
    ? await tenantStorage.run({ tenantId }, aggregate)
    : await runAsSystem(aggregate);

  return {
    range,
    summary: summary[0] ?? {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      totalCost: 0,
      eventCount: 0,
      lastUsedAt: null,
    },
    models: modelsUsed,
  };
}

module.exports = {
  HttpError,
  exportUsageCsv,
  getMemberUsageSummary,
  getUsageSummary,
  getUsageTimeseries,
  listUsageByMember,
  listUsageByModel,
};
