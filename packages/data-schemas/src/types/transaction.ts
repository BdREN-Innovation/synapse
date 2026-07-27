export interface TransactionData {
  user: string;
  tenantId?: string;
  conversationId: string;
  tokenType: string;
  model?: string;
  modelKey?: string;
  providerKey?: string;
  providerModelId?: string;
  context?: string;
  usageKind?: string;
  usageUnit?: 'tokens' | 'images' | 'seconds' | 'operations';
  requestKey?: string;
  valueKey?: string;
  rate?: number;
  rawAmount?: number;
  tokenValue?: number;
  inputTokens?: number;
  writeTokens?: number;
  readTokens?: number;
  messageId?: string;
  inputTokenCount?: number;
  rateDetail?: Record<string, number>;
}
