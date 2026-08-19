const mockCreateInstitutionInvite = jest.fn();
const mockAppointInstitutionAdmin = jest.fn();
const mockRevokeInstitutionAdmin = jest.fn();
const mockAssertSeatLimitChangeAllowed = jest.fn();
const mockFindUser = jest.fn();
const mockGetInstitution = jest.fn();
const mockCreateInstitution = jest.fn();
const mockUpdateInstitution = jest.fn();
const mockSuspendInstitution = jest.fn();
const mockReactivateInstitution = jest.fn();
const mockRecordAuditEntry = jest.fn();

class MockHttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

jest.mock('@librechat/data-schemas', () => ({
  runAsSystem: (fn) => fn(),
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  INSTITUTION_ADMIN_ROLE: 'INSTITUTION_ADMIN',
}));

/** The route reaches for concrete Mongoose models for its usage/agent views.
 *  Stubbing the module keeps `createModels` (mocked away above) from running
 *  and keeps these route tests free of a live database. */
jest.mock('~/db/models', () => ({
  Institution: { findOneAndUpdate: jest.fn() },
  InstitutionPackage: { findOne: jest.fn() },
  User: { find: jest.fn() },
  Agent: { find: jest.fn(), findOne: jest.fn() },
  Group: { find: jest.fn(), findOne: jest.fn() },
  AclEntry: { find: jest.fn() },
}));

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (_req, _res, next) => next(),
}));

jest.mock('~/server/middleware/platformAdmin', () => (_req, _res, next) => next());

jest.mock('~/server/services/tenancy', () => ({
  appointInstitutionAdmin: (...args) => mockAppointInstitutionAdmin(...args),
  ensureInstitutionAdminRole: jest.fn(),
  revokeInstitutionAdmin: (...args) => mockRevokeInstitutionAdmin(...args),
}));

jest.mock('~/server/services/institutionMembers', () => ({
  assertSeatLimitChangeAllowed: (...args) => mockAssertSeatLimitChangeAllowed(...args),
  createInstitutionInvite: (...args) => mockCreateInstitutionInvite(...args),
  HttpError: MockHttpError,
}));

jest.mock('~/server/services/usagePolicy', () => ({
  PolicyError: class PolicyError extends Error {},
  createUsagePolicy: jest.fn(),
  getPolicyConsole: jest.fn(),
  listUsagePolicies: jest.fn(),
  previewUsagePolicy: jest.fn(),
}));

jest.mock('~/server/services/institutionUsage', () => ({
  getUsageSummary: jest.fn(),
  listUsageByMember: jest.fn(),
  listUsageByModel: jest.fn(),
}));

jest.mock('~/server/services/usageQuota', () => ({
  getShadowReadiness: jest.fn(),
}));

jest.mock('~/models', () => ({
  findUser: (...args) => mockFindUser(...args),
  getInstitutionByTenantId: (...args) => mockGetInstitution(...args),
  createInstitution: (...args) => mockCreateInstitution(...args),
  updateInstitutionByTenantId: (...args) => mockUpdateInstitution(...args),
  suspendInstitution: (...args) => mockSuspendInstitution(...args),
  reactivateInstitution: (...args) => mockReactivateInstitution(...args),
  recordAuditEntry: (...args) => mockRecordAuditEntry(...args),
  listInstitutions: jest.fn(),
  countInstitutions: jest.fn(),
}));

function getRouteHandlers(router, path, method) {
  const globalHandlers = router.stack.filter((layer) => !layer.route).map((layer) => layer.handle);
  const routeLayer = router.stack.find(
    (layer) => layer.route?.path === path && layer.route.methods?.[method],
  );
  if (!routeLayer) {
    throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
  }
  return [...globalHandlers, ...routeLayer.route.stack.map((layer) => layer.handle)];
}

async function invokeRoute({ path, method, params = {}, body = {} }) {
  const router = require('./institutions');
  const handlers = getRouteHandlers(router, path, method);
  const req = {
    method: method.toUpperCase(),
    params,
    body,
    user: { id: 'platform-admin-1', email: 'platform@example.com' },
    headers: {},
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
  };

  return await new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        resolve({ statusCode: this.statusCode, body: payload });
        return this;
      },
    };
    let index = 0;
    const next = (error) => {
      if (error) {
        reject(error);
        return;
      }
      const handler = handlers[index++];
      if (!handler) {
        resolve({ statusCode: res.statusCode, body: undefined });
        return;
      }
      try {
        const result = handler(req, res, next);
        if (result && typeof result.then === 'function') {
          result.catch(reject);
        }
      } catch (err) {
        reject(err);
      }
    };
    next();
  });
}

function auditActions() {
  return mockRecordAuditEntry.mock.calls.map(([input]) => input.action);
}

describe('platform institutions route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRecordAuditEntry.mockResolvedValue({ id: 'audit-1' });
    mockAssertSeatLimitChangeAllowed.mockResolvedValue(undefined);
  });

  it('requires a bootstrap admin when creating an institution', async () => {
    const response = await invokeRoute({
      path: '/',
      method: 'post',
      body: { tenantId: 'tenant-a', name: 'Tenant A' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body.error).toMatch(/initial institution admin/i);
  });

  it('invites a tenant-less existing identity instead of trying to appoint it directly', async () => {
    mockGetInstitution.mockResolvedValue({ tenantId: 'tenant-a', name: 'Tenant A' });
    mockFindUser.mockResolvedValue({
      _id: 'existing-user-id',
      email: 'admin@example.com',
      tenantId: null,
    });
    mockCreateInstitutionInvite.mockResolvedValue({
      invite: {
        _id: 'invite-id',
        email: 'admin@example.com',
        requestedRole: 'INSTITUTION_ADMIN',
      },
      inviteLink: 'http://client/register?token=abc',
    });

    const response = await invokeRoute({
      path: '/:tenantId/admins',
      method: 'post',
      params: { tenantId: 'tenant-a' },
      body: { email: 'admin@example.com', name: 'Tenant Admin' },
    });

    expect(mockAppointInstitutionAdmin).not.toHaveBeenCalled();
    expect(mockCreateInstitutionInvite).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-a',
        email: 'admin@example.com',
        requestedRole: 'INSTITUTION_ADMIN',
      }),
    );
    expect(response.statusCode).toBe(200);
    expect(response.body.inviteLink).toBe('http://client/register?token=abc');
  });

  it('audits institution creation (P1-1)', async () => {
    mockGetInstitution.mockResolvedValue(null);
    mockFindUser.mockResolvedValue(null);
    mockCreateInstitution.mockResolvedValue({
      tenantId: 'tenant-a',
      name: 'Tenant A',
      slug: 'tenant-a',
      limits: { maxActiveMembers: 50 },
    });
    mockCreateInstitutionInvite.mockResolvedValue({ invite: { _id: 'i1' }, inviteLink: null });

    const response = await invokeRoute({
      path: '/',
      method: 'post',
      body: { tenantId: 'tenant-a', name: 'Tenant A', adminEmail: 'admin@example.com' },
    });

    expect(response.statusCode).toBe(201);
    expect(auditActions()).toContain('institution.created');
    const createdCall = mockRecordAuditEntry.mock.calls.find(
      ([input]) => input.action === 'institution.created',
    );
    expect(createdCall[0].actor).toEqual(
      expect.objectContaining({ type: 'user', id: 'platform-admin-1' }),
    );
    expect(createdCall[0].target).toEqual(
      expect.objectContaining({ type: 'institution', id: 'tenant-a' }),
    );
    expect(createdCall[1]).toEqual({ failClosed: true });
  });

  it('only forwards allowlisted fields on PATCH and rejects control-plane fields (P1-2)', async () => {
    mockGetInstitution.mockResolvedValue({
      tenantId: 'tenant-a',
      name: 'Old Name',
      slug: 'old',
      limits: { maxActiveMembers: 10 },
    });
    mockUpdateInstitution.mockResolvedValue({
      tenantId: 'tenant-a',
      name: 'New Name',
      slug: 'old',
      limits: { maxActiveMembers: 10 },
    });

    const response = await invokeRoute({
      path: '/:tenantId',
      method: 'patch',
      params: { tenantId: 'tenant-a' },
      body: {
        name: 'New Name',
        status: 'suspended',
        stats: { activeMembers: 9999 },
        createdBy: 'attacker',
        tenantId: 'tenant-b',
      },
    });

    expect(response.statusCode).toBe(200);
    const [, forwardedUpdates] = mockUpdateInstitution.mock.calls[0];
    expect(forwardedUpdates).toEqual({ name: 'New Name' });
    expect(forwardedUpdates).not.toHaveProperty('status');
    expect(forwardedUpdates).not.toHaveProperty('stats');
    expect(forwardedUpdates).not.toHaveProperty('createdBy');
    expect(forwardedUpdates).not.toHaveProperty('tenantId');
    expect(auditActions()).toContain('institution.updated');
  });

  it('audits a seat-limit change on PATCH (P1-1)', async () => {
    mockGetInstitution.mockResolvedValue({
      tenantId: 'tenant-a',
      name: 'Tenant A',
      limits: { maxActiveMembers: 10 },
    });
    mockUpdateInstitution.mockResolvedValue({
      tenantId: 'tenant-a',
      name: 'Tenant A',
      limits: { maxActiveMembers: 25 },
    });

    await invokeRoute({
      path: '/:tenantId',
      method: 'patch',
      params: { tenantId: 'tenant-a' },
      body: { limits: { maxActiveMembers: 25 } },
    });

    expect(mockAssertSeatLimitChangeAllowed).toHaveBeenCalledWith('tenant-a', 25);
    expect(auditActions()).toEqual(
      expect.arrayContaining(['institution.updated', 'institution.seat_limit_changed']),
    );
  });

  it('audits a rejected seat-limit change with a denied outcome (P1-1)', async () => {
    mockGetInstitution.mockResolvedValue({
      tenantId: 'tenant-a',
      name: 'Tenant A',
      limits: { maxActiveMembers: 100 },
    });
    mockAssertSeatLimitChangeAllowed.mockRejectedValue(new MockHttpError(409, 'below current'));

    const response = await invokeRoute({
      path: '/:tenantId',
      method: 'patch',
      params: { tenantId: 'tenant-a' },
      body: { limits: { maxActiveMembers: 1 } },
    });

    expect(response.statusCode).toBe(409);
    const rejected = mockRecordAuditEntry.mock.calls.find(
      ([input]) => input.action === 'institution.seat_limit_rejected',
    );
    expect(rejected).toBeTruthy();
    expect(rejected[0].outcome).toBe('denied');
    expect(mockUpdateInstitution).not.toHaveBeenCalled();
  });

  it('audits institution suspension and reactivation (P1-1)', async () => {
    mockSuspendInstitution.mockResolvedValue({ tenantId: 'tenant-a', name: 'Tenant A' });
    mockReactivateInstitution.mockResolvedValue({ tenantId: 'tenant-a', name: 'Tenant A' });

    await invokeRoute({
      path: '/:tenantId/suspend',
      method: 'post',
      params: { tenantId: 'tenant-a' },
    });
    await invokeRoute({
      path: '/:tenantId/reactivate',
      method: 'post',
      params: { tenantId: 'tenant-a' },
    });

    expect(auditActions()).toEqual(
      expect.arrayContaining(['institution.suspended', 'institution.reactivated']),
    );
  });
});
