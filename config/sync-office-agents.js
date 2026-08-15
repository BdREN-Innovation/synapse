const path = require('path');
const fs = require('fs');
const yaml = require('js-yaml');
const { nanoid } = require('nanoid');

require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });

const mongoose = require('mongoose');
const {
  PrincipalType,
  ResourceType,
  AccessRoleIds,
  SystemRoles,
} = require('librechat-data-provider');
const { runAsSystem, createModels } = require('@librechat/data-schemas');

const { Agent, AclEntry } = createModels(mongoose);

const connect = require('./connect');
const db = require('~/models');
const { grantPermission } = require('~/server/services/PermissionService');

/**
 * Synchronizes the Office Assistant and specialist agents from a declarative YAML manifest.
 *
 * The manifest defines:
 * - Master: the visible Office Assistant
 * - Specialists: hidden orchestration-only agents that the master delegates to
 *
 * Agents are created/updated idempotently by stable ID. Permissions are granted
 * to allow internal staff to use the master and load specialists as subagents.
 *
 * Usage:
 *   node config/sync-office-agents.js [--manifest=path] [--tenant=id] [--author=email] [--group=id] [--apply]
 *
 * Examples:
 *   # Dry run with default manifest
 *   node config/sync-office-agents.js
 *
 *   # Create agents for internal staff
 *   node config/sync-office-agents.js --group=group_internal_staff --apply
 *
 *   # Create agents for a specific tenant
 *   node config/sync-office-agents.js --tenant=tenant_abc --author=admin@example.com --apply
 */

const DEFAULT_MANIFEST_PATH = path.resolve(__dirname, 'phase-one-office-agents.yaml');

function parseArgs(argv) {
  const args = {
    apply: false,
    dryRun: true,
    manifestPath: DEFAULT_MANIFEST_PATH,
    tenantId: '',
    authorEmail: '',
    groupId: '',
  };

  for (const arg of argv) {
    if (arg === '--apply') {
      args.apply = true;
      args.dryRun = false;
    } else if (arg.startsWith('--manifest=')) {
      args.manifestPath = arg.slice('--manifest='.length).trim();
    } else if (arg.startsWith('--tenant=')) {
      args.tenantId = arg.slice('--tenant='.length).trim();
    } else if (arg.startsWith('--author=')) {
      args.authorEmail = arg.slice('--author='.length).trim();
    } else if (arg.startsWith('--group=')) {
      args.groupId = arg.slice('--group='.length).trim();
    } else if (arg === '--help') {
      printUsage();
      process.exit(0);
    }
  }

  return args;
}

function printUsage() {
  console.log(`
Synchronize Office Assistant and specialist agents from YAML manifest.

Usage: node config/sync-office-agents.js [options]

Options:
  --manifest=<path>     Path to YAML manifest (default: config/phase-one-office-agents.yaml)
  --tenant=<id>         Tenant ID (omit for platform-wide agents)
  --author=<email>      Owner email (defaults to first platform ADMIN)
  --group=<id>          Group ID to grant AGENT_VIEWER (for delegation)
  --apply               Create/update agents (default: dry run only)
  --help                Show this message

Examples:
  # Dry run
  node config/sync-office-agents.js

  # Create for internal staff group
  node config/sync-office-agents.js --group=group_internal_staff --apply

  # Create for a tenant
  node config/sync-office-agents.js --tenant=tenant_xyz --author=admin@bdren.net.bd --apply
  `);
}

function loadManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Manifest not found: ${manifestPath}`);
  }

  const content = fs.readFileSync(manifestPath, 'utf8');
  const manifest = yaml.load(content);

  if (!manifest.master || !manifest.specialists || !Array.isArray(manifest.specialists)) {
    throw new Error('Invalid manifest: must have master and specialists array');
  }

  return manifest;
}

async function resolveAuthor(authorEmail) {
  if (authorEmail) {
    const user = await runAsSystem(() => db.findUser({ email: authorEmail }, '_id email role'));
    if (!user) {
      throw new Error(`No user found with email ${authorEmail}`);
    }
    return user;
  }

  const admins = await runAsSystem(() =>
    db.findUsers({ role: SystemRoles.ADMIN }, '_id email role', { limit: 1 }),
  );
  if (!admins.length) {
    throw new Error('No ADMIN user found — pass --author=<email> to choose an owner explicitly.');
  }
  return admins[0];
}

async function createOrUpdateAgent(agentDef, author, dryRun) {
  const { id, name, provider, model, ...config } = agentDef;

  // Check if agent exists
  const existing = await runAsSystem(() =>
    mongoose.models.Agent.findOne({ id }).lean().exec(),
  );

  if (existing && !dryRun) {
    // Update existing agent
    console.log(`[update] "${name}" (${id})`);
    await runAsSystem(async () => {
      await Agent.updateOne(
        { id },
        {
          $set: {
            name,
            description: config.description,
            instructions: config.instructions,
            provider,
            model,
            model_parameters: config.model_parameters || {},
            tools: config.tools || [],
            orchestrationOnly: config.orchestrationOnly ?? false,
            subagents: config.subagents,
          },
        },
      ).exec();
    });
    return existing;
  }

  if (existing) {
    console.log(`[skip] "${name}" (${id}) already exists`);
    return existing;
  }

  const agentId = `agent_${nanoid()}`;
  console.log(`[create] "${name}" (${id})`);

  if (dryRun) {
    return { _id: 'dryrun_' + agentId, id, name };
  }

  const agent = await runAsSystem(() =>
    db.createAgent({
      id,
      name,
      description: config.description,
      instructions: config.instructions,
      provider,
      model,
      model_parameters: config.model_parameters || {},
      tools: config.tools || [],
      orchestrationOnly: config.orchestrationOnly ?? false,
      subagents: config.subagents,
      author: author._id,
    }),
  );

  return agent;
}

async function grantAgentPermissions(agent, author, groupId, tenantId, dryRun) {
  if (dryRun) return;

  const grants = [];

  // Grant OWNER to author
  grants.push(
    grantPermission({
      principalType: PrincipalType.USER,
      principalId: author._id,
      resourceType: ResourceType.AGENT,
      resourceId: agent._id,
      accessRoleId: AccessRoleIds.AGENT_OWNER,
      grantedBy: author._id,
      tenantId: tenantId || undefined,
    }),
  );

  // Grant REMOTE_AGENT_OWNER to author (for subagent execution)
  grants.push(
    grantPermission({
      principalType: PrincipalType.USER,
      principalId: author._id,
      resourceType: ResourceType.REMOTE_AGENT,
      resourceId: agent._id,
      accessRoleId: AccessRoleIds.REMOTE_AGENT_OWNER,
      grantedBy: author._id,
      tenantId: tenantId || undefined,
    }),
  );

  // Grant VIEWER to group (if provided)
  if (groupId) {
    grants.push(
      grantPermission({
        principalType: PrincipalType.GROUP,
        principalId: groupId,
        resourceType: ResourceType.AGENT,
        resourceId: agent._id,
        accessRoleId: AccessRoleIds.AGENT_VIEWER,
        grantedBy: author._id,
        tenantId: tenantId || undefined,
      }),
    );

    // Also grant group REMOTE_AGENT_VIEWER for specialists
    grants.push(
      grantPermission({
        principalType: PrincipalType.GROUP,
        principalId: groupId,
        resourceType: ResourceType.REMOTE_AGENT,
        resourceId: agent._id,
        accessRoleId: AccessRoleIds.REMOTE_AGENT_VIEWER,
        grantedBy: author._id,
        tenantId: tenantId || undefined,
      }),
    );
  }

  await Promise.all(grants);
}

async function setupSubagentConnections(master, specialists, dryRun) {
  if (dryRun) return;

  const edges = specialists.map((spec) => ({
    from: master.id,
    to: spec.id,
    edgeType: 'handoff',
    description: spec.description,
  }));

  await runAsSystem(() =>
    Agent.updateOne({ _id: master._id }, { $set: { edges } }).exec(),
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log('\n=== Office Agent Synchronization ===');
  console.log(`MODE: ${args.apply ? 'APPLY' : 'DRY RUN'} (re-run with --apply to create/update agents)`);
  console.log(`Manifest: ${args.manifestPath}`);
  console.log('');

  try {
    await connect();

    const manifest = loadManifest(args.manifestPath);
    const author = await resolveAuthor(args.authorEmail);

    console.log(`Author: ${author.email}`);
    if (args.tenantId) console.log(`Tenant: ${args.tenantId}`);
    if (args.groupId) console.log(`Group:  ${args.groupId}`);
    console.log('');

    // Create/update master agent
    console.log('--- Master Agent ---');
    const master = await createOrUpdateAgent(
      manifest.master,
      author,
      args.dryRun,
    );

    // Create/update specialist agents
    console.log('\n--- Specialist Agents ---');
    const specialists = [];
    for (const spec of manifest.specialists) {
      const agent = await createOrUpdateAgent(spec, author, args.dryRun);
      specialists.push(agent);
    }

    // Wire the master's subagent handoff edges to the specialists
    if (!args.dryRun) {
      console.log('\n--- Subagent Connections ---');
      await setupSubagentConnections(master, specialists, args.dryRun);
      console.log(`[wire] ${specialists.length} handoff edge(s) from master to specialists`);
    }

    // Grant permissions
    if (!args.dryRun) {
      console.log('\n--- Permissions ---');
      await grantAgentPermissions(master, author, args.groupId, args.tenantId, args.dryRun);
      console.log(`[grant] OWNER to ${author.email}`);
      if (args.groupId) console.log(`[grant] VIEWER to group ${args.groupId}`);

      for (const spec of specialists) {
        await grantAgentPermissions(spec, author, args.groupId, args.tenantId, args.dryRun);
      }

      // Scope to tenant if provided
      if (args.tenantId) {
        console.log('\n--- Tenant Scoping ---');
        await runAsSystem(async () => {
          const allAgents = [master, ...specialists];
          for (const agent of allAgents) {
            await Agent.updateOne(
              { _id: agent._id },
              { $set: { tenantId: args.tenantId } },
            ).exec();
            await AclEntry.updateMany(
              { resourceId: agent._id, tenantId: { $exists: false } },
              { $set: { tenantId: args.tenantId } },
            ).exec();
          }
        });
        console.log(`[scope] All agents scoped to tenant ${args.tenantId}`);
      }

      console.log('\n✓ Synchronization complete');
    } else {
      console.log('\n✓ Dry run complete. Re-run with --apply to create agents.');
    }
  } catch (error) {
    console.error('\n✗ Synchronization failed:');
    console.error(error.message ?? error);
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
