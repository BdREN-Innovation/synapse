import { describe, expect, it, jest } from '@jest/globals';
import { applyAgentSync, previewAgentSync, type CatalogAgent } from './catalog';

const entry = (id: string, name = id): CatalogAgent => ({
  id,
  name,
  provider: 'OpenAI',
  model: 'gpt-4o',
  model_parameters: {},
  tools: [],
  orchestrationOnly: false,
  skills_enabled: false,
  published: true,
  directSelection: true,
});

describe('agent catalog synchronization', () => {
  it('previews creates, updates, and unchanged entries by stable id', () => {
    const preview = previewAgentSync(
      { master: { ...entry('master'), name: 'New master' }, specialists: [entry('new')] },
      [entry('master', 'Old master'), entry('existing')],
    );
    expect(preview.valid).toBe(true);
    expect(preview.operations).toEqual([
      expect.objectContaining({ id: 'master', operation: 'update' }),
      expect.objectContaining({ id: 'new', operation: 'create' }),
    ]);
  });

  it('rejects duplicate ids without mutating', () => {
    const preview = previewAgentSync({ master: entry('same'), specialists: [entry('same')] }, []);
    expect(preview.valid).toBe(false);
    expect(preview.operations[0].error).toContain('Duplicate agent id');
  });

  it('applies agents, wires handoffs, audits, and invalidates once', async () => {
    const created = jest.fn(async (agent: CatalogAgent) => agent);
    const updated = jest.fn(async (id: string, patch: Partial<CatalogAgent>) => ({ ...entry(id), ...patch }));
    const setEdges = jest.fn(async () => undefined);
    const invalidate = jest.fn(async () => undefined);
    const audit = jest.fn(async () => undefined);
    await applyAgentSync(
      { master: entry('master'), specialists: [entry('specialist')] },
      { list: async () => [], create: created, update: updated, setEdges, invalidate, audit },
    );
    expect(created).toHaveBeenCalledTimes(2);
    expect(setEdges).toHaveBeenCalledWith('master', [expect.objectContaining({ to: 'specialist' })]);
    expect(audit).toHaveBeenCalledTimes(2);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });
});
