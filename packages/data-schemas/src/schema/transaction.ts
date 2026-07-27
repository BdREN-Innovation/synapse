import mongoose, { Schema, Document, Types } from 'mongoose';

// @ts-ignore
export interface ITransaction extends Document {
  user: Types.ObjectId;
  conversationId?: string;
  tokenType: 'prompt' | 'completion' | 'credits';
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
  createdAt?: Date;
  updatedAt?: Date;
  tenantId?: string;
}

const transactionSchema: Schema<ITransaction> = new Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      index: true,
      required: true,
    },
    conversationId: {
      type: String,
      ref: 'Conversation',
      index: true,
    },
    tokenType: {
      type: String,
      enum: ['prompt', 'completion', 'credits'],
      required: true,
    },
    model: {
      type: String,
      index: true,
    },
    modelKey: {
      type: String,
      index: true,
    },
    providerKey: {
      type: String,
      index: true,
    },
    providerModelId: {
      type: String,
    },
    context: {
      type: String,
    },
    usageKind: {
      type: String,
      index: true,
    },
    usageUnit: {
      type: String,
      enum: ['tokens', 'images', 'seconds', 'operations'],
      default: 'tokens',
    },
    requestKey: {
      type: String,
      index: true,
    },
    valueKey: {
      type: String,
    },
    rate: Number,
    rawAmount: Number,
    tokenValue: Number,
    inputTokens: { type: Number },
    writeTokens: { type: Number },
    readTokens: { type: Number },
    messageId: { type: String },
    tenantId: {
      type: String,
      index: true,
    },
  },
  {
    timestamps: true,
  },
);

transactionSchema.index({ tenantId: 1, createdAt: -1 });
transactionSchema.index({ tenantId: 1, user: 1, createdAt: -1 });
transactionSchema.index({ tenantId: 1, modelKey: 1, createdAt: -1 });
transactionSchema.index({ tenantId: 1, providerKey: 1, createdAt: -1 });

/**
 * Ledger idempotency key (P1-3). A retried usage write carries the same
 * natural key and is rejected as a duplicate, so it is recorded exactly once
 * and never double-charges the balance. Partial so it constrains only rows
 * that actually carry a `requestKey` — legacy/keyless rows are unaffected, and
 * so the index can be built without a historical de-duplication pass.
 * Before enabling in an existing deployment, run `reportDuplicateRequestKeys`
 * to confirm no live duplicates exist.
 */
transactionSchema.index(
  { tenantId: 1, requestKey: 1, tokenType: 1, valueKey: 1 },
  {
    unique: true,
    partialFilterExpression: { requestKey: { $type: 'string' } },
    name: 'transaction_idempotency_key',
  },
);

export default transactionSchema;
