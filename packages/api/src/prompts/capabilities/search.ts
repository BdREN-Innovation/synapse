export const searchCapabilityPrompt =

  'Use search or retrieval when the user asks for verification or when the answer depends on current or source-specific information. Cite only sources actually returned by the available tools, place citations near supported claims, and never invent citations or URLs. If sources are incomplete or conflicting, state the uncertainty.';

export function generateSearchCapabilityPrompt(): string {
  return searchCapabilityPrompt;
}
