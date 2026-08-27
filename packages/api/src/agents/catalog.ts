import { z } from 'zod';

const agentCapabilityValues = [
  'hide_sequential_outputs', 'programmatic_tools', 'end_after_tools', 'deferred_tools',
  'execute_code', 'stateful_code_sessions', 'file_search', 'web_search', 'artifacts',
  'subagents', 'actions', 'context', 'skills', 'memory', 'ask_user_question', 'tools',
  'chain', 'ocr', 'run_in_background', 'tool_intents',
] as const;

/** Declarative agent manifest accepted by the catalog synchronizer. */
export const agentManifestEntrySchema: z.ZodTypeAny = z
  .object({
    id: z.string().trim().min(1).max(128),
    name: z.string().trim().min(1).max(200),
    description: z.string().max(20_000).optional(),
    instructions: z.string().max(100_000).optional(),
    provider: z.string().trim().min(1).max(100),
    model: z.string().trim().min(1).max(200),
    model_parameters: z.record(z.unknown()).default({}),
    tools: z.array(z.string().trim().min(1)).default([]),
    capabilities: z.array(z.enum(agentCapabilityValues)).default([]),
    icon: z.string().trim().max(500).optional(),
    displayOrder: z.number().int().min(0).default(0),
    conversation_starters: z.array(z.string().max(500)).optional(),
    tool_kwargs: z.array(z.unknown()).optional(),
    actions: z.array(z.string().trim().min(1)).optional(),
    artifacts: z.string().optional(),
    access_level: z.number().int().optional(),
    recursion_limit: z.number().int().positive().optional(),
    hide_sequential_outputs: z.boolean().optional(),
    end_after_tools: z.boolean().optional(),
    stateful_code_sessions: z.boolean().optional(),
    tool_resources: z.record(z.unknown()).optional(),
    tool_options: z.record(z.unknown()).optional(),
    memory_scope: z.enum(['user', 'agent']).optional(),
    category: z.string().trim().max(100).optional(),
    support_contact: z.record(z.string()).optional(),
    orchestrationOnly: z.boolean().default(false),
    subagents: z.record(z.unknown()).optional(),
    skills_enabled: z.boolean().default(false),
    skills: z.array(z.string().trim().min(1)).optional(),
    published: z.boolean().default(false),
    directSelection: z.boolean().default(true),
  })
  .strict();

export const agentManifestSchema: z.ZodTypeAny = z
  .object({
    master: agentManifestEntrySchema,
    specialists: z.array(agentManifestEntrySchema).default([]),
  })
  .strict();

export type AgentManifestEntry = z.infer<typeof agentManifestEntrySchema>;
export type AgentManifest = z.infer<typeof agentManifestSchema>;

export type CatalogAgent = AgentManifestEntry & {
  _id?: string;
  edges?: Array<{ from: string; to: string; edgeType: 'handoff'; description?: string }>;
};

export type SyncOperation = 'create' | 'update' | 'unchanged' | 'invalid';
export type SyncPreview = {
  valid: boolean;
  operations: Array<{ id: string; operation: SyncOperation; changedFields: string[]; error?: string }>;
  manifest: AgentManifest | null;
};

export type CatalogDeps = {
  list: () => Promise<CatalogAgent[]>;
  create: (agent: CatalogAgent) => Promise<CatalogAgent>;
  update: (id: string, patch: Partial<CatalogAgent>) => Promise<CatalogAgent>;
  setEdges: (id: string, edges: CatalogAgent['edges']) => Promise<void>;
  invalidate: () => Promise<void>;
  audit?: (event: { operation: string; id?: string; changedFields?: string[] }) => Promise<void>;
};

function comparable(agent: CatalogAgent): Record<string, unknown> {
  const { _id, edges, ...value } = agent;
  return value;
}

function changedFields(current: CatalogAgent, desired: CatalogAgent): string[] {
  const fields = new Set([...Object.keys(comparable(current)), ...Object.keys(comparable(desired))]);
  return [...fields].filter(
    (field) => JSON.stringify(comparable(current)[field]) !== JSON.stringify(comparable(desired)[field]),
  );
}

function manifestAgents(manifest: AgentManifest): AgentManifestEntry[] {
  return [manifest.master, ...manifest.specialists];
}

function validateRelationships(manifest: AgentManifest): string[] {
  const agents = manifestAgents(manifest);
  const ids = new Set<string>();
  const errors: string[] = [];
  for (const agent of agents) {
    if (ids.has(agent.id)) errors.push(`Duplicate agent id: ${agent.id}`);
    ids.add(agent.id);
  }
  if (manifest.master.orchestrationOnly) errors.push('master must be selectable');
  return errors;
}

export function previewAgentSync(input: unknown, existing: CatalogAgent[]): SyncPreview {
  const parsed = agentManifestSchema.safeParse(input);
  if (!parsed.success) {
    return { valid: false, operations: [{ id: 'manifest', operation: 'invalid', changedFields: [], error: parsed.error.message }], manifest: null };
  }
  const relationshipErrors = validateRelationships(parsed.data);
  if (relationshipErrors.length > 0) {
    return { valid: false, operations: [{ id: 'manifest', operation: 'invalid', changedFields: [], error: relationshipErrors.join('; ') }], manifest: parsed.data };
  }
  const byId = new Map(existing.map((agent) => [agent.id, agent]));
  return {
    valid: true,
    manifest: parsed.data,
    operations: manifestAgents(parsed.data).map((desired) => {
      const current = byId.get(desired.id);
      if (!current) return { id: desired.id, operation: 'create', changedFields: Object.keys(desired) };
      const fields = changedFields(current, desired as CatalogAgent);
      return { id: desired.id, operation: fields.length > 0 ? 'update' : 'unchanged', changedFields: fields };
    }),
  };
}

export async function applyAgentSync(input: unknown, deps: CatalogDeps): Promise<SyncPreview> {
  const existing = await deps.list();
  const preview = previewAgentSync(input, existing);
  if (!preview.valid || !preview.manifest) return preview;
  const byId = new Map(existing.map((agent) => [agent.id, agent]));
  const agents = new Map<string, CatalogAgent>();
  for (const desired of manifestAgents(preview.manifest)) {
    const current = byId.get(desired.id);
    const result = current
      ? await deps.update(desired.id, desired)
      : await deps.create(desired);
    agents.set(desired.id, result);
    const operation = current ? 'update' : 'create';
    await deps.audit?.({ operation, id: desired.id, changedFields: changedFields(current ?? ({} as CatalogAgent), desired as CatalogAgent) });
  }
  const edges = preview.manifest.specialists.map((specialist) => ({
    from: preview.manifest!.master.id,
    to: specialist.id,
    edgeType: 'handoff' as const,
    description: specialist.description,
  }));
  await deps.setEdges(preview.manifest.master.id, edges);
  await deps.invalidate();
  return preview;
}
