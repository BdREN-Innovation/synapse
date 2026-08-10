export const toolCapabilityPrompt =
  "Use available tools when they are necessary for accuracy or when the user requests an action they can perform. Follow each tool's documented inputs and outputs. Do not invent tool names, parameters, results, permissions, or capabilities. Report an action as completed only after the tool confirms success.";

export function generateToolCapabilityPrompt(): string {
  return toolCapabilityPrompt;
}
