const mockListPlatformInstitutionMembers = jest.fn();
const mockResendInstitutionInvite = jest.fn();
const mockResendUserVerificationEmail = jest.fn();
const mockFindUser = jest.fn();

class MockHttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

jest.mock('@librechat/data-schemas', () => ({
  runAsSystem: (callback) => callback(),
}));

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (_req, _res, next) => next(),
}));

jest.mock('~/server/middleware/platformAdmin', () => (_req, _res, next) => next());

jest.mock('~/db/models', () => ({
  User: {
    findOne: (...args) => mockFindUser(...args),
  },
}));

jest.mock('~/server/services/AuthService', () => ({
  resendUserVerificationEmail: (...args) => mockResendUserVerificationEmail(...args),
}));

jest.mock('~/server/services/institutionMembers', () => ({
  HttpError: MockHttpError,
  listPlatformInstitutionMembers: (...args) => mockListPlatformInstitutionMembers(...args),
  reactivateInstitutionMember: jest.fn(),
  removeInstitutionMember: jest.fn(),
  resendInstitutionInvite: (...args) => mockResendInstitutionInvite(...args),
  revokeInstitutionInvite: jest.fn(),
  setInstitutionRole: jest.fn(),
  suspendInstitutionMember: jest.fn(),
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

async function invokeRoute({ path, method, params = {}, query = {}, body = {} }) {
  const router = require('./users');
  const handlers = getRouteHandlers(router, path, method);
  const req = {
    method: method.toUpperCase(),
    params,
    query,
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
      } catch (routeError) {
        reject(routeError);
      }
    };
    next();
  });
}

describe('platform users route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('lists users and invitations across institutions', async () => {
    mockListPlatformInstitutionMembers.mockResolvedValue({
      members: [
        {
          id: 'user-1',
          tenantId: 'tenant-a',
          institutionName: 'Tenant A',
          role: 'INSTITUTION_ADMIN',
        },
      ],
      total: 1,
      summary: { activeMembers: 1, pendingInvites: 0, institutions: 1 },
    });

    const response = await invokeRoute({
      path: '/',
      method: 'get',
      query: { q: 'admin', role: 'INSTITUTION_ADMIN', limit: '25', offset: '0' },
    });

    expect(mockListPlatformInstitutionMembers).toHaveBeenCalledWith({
      tenantId: undefined,
      limit: 25,
      offset: 0,
      query: 'admin',
      status: undefined,
      role: 'INSTITUTION_ADMIN',
    });
    expect(response.statusCode).toBe(200);
    expect(response.body.members[0].institutionName).toBe('Tenant A');
  });

  it('resends a pending or expired invitation in its institution', async () => {
    mockResendInstitutionInvite.mockResolvedValue({
      invite: { _id: 'invite-1', tenantId: 'tenant-a' },
      inviteLink: 'http://client/register?token=new',
    });

    const response = await invokeRoute({
      path: '/invites/:inviteId/resend',
      method: 'post',
      params: { inviteId: 'invite-1' },
      body: { tenantId: 'tenant-a' },
    });

    expect(mockResendInstitutionInvite).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-a',
        inviteId: 'invite-1',
      }),
    );
    expect(response.statusCode).toBe(200);
    expect(response.body.inviteLink).toContain('token=new');
  });

  it('resends verification for an accepted but unverified member', async () => {
    mockFindUser.mockReturnValue({
      select: () => ({
        lean: () => ({
          exec: jest.fn().mockResolvedValue({
            _id: 'user-1',
            email: 'admin@example.com',
            emailVerified: false,
          }),
        }),
      }),
    });

    const response = await invokeRoute({
      path: '/:id/resend-verification',
      method: 'post',
      params: { id: 'user-1' },
      body: { tenantId: 'tenant-a' },
    });

    expect(mockFindUser).toHaveBeenCalledWith({ _id: 'user-1', tenantId: 'tenant-a' });
    expect(mockResendUserVerificationEmail).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'admin@example.com' }),
    );
    expect(response.statusCode).toBe(200);
  });
});
