const mockDb = {
  getPlatformAdminForUser: jest.fn(),
  upsertPlatformAdmin: jest.fn(),
  listPlatformAdmins: jest.fn(),
};

jest.mock('@librechat/data-schemas', () => ({
  PlatformRoles: { SUPERADMIN: 'SUPERADMIN' },
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

jest.mock('~/models', () => mockDb);

const { ensurePlatformSuperadminForUser, isPlatformAdminEmail } = require('./platformAdmin');

const SUPERADMIN_RECORD = {
  _id: 'admin-record',
  email: 'root@platform.test',
  role: 'SUPERADMIN',
  active: true,
  userId: 'platform-user-1',
};

describe('ensurePlatformSuperadminForUser', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.PLATFORM_SUPERADMIN_EMAILS;
    mockDb.getPlatformAdminForUser.mockResolvedValue(null);
    mockDb.upsertPlatformAdmin.mockImplementation(async (data) => ({ ...data }));
  });

  it('grants superadmin to the account the record is bound to', async () => {
    mockDb.getPlatformAdminForUser.mockImplementation(async ({ userId }) =>
      userId === 'platform-user-1' ? SUPERADMIN_RECORD : null,
    );

    const result = await ensurePlatformSuperadminForUser({
      id: 'platform-user-1',
      email: 'root@platform.test',
    });

    expect(result.isPlatformSuperadmin).toBe(true);
  });

  it('refuses a tenant member that shares the superadmin email', async () => {
    mockDb.getPlatformAdminForUser.mockImplementation(async ({ email }) =>
      email === 'root@platform.test' ? SUPERADMIN_RECORD : null,
    );

    const result = await ensurePlatformSuperadminForUser({
      id: 'tenant-user-9',
      email: 'root@platform.test',
      tenantId: 'inst-a',
    });

    expect(result).toEqual({ isPlatformSuperadmin: false, admin: null });
    expect(mockDb.upsertPlatformAdmin).not.toHaveBeenCalled();
  });

  it('refuses an email match when the record is bound to a different account', async () => {
    mockDb.getPlatformAdminForUser.mockImplementation(async ({ userId, email }) => {
      if (userId) {
        return null;
      }
      return email === 'root@platform.test' ? SUPERADMIN_RECORD : null;
    });

    const result = await ensurePlatformSuperadminForUser({
      id: 'impostor-user',
      email: 'root@platform.test',
    });

    expect(result).toEqual({ isPlatformSuperadmin: false, admin: null });
    expect(mockDb.upsertPlatformAdmin).not.toHaveBeenCalled();
  });

  it('claims a seeded record that is not yet bound to an account', async () => {
    const unbound = { ...SUPERADMIN_RECORD, userId: undefined };
    mockDb.getPlatformAdminForUser.mockImplementation(async ({ userId, email }) => {
      if (userId) {
        return null;
      }
      return email === 'root@platform.test' ? unbound : null;
    });

    const result = await ensurePlatformSuperadminForUser({
      id: 'platform-user-1',
      email: 'root@platform.test',
    });

    expect(result.isPlatformSuperadmin).toBe(true);
    expect(mockDb.upsertPlatformAdmin).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'platform-user-1', email: 'root@platform.test' }),
    );
  });

  it('does not bootstrap an admin when no records exist and no env emails are set', async () => {
    const result = await ensurePlatformSuperadminForUser({
      id: 'first-user',
      email: 'first@platform.test',
    });

    expect(result).toEqual({ isPlatformSuperadmin: false, admin: null });
    expect(mockDb.upsertPlatformAdmin).not.toHaveBeenCalled();
    expect(mockDb.listPlatformAdmins).not.toHaveBeenCalled();
  });

  it('bootstraps only tenant-less accounts listed in PLATFORM_SUPERADMIN_EMAILS', async () => {
    process.env.PLATFORM_SUPERADMIN_EMAILS = 'root@platform.test';

    const granted = await ensurePlatformSuperadminForUser({
      id: 'platform-user-1',
      email: 'Root@Platform.test',
    });
    expect(granted.isPlatformSuperadmin).toBe(true);

    mockDb.upsertPlatformAdmin.mockClear();
    const refused = await ensurePlatformSuperadminForUser({
      id: 'tenant-user-9',
      email: 'root@platform.test',
      tenantId: 'inst-a',
    });
    expect(refused.isPlatformSuperadmin).toBe(false);
    expect(mockDb.upsertPlatformAdmin).not.toHaveBeenCalled();
  });

  it('refuses a deactivated record', async () => {
    mockDb.getPlatformAdminForUser.mockImplementation(async ({ userId }) =>
      userId === 'platform-user-1' ? { ...SUPERADMIN_RECORD, active: false } : null,
    );

    const result = await ensurePlatformSuperadminForUser({
      id: 'platform-user-1',
      email: 'root@platform.test',
    });

    expect(result.isPlatformSuperadmin).toBe(false);
  });
});

describe('isPlatformAdminEmail', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.PLATFORM_SUPERADMIN_EMAILS;
    mockDb.getPlatformAdminForUser.mockResolvedValue(null);
  });

  it('reports stored active admins regardless of casing', async () => {
    mockDb.getPlatformAdminForUser.mockResolvedValue(SUPERADMIN_RECORD);
    await expect(isPlatformAdminEmail('  Root@Platform.TEST ')).resolves.toBe(true);
  });

  it('reports env-seeded admins that have never logged in', async () => {
    process.env.PLATFORM_SUPERADMIN_EMAILS = 'root@platform.test';
    await expect(isPlatformAdminEmail('root@platform.test')).resolves.toBe(true);
  });

  it('ignores deactivated records and unknown emails', async () => {
    mockDb.getPlatformAdminForUser.mockResolvedValue({ ...SUPERADMIN_RECORD, active: false });
    await expect(isPlatformAdminEmail('root@platform.test')).resolves.toBe(false);

    mockDb.getPlatformAdminForUser.mockResolvedValue(null);
    await expect(isPlatformAdminEmail('someone@inst.test')).resolves.toBe(false);
    await expect(isPlatformAdminEmail('')).resolves.toBe(false);
  });
});
