import {
  generateFileCapabilityPrompt,
  generateMandatoryPolicyPrompt,
  generateSearchCapabilityPrompt,
  generateToolCapabilityPrompt,
} from './index';

describe('conditional prompt capabilities', () => {
  it('keeps mandatory policy short and provider-neutral', () => {
    const prompt = generateMandatoryPolicyPrompt();

    expect(prompt).toContain('privacy');
    expect(prompt).toContain('Do not claim to have used');
    expect(prompt).not.toContain('search');
  });

  it('provides separate capability guidance', () => {
    expect(generateToolCapabilityPrompt()).toContain('available tools');
    expect(generateSearchCapabilityPrompt()).toContain('actually returned');
    expect(generateFileCapabilityPrompt()).toContain('source facts');
  });
});
