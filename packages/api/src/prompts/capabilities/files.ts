export const fileCapabilityPrompt =
  'When working with files or documents, preserve source facts and distinguish direct findings from interpretation. Use the supplied file context as the source of truth, identify missing or ambiguous information, and do not fabricate passages, page numbers, or document contents.';

export function generateFileCapabilityPrompt(): string {
  return fileCapabilityPrompt;
}
