const { PlatformRoles } = require('@librechat/data-schemas');
const { ensurePlatformSuperadminForUser } = require('~/server/services/platformAdmin');

async function requirePlatformSuperadmin(req, res, next) {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { admin } = await ensurePlatformSuperadminForUser(req.user);

    if (!admin || admin.active !== true || admin.role !== PlatformRoles.SUPERADMIN) {
      return res.status(403).json({ error: 'Platform superadmin privileges required' });
    }

    req.platformAdmin = admin;
    next();
  } catch (error) {
    next(error);
  }
}

module.exports = requirePlatformSuperadmin;
