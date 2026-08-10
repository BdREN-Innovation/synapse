export type PromptLayerId =
  | 'mandatory_policy'
  | 'general_role'
  | 'configured_role'
  | 'tools'
  | 'search'
  | 'files'
  | 'mcp'
  | 'artifacts'
  | 'runtime';

export interface PromptLayer {
  id: PromptLayerId;
  content?: string | null;
}

export interface ComposedPrompt {
  content: string;
  includedLayers: PromptLayerId[];
}

/** Compose stable or dynamic prompt layers while preserving their caller-defined order. */
export function composePrompt(layers: PromptLayer[]): ComposedPrompt {
  const contentParts: string[] = [];
  const includedLayers: PromptLayerId[] = [];

  for (const layer of layers) {
    const content = layer.content?.trim();
    if (!content) {
      continue;
    }
    contentParts.push(content);
    includedLayers.push(layer.id);
  }

  return {
    content: contentParts.join('\n\n'),
    includedLayers,
  };
}
