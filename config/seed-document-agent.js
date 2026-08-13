const path = require('path');
require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });

const mongoose = require('mongoose');
const { nanoid } = require('nanoid');
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
 * Recreates the Document Assistant agent.
 *
 * Agents are database records, not configuration, so a fresh environment starts
 * with none — which is why the agent existed only in production and local
 * development had nothing to test document generation against. Running this
 * gives any environment the same agent.
 *
 * Two details are load-bearing and easy to lose if the agent is recreated by
 * hand through the UI:
 *
 * - `useResponsesApi` is required. OpenAI reasoning models reject
 *   `reasoning_effort` together with function tools on `/v1/chat/completions`,
 *   and the agent needs `execute_code` to produce real files.
 * - Queries made in tenant context have `tenantId` injected into their filter,
 *   so an agent created without a tenant is invisible to that tenant's members.
 *   The tenant is therefore stamped on afterwards rather than by creating inside
 *   tenant context: granting a permission resolves the access role by name, and
 *   the access roles are platform-level records with no tenant of their own, so
 *   the injected filter hides them and every grant fails.
 *
 * Dry run unless `--apply` is passed.
 */

const AGENT_NAME = 'Document Assistant';

const AGENT = {
  name: AGENT_NAME,
  description:
    'Creates Word, Excel, PowerPoint and PDF files. Runs code in the sandbox, so it returns real downloadable documents rather than text to copy.',
  instructions:
    'You produce real files. When the user asks for a document, spreadsheet, presentation or PDF, use the code interpreter to generate the actual file and return it for download. python-docx, openpyxl, python-pptx, reportlab and pandas are available. Never paste document content into the chat as a substitute for producing the file.',
  provider: 'openAI',
  model: 'gpt-5.6-luna',
  model_parameters: { useResponsesApi: true },
  tools: ['execute_code'],
};

function parseArgs(argv) {
  const args = { apply: false, tenantId: '', authorEmail: '', model: AGENT.model, public: true };

  for (const arg of argv) {
    if (arg === '--apply') {
      args.apply = true;
    } else if (arg === '--no-public') {
      args.public = false;
    } else if (arg.startsWith('--tenant=')) {
      args.tenantId = arg.slice('--tenant='.length).trim();
    } else if (arg.startsWith('--author=')) {
      args.authorEmail = arg.slice('--author='.length).trim();
    } else if (arg.startsWith('--model=')) {
      args.model = arg.slice('--model='.length).trim();
    }
  }

  return args;
}

function printUsage() {
  console.log(
    'Usage: npm run node -- config/seed-document-agent.js [--tenant=<id>] [--author=<email>] [--model=<name>] [--no-public] [--apply]',
  );
  console.log('');
  console.log('  --tenant=<id>     tenant the agent belongs to (omit for a platform-wide agent)');
  console.log('  --author=<email>  owner; defaults to the first platform ADMIN');
  console.log(`  --model=<name>    model to run (default ${AGENT.model})`);
  console.log('  --no-public       skip the public viewer grant');
  console.log('  --apply           create it (default is a dry run)');
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

async function main() {
  if (process.argv.includes('--help')) {
    printUsage();
    return;
  }

  const args = parseArgs(process.argv.slice(2));
  await connect();

  console.log(args.apply ? 'MODE: APPLY (writing changes)' : 'MODE: DRY RUN (no changes written)');

  const existing = await runAsSystem(() =>
    mongoose.models.Agent.findOne({ name: AGENT_NAME }).lean().exec(),
  );
  if (existing) {
    console.log(
      `[ok] "${AGENT_NAME}" already exists (${existing.id}, tenant=${existing.tenantId ?? '-'}). Nothing to do.`,
    );
    return;
  }

  const author = await resolveAuthor(args.authorEmail);
  const agentId = `agent_${nanoid()}`;

  console.log(`[create] "${AGENT_NAME}" (${agentId})`);
  console.log(`         owner   ${author.email}`);
  console.log(`         model   ${args.model} (useResponsesApi)`);
  console.log(`         tenant  ${args.tenantId || '(none — platform-wide)'}`);
  console.log(`         public  ${args.public ? 'yes — every member may use it' : 'no'}`);

  if (!args.apply) {
    console.log('');
    console.log('Dry run only. Re-run with --apply to create the agent.');
    return;
  }

  const create = async () => {
    const agent = await db.createAgent({
      ...AGENT,
      model: args.model,
      id: agentId,
      author: author._id,
    });

    await Promise.all([
      grantPermission({
        principalType: PrincipalType.USER,
        principalId: author._id,
        resourceType: ResourceType.AGENT,
        resourceId: agent._id,
        accessRoleId: AccessRoleIds.AGENT_OWNER,
        grantedBy: author._id,
      }),
      grantPermission({
        principalType: PrincipalType.USER,
        principalId: author._id,
        resourceType: ResourceType.REMOTE_AGENT,
        resourceId: agent._id,
        accessRoleId: AccessRoleIds.REMOTE_AGENT_OWNER,
        grantedBy: author._id,
      }),
    ]);

    if (args.public) {
      await grantPermission({
        principalType: PrincipalType.PUBLIC,
        principalId: null,
        resourceType: ResourceType.AGENT,
        resourceId: agent._id,
        accessRoleId: AccessRoleIds.AGENT_VIEWER,
        grantedBy: author._id,
      });
    }

    return agent;
  };

  let agent;
  try {
    agent = await runAsSystem(create);
  } catch (error) {
    /** An agent whose owner grant failed is invisible to everyone including its
     *  author, and would then satisfy the exists-check above and block a retry.
     *  Remove it rather than leaving that behind. */
    await runAsSystem(async () => {
      const orphan = await Agent.findOne({ id: agentId }).lean().exec();
      if (orphan) {
        await AclEntry.deleteMany({ resourceId: orphan._id }).exec();
        await Agent.deleteOne({ _id: orphan._id }).exec();
        console.error('[rolled back] removed the partially created agent');
      }
    });
    throw error;
  }

  if (args.tenantId) {
    await runAsSystem(async () => {
      await Agent.updateOne({ _id: agent._id }, { $set: { tenantId: args.tenantId } }).exec();
      await AclEntry.updateMany(
        { resourceId: agent._id, tenantId: { $exists: false } },
        { $set: { tenantId: args.tenantId } },
      ).exec();
    });
  }

  const grants = await runAsSystem(() => AclEntry.countDocuments({ resourceId: agent._id }).exec());
  console.log(`[applied] created ${agent.id} with ${grants} grant(s)`);
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((error) => {
    console.error(error.message ?? error);
    process.exit(1);
  });
