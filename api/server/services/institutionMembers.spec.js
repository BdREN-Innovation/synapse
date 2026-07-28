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
const { hashToken } = require('@librechat/data-schemas');
const { isPlatformAdminEmail } = require('./platformAdmin');
const {
  activateProvisionedMember,
  createInstitutionInvite,
  resolveInstitutionInviteByToken,
} = require('./institutionMembers');

describe('resolveInstitutionInviteByToken', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    hashToken.mockResolvedValue('hashed-token');
  });

  it('returns the invited address and name so the form can be prefilled', async () => {
    mockModels.InstitutionInvite.findOne.mockReturnValue({
      exec: jest.fn().mockResolvedValue({
        email: 'invitee@inst.test',
        name: 'Invitee',
        status: 'pending',
      }),
    });

    await expect(resolveInstitutionInviteByToken('raw-token')).resolves.toEqual({
      email: 'invitee@inst.test',
      name: 'Invitee',
      status: 'pending',
    });
  });

  it('marks a lapsed invitation expired rather than resolving it as pending', async () => {
    const save = jest.fn().mockResolvedValue(undefined);
    mockModels.InstitutionInvite.findOne.mockReturnValue({
      exec: jest.fn().mockResolvedValue({
        email: 'invitee@inst.test',
        name: '',
        status: 'pending',
        expiresAt: new Date(Date.now() - 1000),
        save,
      }),
    });

    const result = await resolveInstitutionInviteByToken('raw-token');
    expect(result.status).toBe('expired');
    expect(save).toHaveBeenCalled();
  });

  it('resolves nothing for an unknown or empty token', async () => {
    mockModels.InstitutionInvite.findOne.mockReturnValue({
      exec: jest.fn().mockResolvedValue(null),
    });
    await expect(resolveInstitutionInviteByToken('nope')).resolves.toBeNull();
    await expect(resolveInstitutionInviteByToken('')).resolves.toBeNull();
  });
});

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

describe('createInstitutionInvite seat enforcement', () => {
  const seatState = ({ activeMembers, maxActiveMembers, pendingInvites }) => {
    mockModels.Institution.findOne.mockReturnValue(
      mockExec({
        tenantId: 'tenant-a',
        stats: { activeMembers },
        limits: { maxActiveMembers },
      }),
    );
    mockModels.InstitutionInvite.countDocuments.mockResolvedValue(pendingInvites);
  };

  beforeEach(() => {
    jest.clearAllMocks();
    isPlatformAdminEmail.mockResolvedValue(false);
  });

  it('refuses a new invitation once every seat is claimed', async () => {
    seatState({ activeMembers: 2, maxActiveMembers: 2, pendingInvites: 0 });

    await expect(
      createInstitutionInvite({
        tenantId: 'tenant-a',
        email: 'new@inst.test',
        requestedRole: 'USER',
        invitedBy: { id: 'admin-a' },
      }),
    ).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('Seat limit') });

    expect(mockModels.InstitutionInvite.create).not.toHaveBeenCalled();
  });

  it('counts a pending invitation as a claimed seat', async () => {
    seatState({ activeMembers: 1, maxActiveMembers: 2, pendingInvites: 1 });

    await expect(
      createInstitutionInvite({
        tenantId: 'tenant-a',
        email: 'new@inst.test',
        requestedRole: 'USER',
        invitedBy: { id: 'admin-a' },
      }),
    ).rejects.toMatchObject({ statusCode: 409 });

    expect(mockModels.InstitutionInvite.create).not.toHaveBeenCalled();
  });

  it('allows an invitation while a seat remains', async () => {
    seatState({ activeMembers: 1, maxActiveMembers: 5, pendingInvites: 1 });
    mockModels.InstitutionInvite.findOne.mockReturnValue(mockExec(null));
    mockModels.User.findOne.mockReturnValue({
      select: () => ({ lean: () => ({ exec: jest.fn().mockResolvedValue(null) }) }),
    });
    mockModels.InstitutionInvite.create.mockResolvedValue({ _id: 'invite-1', email: 'new@inst.test' });

    await createInstitutionInvite({
      tenantId: 'tenant-a',
      email: 'new@inst.test',
      requestedRole: 'USER',
      invitedBy: { id: 'admin-a' },
    });

    expect(mockModels.InstitutionInvite.create).toHaveBeenCalled();
  });

  it('never blocks when the institution has no seat limit', async () => {
    seatState({ activeMembers: 900, maxActiveMembers: null, pendingInvites: 40 });
    mockModels.InstitutionInvite.findOne.mockReturnValue(mockExec(null));
    mockModels.User.findOne.mockReturnValue({
      select: () => ({ lean: () => ({ exec: jest.fn().mockResolvedValue(null) }) }),
    });
    mockModels.InstitutionInvite.create.mockResolvedValue({ _id: 'invite-2', email: 'x@inst.test' });

    await createInstitutionInvite({
      tenantId: 'tenant-a',
      email: 'x@inst.test',
      requestedRole: 'USER',
      invitedBy: { id: 'admin-a' },
    });

    expect(mockModels.InstitutionInvite.create).toHaveBeenCalled();
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
