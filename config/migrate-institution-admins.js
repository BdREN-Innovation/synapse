const path = require('path');
require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });

const { SystemRoles } = require('librechat-data-provider');
const {
  INSTITUTION_ADMIN_ROLE,
  runAsSystem,
  tenantStorage,
} = require('@librechat/data-schemas');
const connect = require('./connect');
const db = require('~/models');
const { ensureInstitutionAdminRole } = require('~/server/services/tenancy');

function parseArgs(argv) {
  const args = {
    apply: false,
    includeUnregisteredTenants: false,
    tenantIds: [],
  };

  for (const arg of argv) {
    if (arg === '--apply') {
      args.apply = true;
      continue;
    }
    if (arg === '--include-unregistered-tenants') {
      args.includeUnregisteredTenants = true;
      continue;
    }
    if (arg.startsWith('--tenant=')) {
      const tenantId = arg.slice('--tenant='.length).trim();
      if (tenantId) {
        args.tenantIds.push(tenantId);
      }
    }
  }

  return args;
}

function printUsage() {
  console.log('Usage: npm run node -- config/migrate-institution-admins.js [--apply] [--tenant=<tenantId>] [--include-unregistered-tenants]');
  console.log('');
  console.log('Default mode is dry-run. Use --apply to perform the migration.');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (process.argv.includes('--help')) {
    printUsage();
    return;
  }

  await connect();

  const institutions = await runAsSystem(() => db.listInstitutions({ limit: 1000, offset: 0 }));
  const institutionByTenantId = new Map(
    institutions.map((institution) => [institution.tenantId, institution]),
  );

  const userFilter = {
    role: SystemRoles.ADMIN,
    tenantId:
      args.tenantIds.length > 0
        ? { $in: args.tenantIds }
        : { $nin: [null, ''] },
  };

  const legacyAdmins = await runAsSystem(() =>
    db.findUsers(userFilter, '_id email name role tenantId', {
      sort: { tenantId: 1, email: 1 },
      limit: 10000,
    }),
  );

  if (legacyAdmins.length === 0) {
    console.log('No tenant-scoped legacy ADMIN users found.');
    return;
  }

  const skipped = [];
  const candidates = [];

  for (const user of legacyAdmins) {
    if (!user.tenantId) {
      skipped.push({
        reason: 'missing tenantId',
        tenantId: '',
        email: user.email ?? '',
        userId: user._id?.toString() ?? '',
      });
      continue;
    }

    const institution = institutionByTenantId.get(user.tenantId);
    if (!institution && !args.includeUnregisteredTenants) {
      skipped.push({
        reason: 'tenant not registered in institutions',
        tenantId: user.tenantId,
        email: user.email ?? '',
        userId: user._id?.toString() ?? '',
      });
      continue;
    }

    candidates.push({
      userId: user._id?.toString() ?? '',
      email: user.email ?? '',
      name: user.name ?? '',
      tenantId: user.tenantId,
      institutionName: institution?.name ?? '(unregistered tenant)',
    });
  }

  console.log(`Legacy ADMIN users found: ${legacyAdmins.length}`);
  console.log(`Migration candidates: ${candidates.length}`);
  console.log(`Skipped: ${skipped.length}`);
  console.log('');

  for (const candidate of candidates) {
    console.log(
      `[candidate] tenant=${candidate.tenantId} institution=${candidate.institutionName} user=${candidate.email} (${candidate.userId})`,
    );
  }

  for (const item of skipped) {
    console.log(
      `[skipped] tenant=${item.tenantId || '-'} user=${item.email} (${item.userId}) reason=${item.reason}`,
    );
  }

  if (!args.apply) {
    console.log('');
    console.log('Dry run only. Re-run with --apply to migrate these users to INSTITUTION_ADMIN.');
    return;
  }

  const migrated = [];
  for (const candidate of candidates) {
    await ensureInstitutionAdminRole(candidate.tenantId);
    await tenantStorage.run({ tenantId: candidate.tenantId }, async () => {
      await db.updateUser(candidate.userId, { role: INSTITUTION_ADMIN_ROLE });
    });
    migrated.push(candidate);
  }

  console.log('');
  console.log(`Migrated ${migrated.length} users to ${INSTITUTION_ADMIN_ROLE}.`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Migration failed:', error);
    process.exit(1);
  });
