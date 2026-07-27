const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

jest.mock('~/server/utils', () => ({
  sendEmail: jest.fn(),
}));

describe('usageQuota reservations (replica set)', () => {
  let replSet;
  let models;
  let quota;
  let usagePolicy;
  const tenantId = 'quota-integration';
  const userId = new mongoose.Types.ObjectId();

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replSet.getUri());
    models = require('~/db/models');
    quota = require('./usageQuota');
    usagePolicy = require('./usagePolicy');
    await Promise.all([
      models.Institution.syncIndexes(),
      models.UsagePolicy.syncIndexes(),
      models.UsageBucket.syncIndexes(),
      models.UsageReservation.syncIndexes(),
    ]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await replSet?.stop();
  });

  beforeEach(async () => {
    await Promise.all([
      models.Institution.deleteMany({}),
      models.UsagePolicy.deleteMany({}),
      models.UsageBucket.deleteMany({}),
      models.UsageReservation.deleteMany({}),
    ]);
    await models.Institution.create({
      tenantId,
      name: 'Quota Integration',
      timezone: 'Asia/Dhaka',
      usagePolicyVersion: 1,
    });
    await models.UsagePolicy.create({
      tenantId,
      version: 1,
      mode: 'enforce',
      timezone: 'Asia/Dhaka',
      limits: {
        institutionTokens: 700,
        memberTokens: null,
        modelTokens: [{ modelKey: 'gpt-4o', maxTokens: 700 }],
      },
      inputSafetyFactor: 1,
      inputSafetyTokens: 0,
      effectiveAt: new Date(),
      reason: 'integration test',
    });
  });

  it('allows only one concurrent final-capacity reservation', async () => {
    const request = (reservationKey) =>
      quota.reserveUsage({
        tenantId,
        userId,
        provider: 'openai',
        model: 'gpt-4o',
        reservationKey,
        estimatedInputTokens: 100,
        requestedOutputTokens: 400,
      });

    const results = await Promise.allSettled([request('call-a'), request('call-b')]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected.reason).toEqual(
      expect.objectContaining({
        statusCode: 429,
        body: { error: expect.objectContaining({ code: 'TOKEN_QUOTA_EXCEEDED' }) },
      }),
    );
  });

  it('replays a reservation idempotently and settles it only once', async () => {
    const input = {
      tenantId,
      userId,
      provider: 'openai',
      model: 'openai/gpt-4o',
      reservationKey: 'same-call',
      estimatedInputTokens: 100,
      requestedOutputTokens: 200,
    };
    const first = await quota.reserveUsage(input);
    const replay = await quota.reserveUsage(input);
    expect(replay.idempotentReplay).toBe(true);
    expect(String(replay.reservation._id)).toBe(String(first.reservation._id));

    await Promise.all([
      quota.settleUsage({
        tenantId,
        reservationKey: input.reservationKey,
        usage: { inputTokens: 100, outputTokens: 50 },
      }),
      quota.settleUsage({
        tenantId,
        reservationKey: input.reservationKey,
        usage: { inputTokens: 100, outputTokens: 50 },
      }),
    ]);

    const bucket = await models.UsageBucket.findOne({
      tenantId,
      scopeType: 'institution',
      scopeKey: tenantId,
    }).lean();
    expect(bucket.usedTokens).toBe(150);
    expect(bucket.reservedTokens).toBe(0);
  });

  it('requires explicit acknowledgement when a lower version blocks current usage', async () => {
    const range = quota.getCalendarMonthRange('Asia/Dhaka');
    await models.UsageBucket.create({
      tenantId,
      periodStart: range.start,
      periodEnd: range.end,
      scopeType: 'institution',
      scopeKey: tenantId,
      policyVersion: 1,
      usedTokens: 600,
      reservedTokens: 0,
    });
    const input = {
      mode: 'shadow',
      timezone: 'Asia/Dhaka',
      limits: {
        institutionTokens: 500,
        memberTokens: null,
        modelTokens: [],
      },
      warningThresholds: [0.8, 0.9],
    };

    await expect(
      usagePolicy.createUsagePolicy({
        tenantId,
        expectedVersion: 1,
        input,
        actorId: userId,
        reason: 'Lower pilot allocation',
        acknowledgeOverage: false,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'POLICY_OVERAGE_ACKNOWLEDGEMENT_REQUIRED' }));

    const result = await usagePolicy.createUsagePolicy({
      tenantId,
      expectedVersion: 1,
      input,
      actorId: userId,
      reason: 'Lower pilot allocation',
      acknowledgeOverage: true,
    });
    expect(result.policy.version).toBe(2);
    expect(result.policy.limits.institutionTokens).toBe(500);
    expect((await models.Institution.findOne({ tenantId }).lean()).usagePolicyVersion).toBe(2);
  });

  describe('shadow mode', () => {
    beforeEach(async () => {
      await models.UsagePolicy.deleteMany({ tenantId });
      await models.UsagePolicy.create({
        tenantId,
        version: 1,
        mode: 'shadow',
        timezone: 'Asia/Dhaka',
        limits: {
          institutionTokens: 700,
          memberTokens: null,
          modelTokens: [{ modelKey: 'gpt-4o', maxTokens: 700 }],
        },
        inputSafetyFactor: 1,
        inputSafetyTokens: 0,
        effectiveAt: new Date(),
        reason: 'shadow integration test',
      });
    });

    it('never caps output, even when the request exceeds every limit', async () => {
      const result = await quota.reserveUsage({
        tenantId,
        userId,
        provider: 'openai',
        model: 'gpt-4o',
        reservationKey: 'shadow-uncapped',
        estimatedInputTokens: 5000,
        requestedOutputTokens: 100000,
      });

      expect(result.outputTokenCap).toBeNull();
      expect(result.outputCapped).toBe(false);
    });

    it('records observed usage without capping when no output limit was requested', async () => {
      const result = await quota.reserveUsage({
        tenantId,
        userId,
        provider: 'openai',
        model: 'gpt-4o',
        reservationKey: 'shadow-default',
        estimatedInputTokens: 10,
      });

      expect(result.outputTokenCap).toBeNull();
      expect(result.reservation.reservedTokens).toBeGreaterThan(0);
    });

    it('keeps the cap absent on an idempotent replay', async () => {
      const input = {
        tenantId,
        userId,
        provider: 'openai',
        model: 'gpt-4o',
        reservationKey: 'shadow-replay',
        estimatedInputTokens: 10,
        requestedOutputTokens: 100000,
      };
      await quota.reserveUsage(input);
      const replay = await quota.reserveUsage(input);

      expect(replay.idempotentReplay).toBe(true);
      expect(replay.outputTokenCap).toBeNull();
    });
  });
});
