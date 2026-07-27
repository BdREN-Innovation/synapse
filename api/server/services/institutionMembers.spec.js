const mockExec = (value) => ({
  lean: () => ({
    exec: jest.fn().mockResolvedValue(value),
  }),
});

const mockModels = {
  Institution: {
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
  },
  InstitutionInvite: {
    countDocuments: jest.fn(),
    create: jest.fn(),
    findOne: jest.fn(),
  },
  User: {
    countDocuments: jest.fn(),
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
    updateOne: jest.fn(),
  },
};

jest.mock('mongoose', () => ({
  startSession: jest.fn(),
  Types: {
    ObjectId: jest.fn((value) => value),
  },
}));

jest.mock('@librechat/api', () => ({
  checkEmailConfig: jest.fn(),
}));

jest.mock('librechat-data-provider', () => ({
  SystemRoles: {
    USER: 'USER',
    ADMIN: 'ADMIN',
  },
}));

jest.mock('@librechat/data-schemas', () => ({
  getRandomValues: jest.fn(),
  getTransactionSupport: jest.fn().mockResolvedValue(false),
  hashToken: jest.fn(),
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
  },
  runAsSystem: (callback) => callback(),
  tenantStorage: {
    run: (_context, callback) => callback(),
  },
  InstitutionInviteStatuses: {
    PENDING: 'pending',
    ACCEPTED: 'accepted',
    REVOKED: 'revoked',
    EXPIRED: 'expired',
  },
  InstitutionInviteSources: {
    MANUAL: 'manual',
    CSV_IMPORT: 'csv_import',
  },
  InstitutionMembershipStatuses: {
    ACTIVE: 'active',
    SUSPENDED: 'suspended',
    REMOVED: 'removed',
  },
  InstitutionImportJobStatuses: {
    PENDING: 'pending',
    COMPLETED: 'completed',
    FAILED: 'failed',
  },
  INSTITUTION_ADMIN_ROLE: 'INSTITUTION_ADMIN',
}));

jest.mock('~/models', () => ({
  recordAuditEntry: jest.fn(),
}));

jest.mock('~/db/models', () => mockModels);
jest.mock('~/server/utils', () => ({
  sendEmail: jest.fn(),
}));
jest.mock('./tenancy', () => ({
  appointInstitutionAdmin: jest.fn(),
  revokeInstitutionAdmin: jest.fn(),
}));
jest.mock('./platformAdmin', () => ({
  isPlatformAdminEmail: jest.fn().mockResolvedValue(false),
}));

const mongoose = require('mongoose');
const { isPlatformAdminEmail } = require('./platformAdmin');
const { activateProvisionedMember, createInstitutionInvite } = require('./institutionMembers');

describe('createInstitutionInvite platform admin protection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('refuses to invite an email reserved for platform administration', async () => {
    isPlatformAdminEmail.mockResolvedValueOnce(true);

    await expect(
      createInstitutionInvite({
        tenantId: 'tenant-a',
        email: 'root@platform.test',
        requestedRole: 'USER',
        invitedBy: { id: 'admin-a' },
      }),
    ).rejects.toMatchObject({ statusCode: 409 });

    expect(mockModels.InstitutionInvite.create).not.toHaveBeenCalled();
  });
});

describe('institutionMembers standalone MongoDB activation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockModels.Institution.findOne.mockReturnValue(
      mockExec({
        tenantId: 'tenant-a',
        limits: { maxActiveMembers: 2 },
        stats: { activeMembers: 0 },
      }),
    );
    mockModels.User.findOne.mockReturnValue(
      mockExec({
        _id: 'user-a',
        tenantId: 'tenant-a',
        email: 'member@example.com',
        membershipStatus: 'suspended',
      }),
    );
  });

  it('uses an atomic seat reservation when transactions are unavailable', async () => {
    mockModels.Institution.findOneAndUpdate.mockReturnValue(
      mockExec({
        tenantId: 'tenant-a',
        limits: { maxActiveMembers: 2 },
        stats: { activeMembers: 1 },
      }),
    );
    mockModels.User.findOneAndUpdate.mockReturnValue(
      mockExec({
        _id: 'user-a',
        tenantId: 'tenant-a',
        email: 'member@example.com',
        membershipStatus: 'active',
      }),
    );

    const result = await activateProvisionedMember({
      tenantId: 'tenant-a',
      userId: 'user-a',
    });

    expect(result.membershipStatus).toBe('active');
    expect(mongoose.startSession).not.toHaveBeenCalled();
    expect(mockModels.Institution.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-a' }),
      { $inc: { 'stats.activeMembers': 1 } },
      { new: true },
    );
    expect(mockModels.User.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: 'user-a',
        tenantId: 'tenant-a',
        membershipStatus: 'suspended',
      }),
      expect.objectContaining({
        $set: expect.objectContaining({ membershipStatus: 'active' }),
      }),
      { new: true },
    );
  });

  it('rejects activation without changing the user when the seat limit is reached', async () => {
    mockModels.Institution.findOneAndUpdate.mockReturnValue(mockExec(null));

    await expect(
      activateProvisionedMember({
        tenantId: 'tenant-a',
        userId: 'user-a',
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: 'Seat limit reached',
    });

    expect(mockModels.User.findOneAndUpdate).not.toHaveBeenCalled();
  });
});
