export const FOLLOW_UP_PROMPTS_ENV = 'FOLLOW_UP_PROMPTS';
export const FOLLOW_UP_PROMPT_COUNT = 3;
export const FOLLOW_UP_PROMPT_MAX_LENGTH = 160;
export const FOLLOW_UP_PROMPT_MARKER = '<!-- librechat-follow-up-prompts:';

export const FOLLOW_UP_PROMPT_INSTRUCTION = `
After your answer, append exactly three concise, relevant follow-up questions that help the user continue this conversation with less typing. Keep each question under ${FOLLOW_UP_PROMPT_MAX_LENGTH} characters, make them distinct and actionable, and write them in the user's language. Put them only in this machine-readable trailer, with no extra commentary:
${FOLLOW_UP_PROMPT_MARKER}["question one","question two","question three"] -->`;

export type FollowUpPromptResult = {
  text: string;
  followUpPrompts?: string[];
};

export function sanitizeFollowUpPrompts(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length !== FOLLOW_UP_PROMPT_COUNT) {
    return undefined;
  }

  const prompts = value
    .filter((prompt): prompt is string => typeof prompt === 'string')
    .map((prompt) => prompt.trim())
    .filter((prompt) => prompt.length > 0 && prompt.length <= FOLLOW_UP_PROMPT_MAX_LENGTH);

  if (
    prompts.length !== FOLLOW_UP_PROMPT_COUNT ||
    new Set(prompts.map((p) => p.toLowerCase())).size !== prompts.length
  ) {
    return undefined;
  }

  return prompts;
}

export function extractFollowUpPrompts(text: string): FollowUpPromptResult {
  const markerIndex = text.lastIndexOf(FOLLOW_UP_PROMPT_MARKER);
  if (markerIndex < 0) {
    return { text };
  }

  const trailer = text.slice(markerIndex + FOLLOW_UP_PROMPT_MARKER.length).trim();
  const closingIndex = trailer.lastIndexOf('-->');
  if (closingIndex < 0) {
    return { text };
  }

  try {
    const prompts = sanitizeFollowUpPrompts(JSON.parse(trailer.slice(0, closingIndex).trim()));
    if (!prompts) {
      return { text };
    }
    return {
      text: text.slice(0, markerIndex).trimEnd(),
      followUpPrompts: prompts,
    };
  } catch {
    return { text };
  }
}
