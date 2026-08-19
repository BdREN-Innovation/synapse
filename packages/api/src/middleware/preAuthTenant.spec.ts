import { getTenantId, getUserId, getRequestId, logger } from '@librechat/data-schemas';
import type { Request, Response, NextFunction } from 'express';
import { validateActiveInstitution } from './institution';
import { preAuthTenantMiddleware } from './preAuthTenant';

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('./institution', () => ({
  validateActiveInstitution: jest.fn(),
}));

const validateActiveInstitutionMock = jest.mocked(validateActiveInstitution);

describe('preAuthTenantMiddleware', () => {
  const originalTrustTenantHeader = process.env.TRUST_TENANT_HEADER;
  let req: {
    headers: Record<string, string | string[] | undefined>;
    ip?: string;
    path?: string;
    tenantId?: string;
    user?: { id: string; tenantId: string };
  };
  let res: Partial<Response> & { status: jest.Mock; json: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.TRUST_TENANT_HEADER;
    req = { headers: {} };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    validateActiveInstitutionMock.mockResolvedValue({
      ok: true,
      institution: { tenantId: 'acme-corp', status: 'active', name: 'Acme' },
    });
  });

  afterAll(() => {
    if (originalTrustTenantHeader === undefined) {
      delete process.env.TRUST_TENANT_HEADER;
      return;
    }
    process.env.TRUST_TENANT_HEADER = originalTrustTenantHeader;
  });

  it('calls next() without ALS context when no X-Tenant-Id header is present', () => {
    let capturedTenantId: string | undefined = 'sentinel';
    const capturedNext: NextFunction = () => {
      capturedTenantId = getTenantId();
    };

    preAuthTenantMiddleware(req as Request, res as Response, capturedNext);
    expect(capturedTenantId).toBeUndefined();
  });

  it('calls next() without ALS context when X-Tenant-Id header is empty', () => {
    req.headers = { 'x-tenant-id': '' };
    let capturedTenantId: string | undefined = 'sentinel';
    const capturedNext: NextFunction = () => {
      capturedTenantId = getTenantId();
    };

    preAuthTenantMiddleware(req as Request, res as Response, capturedNext);
    expect(capturedTenantId).toBeUndefined();
  });

  it('ignores X-Tenant-Id unless the deployment explicitly trusts the header', () => {
    req.headers = { 'x-tenant-id': 'attacker-selected' };
    let capturedTenantId: string | undefined = 'sentinel';
    const capturedNext: NextFunction = () => {
      capturedTenantId = getTenantId();
    };

    preAuthTenantMiddleware(req as Request, res as Response, capturedNext);
    expect(capturedTenantId).toBeUndefined();
  });

  it('wraps downstream in ALS context when the deployment trusts X-Tenant-Id', async () => {
    process.env.TRUST_TENANT_HEADER = 'TRUE';
    req.headers = { 'x-tenant-id': 'acme-corp' };
    let capturedTenantId: string | undefined;
    const capturedNext: NextFunction = () => {
      capturedTenantId = getTenantId();
    };

    preAuthTenantMiddleware(req as Request, res as Response, capturedNext);
    await Promise.resolve();
    expect(capturedTenantId).toBe('acme-corp');
  });

  it('propagates request ID from pre-auth routes', () => {
    req.headers = { 'x-request-id': 'req-preauth' };
    let capturedRequestId: string | undefined;
    const capturedNext: NextFunction = () => {
      capturedRequestId = getRequestId();
    };

    preAuthTenantMiddleware(req as Request, res as Response, capturedNext);
    expect(capturedRequestId).toBe('req-preauth');
  });

  it('does not inherit request identity before authentication', () => {
    req.tenantId = 'untrusted-tenant';
    req.user = { id: 'untrusted-user', tenantId: 'untrusted-tenant' };
    let capturedContext: { tenantId?: string; userId?: string } = {};
    const capturedNext: NextFunction = () => {
      capturedContext = { tenantId: getTenantId(), userId: getUserId() };
    };

    preAuthTenantMiddleware(req as Request, res as Response, capturedNext);

    expect(capturedContext).toEqual({ tenantId: undefined, userId: undefined });
  });

  it('ignores __SYSTEM__ sentinel and logs warning', () => {
    process.env.TRUST_TENANT_HEADER = 'true';
    req.headers = { 'x-tenant-id': '__SYSTEM__' };
    req.ip = '10.0.0.1';
    req.path = '/api/config';
    let capturedTenantId: string | undefined = 'should-be-overwritten';
    const capturedNext: NextFunction = () => {
      capturedTenantId = getTenantId();
    };

    preAuthTenantMiddleware(req as Request, res as Response, capturedNext);
    expect(capturedTenantId).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('__SYSTEM__'),
      expect.objectContaining({ ip: '10.0.0.1', path: '/api/config' }),
    );
  });

  it('ignores array-valued headers (Express can produce these)', () => {
    process.env.TRUST_TENANT_HEADER = 'true';
    req.headers = { 'x-tenant-id': ['a', 'b'] as unknown as string };
    let capturedTenantId: string | undefined = 'sentinel';
    const capturedNext: NextFunction = () => {
      capturedTenantId = getTenantId();
    };

    preAuthTenantMiddleware(req as Request, res as Response, capturedNext);
    expect(capturedTenantId).toBeUndefined();
  });

  it('ignores tenant IDs containing invalid characters and logs warning', () => {
    process.env.TRUST_TENANT_HEADER = 'true';
    req.headers = { 'x-tenant-id': 'tenant:injected' };
    req.ip = '192.168.1.1';
    req.path = '/api/auth/login';
    let capturedTenantId: string | undefined = 'sentinel';
    const capturedNext: NextFunction = () => {
      capturedTenantId = getTenantId();
    };

    preAuthTenantMiddleware(req as Request, res as Response, capturedNext);
    expect(capturedTenantId).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('malformed'),
      expect.objectContaining({ ip: '192.168.1.1', path: '/api/auth/login' }),
    );
  });

  it('trims whitespace from tenant ID header', async () => {
    process.env.TRUST_TENANT_HEADER = 'true';
    req.headers = { 'x-tenant-id': '  acme-corp  ' };
    let capturedTenantId: string | undefined;
    const capturedNext: NextFunction = () => {
      capturedTenantId = getTenantId();
    };

    preAuthTenantMiddleware(req as Request, res as Response, capturedNext);
    await Promise.resolve();
    expect(capturedTenantId).toBe('acme-corp');
  });

  it('rejects unknown institutions with 404', async () => {
    process.env.TRUST_TENANT_HEADER = 'true';
    req.headers = { 'x-tenant-id': 'missing-tenant' };
    req.path = '/api/config';
    validateActiveInstitutionMock.mockResolvedValue({
      ok: false,
      reason: 'not_found',
      statusCode: 404,
      message: 'Institution not found',
    });

    const capturedNext = jest.fn();
    preAuthTenantMiddleware(req as Request, res as Response, capturedNext);
    await Promise.resolve();

    expect(capturedNext).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Institution not found' });
  });

  it('rejects suspended institutions with 403', async () => {
    process.env.TRUST_TENANT_HEADER = 'true';
    req.headers = { 'x-tenant-id': 'suspended-tenant' };
    req.path = '/api/config';
    validateActiveInstitutionMock.mockResolvedValue({
      ok: false,
      reason: 'inactive',
      statusCode: 403,
      message: 'Institution is not active',
    });

    const capturedNext = jest.fn();
    preAuthTenantMiddleware(req as Request, res as Response, capturedNext);
    await Promise.resolve();

    expect(capturedNext).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Institution is not active' });
  });

  it('ignores tenant IDs exceeding max length and logs warning', () => {
    process.env.TRUST_TENANT_HEADER = 'true';
    req.headers = { 'x-tenant-id': 'a'.repeat(200) };
    req.ip = '192.168.1.1';
    req.path = '/api/share/abc';
    let capturedTenantId: string | undefined = 'sentinel';
    const capturedNext: NextFunction = () => {
      capturedTenantId = getTenantId();
    };

    preAuthTenantMiddleware(req as Request, res as Response, capturedNext);
    expect(capturedTenantId).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('malformed'),
      expect.objectContaining({ ip: '192.168.1.1', length: 200, path: '/api/share/abc' }),
    );
  });
});
