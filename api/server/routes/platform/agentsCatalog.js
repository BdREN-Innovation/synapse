const express = require('express');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { requireJwtAuth } = require('~/server/middleware');
const requirePlatformSuperadmin = require('~/server/middleware/platformAdmin');
const db = require('~/models');
const { applyAgentSync, previewAgentSync } = require('@librechat/api');
const { invalidateConfigCaches } = require('~/server/services/Config');
const { grantPermission, hasPublicPermission } = require('~/server/services/PermissionService');
const { AccessRoleIds, PrincipalType, ResourceType, PermissionBits } = require('librechat-data-provider');

const router = express.Router();
router.use(requireJwtAuth, requirePlatformSuperadmin);

function toCatalogAgent(agent, published = false) {
  return {
    _id: agent._id?.toString(),
    id: agent.id,
    name: agent.name,
    description: agent.description,
    instructions: agent.instructions,
    provider: agent.provider,
    model: agent.model,
    model_parameters: agent.model_parameters || {},
    tools: agent.tools || [],
    capabilities: agent.capabilities || [],
    icon: agent.icon,
    displayOrder: agent.displayOrder || 0,
    conversation_starters: agent.conversation_starters,
    tool_kwargs: agent.tool_kwargs,
    actions: agent.actions,
    artifacts: agent.artifacts,
    access_level: agent.access_level,
    recursion_limit: agent.recursion_limit,
    hide_sequential_outputs: agent.hide_sequential_outputs,
    end_after_tools: agent.end_after_tools,
    stateful_code_sessions: agent.stateful_code_sessions,
    tool_resources: agent.tool_resources,
    tool_options: agent.tool_options,
    memory_scope: agent.memory_scope,
    category: agent.category,
    support_contact: agent.support_contact,
    orchestrationOnly: agent.orchestrationOnly === true,
    subagents: agent.subagents,
    skills_enabled: agent.skills_enabled === true,
    skills: agent.skills,
    published,
    directSelection: agent.directSelection !== false,
    edges: agent.edges,
  };
}

async function toCatalogAgents(agents) {
  return Promise.all(agents.map(async (agent) => ({
    ...toCatalogAgent(agent),
    published: await hasPublicPermission({
      resourceType: ResourceType.AGENT,
      resourceId: agent._id,
      requiredPermissions: PermissionBits.VIEW,
    }),
  })));
}

function toAgentWrite(agent) {
  const { _id, published: _published, edges: _edges, ...write } = agent;
  return write;
}

async function setPublished(agent, published, actorId) {
  if (!agent?._id) return;
  if (published) {
    await grantPermission({
      principalType: PrincipalType.PUBLIC,
      resourceType: ResourceType.AGENT,
      resourceId: agent._id,
      accessRoleId: AccessRoleIds.AGENT_VIEWER,
      grantedBy: actorId,
    });
    return;
  }
  await db.deleteAclEntries({
    principalType: PrincipalType.PUBLIC,
    resourceType: ResourceType.AGENT,
    resourceId: agent._id,
  });
}

function manifestFromBody(body) {
  return { master: body.master, specialists: body.specialists || [] };
}

function loadOfficeManifest() {
  const manifestPath = path.resolve(__dirname, '../../../../config/phase-one-office-agents.yaml');
  const manifest = manifestFromBody(yaml.load(fs.readFileSync(manifestPath, 'utf8')));
  // Phase-one defaults intentionally publish every office agent and allow direct selection
  // for specialists while retaining the master's handoff edges.
  return {
    master: { ...manifest.master, published: true, directSelection: true },
    specialists: manifest.specialists.map((agent) => ({ ...agent, published: true, directSelection: true })),
  };
}

router.get('/', async (_req, res) => {
  const agents = await db.getAgents({});
  return res.json({ agents: await toCatalogAgents(agents) });
});

router.get('/office-manifest', (_req, res, next) => {
  try {
    return res.json(loadOfficeManifest());
  } catch (error) {
    return next(error);
  }
});

router.post('/preview', async (req, res) => {
  const existing = await db.getAgents({});
  return res.json(previewAgentSync(manifestFromBody(req.body || {}), await toCatalogAgents(existing)));
});

router.patch('/:id', async (req, res, next) => {
  try {
    const current = await db.getAgent({ id: req.params.id });
    if (!current) return res.status(404).json({ error: 'Agent not found' });
    const allowed = [
      'name', 'description', 'instructions', 'provider', 'model', 'model_parameters', 'tools',
      'capabilities', 'icon', 'displayOrder', 'conversation_starters', 'tool_kwargs', 'actions',
      'artifacts', 'access_level', 'recursion_limit', 'hide_sequential_outputs', 'end_after_tools',
      'stateful_code_sessions', 'tool_resources', 'tool_options', 'memory_scope', 'category',
      'support_contact', 'orchestrationOnly', 'directSelection', 'subagents', 'skills_enabled', 'skills',
    ];
    const patch = Object.fromEntries(Object.entries(req.body || {}).filter(([key]) => allowed.includes(key)));
    if (Object.hasOwn(patch, 'id') || Object.hasOwn(patch, '_id')) {
      return res.status(400).json({ error: 'Stable agent id cannot be changed' });
    }
    const updated = await db.updateAgent({ id: req.params.id }, patch, { updatingUserId: req.user._id });
    if (Object.hasOwn(req.body || {}, 'published')) {
      await setPublished(updated || current, req.body.published === true, req.user._id);
    }
    const published = await hasPublicPermission({
      resourceType: ResourceType.AGENT,
      resourceId: (updated || current)._id,
      requiredPermissions: PermissionBits.VIEW,
    });
    return res.json({ agent: toCatalogAgent(updated || current, published) });
  } catch (error) {
    return next(error);
  }
});

router.post('/apply', async (req, res, next) => {
  try {
    const result = await applyAgentSync(manifestFromBody(req.body || {}), {
      list: async () => toCatalogAgents(await db.getAgents({})),
      create: async (agent) => toCatalogAgent(await db.createAgent({ ...toAgentWrite(agent), author: req.user._id })),
      update: async (id, patch) => toCatalogAgent(await db.updateAgent({ id }, toAgentWrite(patch), { updatingUserId: req.user._id })),
      setEdges: async (id, edges) => { await db.updateAgent({ id }, { edges }, { updatingUserId: req.user._id }); },
      invalidate: async () => invalidateConfigCaches(),
      audit: async ({ operation, id, changedFields }) => db.recordAuditEntry({
        category: 'platform',
        action: 'platform.agent_catalog_synced',
        actor: { type: 'user', id: req.user?._id?.toString(), name: req.user?.name || req.user?.email || 'platform-superadmin' },
        target: { type: 'agent', id },
        metadata: { operation, changedFields: changedFields || [] },
        outcome: 'success',
        severity: 'info',
      }, { failClosed: true }),
    });
    if (!result.valid) return res.status(400).json(result);
    const refreshed = await toCatalogAgents(await db.getAgents({}));
    const desired = [result.manifest.master, ...result.manifest.specialists];
    for (const agent of desired) {
      const persisted = refreshed.find((candidate) => candidate.id === agent.id);
      await setPublished(persisted, agent.published, req.user._id);
    }
    return res.json(result);
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
