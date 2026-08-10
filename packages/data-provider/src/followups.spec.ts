import {
  extractFollowUpPrompts,
  sanitizeFollowUpPrompts,
  FOLLOW_UP_PROMPT_MARKER,
} from './followups';

describe('follow-up prompt helpers', () => {
  it('accepts exactly three concise distinct prompts', () => {
    expect(sanitizeFollowUpPrompts(['One?', 'Two?', 'Three?'])).toEqual(['One?', 'Two?', 'Three?']);
    expect(sanitizeFollowUpPrompts(['One?', 'one?', 'Three?'])).toBeUndefined();
    expect(sanitizeFollowUpPrompts(['One?', 'Two?'])).toBeUndefined();
  });

  it('removes a valid machine trailer from visible text', () => {
    const result = extractFollowUpPrompts(
      `Answer text\n\n${FOLLOW_UP_PROMPT_MARKER}["One?","Two?","Three?"] -->`,
    );
    expect(result).toEqual({
      text: 'Answer text',
      followUpPrompts: ['One?', 'Two?', 'Three?'],
    });
  });

  it('keeps malformed trailers visible and does not create prompts', () => {
    const text = `Answer\n${FOLLOW_UP_PROMPT_MARKER}["Only one"] -->`;
    expect(extractFollowUpPrompts(text)).toEqual({ text });
  });
});
