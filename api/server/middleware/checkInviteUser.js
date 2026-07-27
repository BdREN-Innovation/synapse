const {
  findInstitutionInviteByToken,
  InstitutionInviteStatuses,
} = require('~/server/services/institutionMembers');

async function checkInviteUser(req, res, next) {
  const token = req.body.token;

  if (!token || token === 'undefined') {
    next();
    return;
  }

  try {
    const invite = await findInstitutionInviteByToken(token, req.body.email);
    if (!invite) {
      return res.status(400).json({ message: 'Invalid invite token' });
    }
    if (invite.status === InstitutionInviteStatuses.ACCEPTED) {
      return res.status(409).json({
        message: 'This invitation has already been accepted. Please log in or reset your password.',
      });
    }
    if (
      invite.status === InstitutionInviteStatuses.EXPIRED ||
      invite.status === InstitutionInviteStatuses.REVOKED
    ) {
      return res.status(410).json({
        message: 'This invitation has expired or was revoked. Ask your administrator to resend it.',
      });
    }

    req.invite = invite;
    next();
  } catch (error) {
    return res.status(429).json({ message: error.message });
  }
}

module.exports = checkInviteUser;
