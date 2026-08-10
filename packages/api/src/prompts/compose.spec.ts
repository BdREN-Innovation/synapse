import { composePrompt } from './compose';

describe('composePrompt', () => {
  it('trims, skips empty layers, preserves order, and reports included layers', () => {
    expect(
      composePrompt([
        { id: 'mandatory_policy', content: '  policy  ' },
        { id: 'general_role', content: '' },
        { id: 'tools', content: '\n tools \n' },
      ]),
    ).toEqual({
      content: 'policy\n\ntools',
      includedLayers: ['mandatory_policy', 'tools'],
    });
  });

  it('returns an empty composition for empty content', () => {
    expect(composePrompt([{ id: 'runtime' }, { id: 'files', content: '  ' }])).toEqual({
      content: '',
      includedLayers: [],
    });
  });
});
