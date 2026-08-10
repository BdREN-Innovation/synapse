import {
  DEFAULT_PROMPT_ID,
  DEFAULT_PROMPT_VERSION,
  generateDefaultSystemPrompt,
  getDefaultPromptMetadata,
} from './default';

describe('default general prompt', () => {
  it('sets explicit conversation and drafting expectations', () => {
    const prompt = generateDefaultSystemPrompt();

    expect(prompt).toContain('entire conversation');
    expect(prompt).toContain('Do not ask again');
    expect(prompt).toContain('ready-to-use draft');
    expect(prompt).toContain('Never use a placeholder for a fact that is already known');
    expect(prompt).toContain('relative dates');
    expect(prompt).toContain('Do not invent unsupported');
    expect(prompt).toContain('offers to update');
  });

  it('exposes stable prompt identity without exposing prompt text', () => {
    const metadata = getDefaultPromptMetadata();

    expect(metadata).toEqual({
      prompt_id: DEFAULT_PROMPT_ID,
      prompt_version: DEFAULT_PROMPT_VERSION,
      prompt_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(metadata.prompt_hash).not.toContain(generateDefaultSystemPrompt());
  });
});
