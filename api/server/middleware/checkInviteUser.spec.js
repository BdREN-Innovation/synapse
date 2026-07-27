const mockFindInstitutionInviteByToken = jest.fn();

jest.mock('~/server/services/institutionMembers', () => ({
  findInstitutionInviteByToken: (...args) => mockFindInstitutionInviteByToken(...args),
  InstitutionInviteStatuses: {
    PENDING: 'pending',
    ACCEPTED: 'accepted',
    REVOKED: 'revoked',
    EXPIRED: 'expired',
  },
}));

const checkInviteUser = require('./checkInviteUser');

function invoke(invite) {
  mockFindInstitutionInviteByToken.mockResolvedValue(invite);
  const req = { body: { token: 'token', email: 'admin@example.com' } };
  const next = jest.fn();
  const res = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json: jest.fn(),
  };
  return checkInviteUser(req, res, next).then(() => ({ req, res, next }));
}

describe('checkInviteUser', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('explains that an accepted invitation must not be reused', async () => {
    const { res, next } = await invoke({ status: 'accepted' });

    expect(res.statusCode).toBe(409);
    expect(res.json).toHaveBeenCalledWith({
      message: 'This invitation has already been accepted. Please log in or reset your password.',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('allows a pending invitation to continue registration', async () => {
    const invite = { _id: 'invite-1', status: 'pending' };
    const { req, next } = await invoke(invite);

    expect(req.invite).toBe(invite);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
