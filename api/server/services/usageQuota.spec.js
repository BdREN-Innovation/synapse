jest.mock('@librechat/data-schemas', () => ({
  getTransactionSupport: jest.fn(),
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  runAsSystem: (fn) => fn(),
}));

jest.mock('@librechat/api', () => ({
  matchModelName: (model) => {
    if (String(model).includes('gpt-4o')) return 'gpt-4o';
    return undefined;
  },
}));

jest.mock('~/db/models', () => ({
  Institution: {},
  UsagePolicy: {},
  UsageBucket: {},
  UsageReservation: {},
}));

const {
  QuotaError,
  canonicalizeModel,
  getCalendarMonthRange,
  isEnforcementDenial,
} = require('./usageQuota');

describe('usageQuota calendar and canonicalization', () => {
  it('stores an Asia/Dhaka calendar month as UTC boundaries', () => {
    const range = getCalendarMonthRange('Asia/Dhaka', new Date('2026-07-15T12:00:00.000Z'));
    expect(range.start.toISOString()).toBe('2026-06-30T18:00:00.000Z');
    expect(range.end.toISOString()).toBe('2026-07-31T18:00:00.000Z');
  });

  it('uses the correct DST offsets on both sides of a New York month', () => {
    const march = getCalendarMonthRange('America/New_York', new Date('2026-03-15T12:00:00.000Z'));
    expect(march.start.toISOString()).toBe('2026-03-01T05:00:00.000Z');
    expect(march.end.toISOString()).toBe('2026-04-01T04:00:00.000Z');
  });

  it('canonicalizes provider-prefixed aliases to one model key', () => {
    expect(canonicalizeModel({ provider: 'OpenAI', model: 'openai/gpt-4o-2024-08-06' })).toEqual({
      providerKey: 'openai',
      providerModelId: 'gpt-4o-2024-08-06',
      modelKey: 'gpt-4o',
    });
  });

  it('returns the quota response body contract', () => {
    const error = new QuotaError({
      scope: 'member',
      limit: 100,
      used: 90,
      reserved: 10,
      remaining: 0,
      resetAt: '2026-08-01T00:00:00.000Z',
    });
    expect(error.statusCode).toBe(429);
    expect(error.body).toEqual({
      error: expect.objectContaining({
        code: 'TOKEN_QUOTA_EXCEEDED',
        scope: 'member',
        remaining: 0,
      }),
    });
  });
});

describe('isEnforcementDenial', () => {
  it('treats a capacity denial as a refusal the caller must surface', () => {
    expect(isEnforcementDenial(new QuotaError({ scope: 'member', limit: 10 }))).toBe(true);
  });

  it('treats a misconfigured enforce topology as a refusal', () => {
    const error = new QuotaError({ code: 'QUOTA_ENFORCEMENT_REQUIRES_TRANSACTIONS' });
    expect(isEnforcementDenial(error)).toBe(true);
  });

  it('treats missing institution or policy records as availability faults, not refusals', () => {
    expect(isEnforcementDenial(new QuotaError({ code: 'INSTITUTION_NOT_FOUND' }))).toBe(false);
    expect(isEnforcementDenial(new QuotaError({ code: 'USAGE_POLICY_NOT_FOUND' }))).toBe(false);
    expect(isEnforcementDenial(new QuotaError({ code: 'INVALID_INSTITUTION_TIMEZONE' }))).toBe(
      false,
    );
    expect(isEnforcementDenial(new QuotaError({ code: 'INVALID_QUOTA_CONTEXT' }))).toBe(false);
  });

  it('never treats an unrelated database error as a refusal', () => {
    expect(isEnforcementDenial(new Error('connection reset'))).toBe(false);
    expect(isEnforcementDenial(undefined)).toBe(false);
  });
});
