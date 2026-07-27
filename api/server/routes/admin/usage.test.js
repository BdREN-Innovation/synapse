class mockHttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

const mockGetUsageSummary = jest.fn();
const mockListUsageByMember = jest.fn();
const mockExportUsageCsv = jest.fn();

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (_req, _res, next) => next(),
}));

jest.mock('~/server/middleware/roles/capabilities', () => ({
  requireCapability: () => (_req, _res, next) => next(),
}));

jest.mock('~/server/services/institutionUsage', () => ({
  HttpError: mockHttpError,
  exportUsageCsv: (...args) => mockExportUsageCsv(...args),
  getUsageSummary: (...args) => mockGetUsageSummary(...args),
  getUsageTimeseries: jest.fn(),
  listUsageByMember: (...args) => mockListUsageByMember(...args),
  listUsageByModel: jest.fn(),
}));

function getRouter() {
  return require('./usage');
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
}) {
  const router = getRouter();
  const handlers = getRouteHandlers(router, path, method);
  const req = {
    method: method.toUpperCase(),
    params,
    query,
    user,
    headers: {},
  };

  return await new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      headers: {},
      status(code) {
        this.statusCode = code;
        return this;
      },
      setHeader(name, value) {
        this.headers[name] = value;
      },
      json(payload) {
        resolve({ statusCode: this.statusCode, body: payload, headers: this.headers });
        return this;
      },
      send(payload) {
        resolve({ statusCode: this.statusCode, body: payload, headers: this.headers });
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
        resolve({ statusCode: res.statusCode, body: undefined, headers: res.headers });
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

describe('admin usage route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('loads tenant-scoped usage summary', async () => {
    mockGetUsageSummary.mockResolvedValue({
      range: { start: '2026-07-01T00:00:00.000Z', end: '2026-08-01T00:00:00.000Z' },
      summary: { totalTokens: 1200, totalCost: 4.2 },
    });

    const res = await invokeRoute({
      path: '/summary',
      method: 'get',
      query: { start: '2026-07-01', end: '2026-08-01' },
    });

    expect(mockGetUsageSummary).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      start: '2026-07-01',
      end: '2026-08-01',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.summary.totalTokens).toBe(1200);
  });

  it('lists member usage with pagination', async () => {
    mockListUsageByMember.mockResolvedValue({
      range: {},
      members: [{ userId: 'member-1', name: 'Ada', totalTokens: 500 }],
      total: 1,
      limit: 25,
      offset: 0,
    });

    const res = await invokeRoute({
      path: '/members',
      method: 'get',
      query: { q: 'ada', limit: '25', offset: '0' },
    });

    expect(mockListUsageByMember).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      start: undefined,
      end: undefined,
      limit: '25',
      offset: '0',
      query: 'ada',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.total).toBe(1);
  });

  it('streams CSV exports', async () => {
    mockExportUsageCsv.mockResolvedValue({ csv: 'createdAt,totalTokens\n2026-07-01,100\n' });

    const res = await invokeRoute({
      path: '/export.csv',
      method: 'get',
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toMatch(/text\/csv/);
    expect(res.body).toContain('createdAt,totalTokens');
  });

  it('rejects callers without tenant context', async () => {
    const res = await invokeRoute({
      path: '/summary',
      method: 'get',
      user: { id: 'user-1', email: 'admin@example.com' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('Institution admin access requires a tenant context');
    expect(mockGetUsageSummary).not.toHaveBeenCalled();
  });
});
