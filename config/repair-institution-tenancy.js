const path = require('path');
require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });

const mongoose = require('mongoose');
const { SystemRoles } = require('librechat-data-provider');
const {
  INSTITUTION_ADMIN_ROLE,
  SystemCapabilities,
  runAsSystem,
  createModels,
} = require('@librechat/data-schemas');

/** Registers every schema on the connection. The `db` methods below resolve
 *  models off `mongoose.models` at call time, so this has to run first. */
const { Agent, AclEntry, Role } = createModels(mongoose);

const connect = require('./connect');
const db = require('~/models');
const { ensureInstitutionAdminRole } = require('~/server/services/tenancy');

/**
 * Repairs tenancy state that predates, or was applied outside of, the normal
 * appointment and creation paths.
 *
 * Three independent repairs, each opt-in:
 *
 * 1. `--grants` — a user can hold `role: INSTITUTION_ADMIN` while the role
 *    document and its capability grants were never created, which is what
 *    happens when the role is set directly rather than through
 *    `appointInstitutionAdmin`. The user then fails the `ACCESS_ADMIN` check and
 *    the admin panel answers "You do not have admin privileges".
 *
 * 2. `--adopt-agents` — every query made in tenant context has `tenantId`
 *    injected into its filter, so an agent created by a tenant-less platform
 *    admin is invisible to the tenant's own members. Adoption stamps the agent
 *    and its ACL entries with the tenant. Platform admins keep access: with no
 *    tenant in context nothing is injected, so their queries still match.
 *
 * 3. `--set-agent-create=<true|false>` — flips `AGENTS.CREATE` on the member
 *    roles. `initializeRoles` only backfills permission blocks that are absent
 *    or empty, so an explicit value here survives restarts.
 *
 * Dry run unless `--apply` is passed.
 */

function parseArgs(argv) {
  const args = {
    apply: false,
    grants: false,
    adoptAgents: false,
    setAgentCreate: null,
    tenantIds: [],
    roles: [SystemRoles.USER, INSTITUTION_ADMIN_ROLE],
  };

  for (const arg of argv) {
    if (arg === '--apply') {
      args.apply = true;
    } else if (arg === '--grants') {
      args.grants = true;
    } else if (arg === '--adopt-agents') {
      args.adoptAgents = true;
    } else if (arg.startsWith('--set-agent-create=')) {
      args.setAgentCreate = arg.slice('--set-agent-create='.length).trim() === 'true';
    } else if (arg.startsWith('--roles=')) {
      const roles = arg
        .slice('--roles='.length)
        .split(',')
        .map((role) => role.trim())
        .filter(Boolean);
      if (roles.length > 0) {
        args.roles = roles;
      }
    } else if (arg.startsWith('--tenant=')) {
      const tenantId = arg.slice('--tenant='.length).trim();
      if (tenantId) {
        args.tenantIds.push(tenantId);
      }
    }
  }

  return args;
}

function printUsage() {
  console.log(
    'Usage: npm run node -- config/repair-institution-tenancy.js --tenant=<id> [--grants] [--adopt-agents] [--set-agent-create=<true|false>] [--apply]',
  );
  console.log('');
  console.log(
    '  --grants              create the INSTITUTION_ADMIN role and its capability grants',
  );
  console.log(
    '  --adopt-agents        stamp tenant-less agents and their ACL entries with the tenant',
  );
  console.log('  --set-agent-create=X  set AGENTS.CREATE on USER and INSTITUTION_ADMIN roles');
  console.log(
    '  --roles=A,B           roles for --set-agent-create (default USER,INSTITUTION_ADMIN)',
  );
  console.log('  --apply               perform the changes (default is a dry run)');
}

async function repairGrants({ tenantIds, apply }) {
  console.log('== Institution administrator capability grants ==');

  const admins = await runAsSystem(() =>
    db.findUsers(
      { role: INSTITUTION_ADMIN_ROLE, tenantId: { $in: tenantIds } },
      '_id email tenantId',
      { limit: 10000 },
    ),
  );

  if (admins.length === 0) {
    console.log('No INSTITUTION_ADMIN users found in the given tenants. Nothing to repair.');
    return;
  }

  const byTenant = new Map();
  for (const admin of admins) {
    if (!byTenant.has(admin.tenantId)) {
      byTenant.set(admin.tenantId, []);
    }
    byTenant.get(admin.tenantId).push(admin.email ?? admin._id.toString());
  }

  for (const [tenantId, emails] of byTenant) {
    const held = await runAsSystem(() =>
      db.hasCapabilityForPrincipals({
        principals: [{ principalType: 'role', principalId: INSTITUTION_ADMIN_ROLE }],
        capability: SystemCapabilities.ACCESS_ADMIN,
        tenantId,
      }),
    );

    if (held) {
      console.log(
        `[ok]      tenant=${tenantId} already holds ACCESS_ADMIN (${emails.length} admin(s))`,
      );
      continue;
    }

    console.log(
      `[repair]  tenant=${tenantId} missing ACCESS_ADMIN — affects: ${emails.join(', ')}`,
    );
    if (apply) {
      await ensureInstitutionAdminRole(tenantId);
      console.log(`[applied] tenant=${tenantId} role and capability grants created`);
    }
  }
}

async function adoptAgents({ tenantIds, apply }) {
  console.log('');
  console.log('== Tenant-less agent adoption ==');

  if (tenantIds.length !== 1) {
    console.log('Adoption needs exactly one --tenant: a tenant-less agent has no other way to');
    console.log('say which tenant it belongs to. Re-run once per tenant.');
    return;
  }

  const tenantId = tenantIds[0];

  const orphans = await runAsSystem(() =>
    Agent.find({ tenantId: { $exists: false } }, { _id: 1, id: 1, name: 1 })
      .lean()
      .exec(),
  );

  if (orphans.length === 0) {
    console.log('No tenant-less agents found.');
    return;
  }

  for (const agent of orphans) {
    const aclCount = await runAsSystem(() =>
      AclEntry.countDocuments({ resourceId: agent._id, tenantId: { $exists: false } }).exec(),
    );
    console.log(
      `[adopt]   "${agent.name}" (${agent.id}) -> tenant=${tenantId}, plus ${aclCount} ACL entr(ies)`,
    );

    if (!apply) {
      continue;
    }

    await runAsSystem(async () => {
      await Agent.updateOne({ _id: agent._id }, { $set: { tenantId } }).exec();
      await AclEntry.updateMany(
        { resourceId: agent._id, tenantId: { $exists: false } },
        { $set: { tenantId } },
      ).exec();
    });
    console.log(`[applied] "${agent.name}" adopted into ${tenantId}`);
  }
}

async function setAgentCreate({ tenantIds, value, apply, roleNames }) {
  console.log('');
  console.log(`== AGENTS.CREATE -> ${value} for ${roleNames.join(', ')} ==`);

  for (const tenantId of [undefined, ...tenantIds]) {
    for (const roleName of roleNames) {
      const role = await runAsSystem(() =>
        Role.findOne(
          tenantId
            ? { name: roleName, tenantId }
            : { name: roleName, tenantId: { $exists: false } },
        )
          .lean()
          .exec(),
      );

      if (!role) {
        continue;
      }

      const current = role.permissions?.AGENTS?.CREATE;
      const scope = tenantId ? `tenant=${tenantId}` : 'platform-level';
      if (current === value) {
        console.log(`[ok]      ${roleName} (${scope}) already CREATE=${value}`);
        continue;
      }

      console.log(`[change]  ${roleName} (${scope}) CREATE ${current} -> ${value}`);
      if (apply) {
        await runAsSystem(() =>
          Role.updateOne(
            { _id: role._id },
            { $set: { 'permissions.AGENTS.CREATE': value } },
          ).exec(),
        );
        console.log(`[applied] ${roleName} (${scope})`);
      }
    }
  }
}

async function main() {
  if (process.argv.includes('--help')) {
    printUsage();
    return;
  }

  const args = parseArgs(process.argv.slice(2));

  if (args.tenantIds.length === 0) {
    console.log('At least one --tenant=<id> is required.');
    printUsage();
    process.exitCode = 1;
    return;
  }

  if (!args.grants && !args.adoptAgents && args.setAgentCreate === null) {
    console.log(
      'Nothing selected. Pass at least one of --grants, --adopt-agents, --set-agent-create.',
    );
    printUsage();
    process.exitCode = 1;
    return;
  }

  await connect();

  console.log(args.apply ? 'MODE: APPLY (writing changes)' : 'MODE: DRY RUN (no changes written)');
  console.log(`Tenants: ${args.tenantIds.join(', ')}`);
  console.log('');

  if (args.grants) {
    await repairGrants(args);
  }
  if (args.adoptAgents) {
    await adoptAgents(args);
  }
  if (args.setAgentCreate !== null) {
    await setAgentCreate({
      tenantIds: args.tenantIds,
      value: args.setAgentCreate,
      apply: args.apply,
      roleNames: args.roles,
    });
  }

  if (!args.apply) {
    console.log('');
    console.log('Dry run only. Re-run with --apply to write these changes.');
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
