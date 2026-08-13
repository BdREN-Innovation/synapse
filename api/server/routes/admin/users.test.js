const mockListInstitutionMembers = jest.fn();
const mockCreateInstitutionInvite = jest.fn();
const mockReactivateInstitutionMember = jest.fn();

class mockHttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (_req, _res, next) => next(),
}));

jest.mock('~/server/middleware/roles/capabilities', () => ({
  requireCapability: () => (_req, _res, next) => next(),
}));

jest.mock('~/server/services/institutionMembers', () => ({
  HttpError: mockHttpError,
  createInstitutionImportJob: jest.fn(),
  createInstitutionInvite: (...args) => mockCreateInstitutionInvite(...args),
  dryRunInstitutionImport: jest.fn(),
  getInstitutionImportJob: jest.fn(),
  getInstitutionMemberDetail: jest.fn(),
  getSeatSummary: jest.fn(),
  listInstitutionMembers: (...args) => mockListInstitutionMembers(...args),
  reactivateInstitutionMember: (...args) => mockReactivateInstitutionMember(...args),
  removeInstitutionMember: jest.fn(),
  resendInstitutionInvite: jest.fn(),
  revokeInstitutionInvite: jest.fn(),
  searchInstitutionMembers: jest.fn(),
  setInstitutionRole: jest.fn(),
  suspendInstitutionMember: jest.fn(),
}));

function getRouter() {
  const router = require('./users');
  return router;
}

function getRouteHandlers(router, path, method) {
  const globalHandlers = router.stack.filter((layer) => !layer.route).map((layer) => layer.handle);
  const routeLayer = router.stack.find(
    (layer) => layer.route?.path === path && layer.route.methods?.[method],
  );
  if (!routeLayer) {
    throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
  }
  const routeHandlers = routeLayer.route.stack.map((layer) => layer.handle);
  return [...globalHandlers, ...routeHandlers];
}

async function invokeRoute({
  path,
  method,
  user = { id: 'user-1', email: 'admin@example.com', tenantId: 'tenant-a' },
  params = {},
  query = {},
  body = {},
}) {
  const router = getRouter();
  const handlers = getRouteHandlers(router, path, method);
  const req = {
    method: method.toUpperCase(),
    params,
    query,
    body,
    user,
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

describe('admin users route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('lists institution members with tenant-scoped filters', async () => {
    mockListInstitutionMembers.mockResolvedValue({
      members: [{ id: 'member-1', kind: 'user', name: 'Ada', email: 'ada@example.com' }],
      total: 1,
      limit: 25,
      offset: 0,
      summary: { activeMembers: 1, maxActiveMembers: 3, pendingInvites: 0 },
    });

    const res = await invokeRoute({
      path: '/',
      method: 'get',
      query: { q: 'ada', status: 'active', role: 'USER', limit: '25', offset: '0' },
    });

    expect(mockListInstitutionMembers).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      limit: 25,
      offset: 0,
      query: 'ada',
      status: 'active',
      role: 'USER',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.summary.activeMembers).toBe(1);
  });

  it('creates an institution invite and returns inviteLink when email is not configured', async () => {
    mockCreateInstitutionInvite.mockResolvedValue({
      invite: { _id: 'invite-1', email: 'new@example.com' },
      inviteLink: 'http://client/register?token=abc',
    });

    const res = await invokeRoute({
      path: '/invite',
      method: 'post',
      body: { name: 'New User', email: 'new@example.com', role: 'USER' },
    });

    expect(mockCreateInstitutionInvite).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-a',
        email: 'new@example.com',
        name: 'New User',
        requestedRole: 'USER',
      }),
    );
    expect(res.statusCode).toBe(201);
    expect(res.body.inviteLink).toBe('http://client/register?token=abc');
  });

  it('surfaces seat-limit conflicts on reactivation', async () => {
    mockReactivateInstitutionMember.mockRejectedValue(
      new mockHttpError(409, 'Seat limit reached'),
    );

    const res = await invokeRoute({
      path: '/:id/reactivate',
      method: 'post',
      params: { id: 'member-1' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: 'Seat limit reached' });
  });

  it('rejects callers without tenant context', async () => {
    const res = await invokeRoute({
      path: '/',
      method: 'get',
      user: { id: 'user-1', email: 'admin@example.com' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('Institution admin access requires a tenant context');
    expect(mockListInstitutionMembers).not.toHaveBeenCalled();
  });
});
