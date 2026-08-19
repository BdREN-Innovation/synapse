import type { FilterQuery, Model, Types } from 'mongoose';
import type { IBalance, IBalanceUpdate, TransactionData } from '~/types';
import type { ITransaction } from '~/schema/transaction';
import { inferProviderKey } from '~/utils/transactions';
import { getTenantId } from '~/config/tenantContext';
import logger from '~/config/winston';

const cancelRate = 1.15;

/** MongoDB duplicate-key error code, raised when the ledger idempotency index
 * rejects a replayed usage write. */
const DUPLICATE_KEY_ERROR_CODE = 11000;

interface WriteErrorLike {
  index?: number;
  code?: number;
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: number }).code === DUPLICATE_KEY_ERROR_CODE
  );
}

type MultiplierParams = {
  model?: string;
  valueKey?: string;
  tokenType?: 'prompt' | 'completion';
  inputTokenCount?: number;
  endpointTokenConfig?: Record<string, Record<string, number>>;
};

type NormalizeModelFn = (model: string, endpoint?: string) => string | undefined;

type CacheMultiplierParams = {
  cacheType?: 'write' | 'read';
  model?: string;
  endpointTokenConfig?: Record<string, Record<string, number>>;
  inputTokenCount?: number;
};

/** Fields read/written by the internal token value calculators */
interface InternalTxDoc {
  valueKey?: string;
  tokenType?: 'prompt' | 'completion' | 'credits';
  model?: string;
  endpointTokenConfig?: Record<string, Record<string, number>> | null;
  inputTokenCount?: number;
  rawAmount?: number;
  context?: string;
  rate?: number;
  tokenValue?: number;
  rateDetail?: Record<string, number>;
  inputTokens?: number;
  writeTokens?: number;
  readTokens?: number;
}

/** Input data for creating a transaction */
export interface TxData {
  user: string | Types.ObjectId;
  conversationId?: string;
  messageId?: string;
  model?: string;
  modelKey?: string;
  providerKey?: string;
  providerModelId?: string;
  context?: string;
  usageKind?: string;
  usageUnit?: 'tokens' | 'images' | 'seconds' | 'operations';
  requestKey?: string;
  tokenType?: 'prompt' | 'completion' | 'credits';
  rawAmount?: number;
  valueKey?: string;
  endpointTokenConfig?: Record<string, Record<string, number>> | null;
  inputTokenCount?: number;
  inputTokens?: number;
  writeTokens?: number;
  readTokens?: number;
  /**
   * Institution tenant this usage belongs to. When provided, it is written
   * explicitly onto the ledger row instead of relying on ambient
   * AsyncLocalStorage context, so usage recorded outside the request scope
   * (workers, event handlers, deferred writes) still attributes correctly
   * (P1-3).
   */
  tenantId?: string;
  requireTenant?: boolean;
  balance?: { enabled?: boolean };
  transactions?: { enabled?: boolean };
}

/** One group of transactions sharing an idempotency natural key more than
 * once — used to audit for historical duplicates before enabling the unique
 * ledger index (P1-3). */
export interface DuplicateRequestKeyGroup {
  tenantId: string | null;
  requestKey: string;
  tokenType: string;
  valueKey: string | null;
  count: number;
  ids: string[];
}

/** Return value from a successful transaction that also updates the balance */
export interface TransactionResult {
  rate: number;
  user: string;
  balance: number;
  prompt?: number;
  completion?: number;
  credits?: number;
}

export function createTransactionMethods(
  mongoose: typeof import('mongoose'),
  txMethods: {
    getMultiplier: (params: MultiplierParams) => number;
    getCacheMultiplier: (params: CacheMultiplierParams) => number | null;
    matchModelName?: NormalizeModelFn;
  },
): {
  updateBalance: ({
    user,
    incrementValue,
    setValues,
  }: {
    user: string;
    incrementValue: number;
    setValues?: IBalanceUpdate;
  }) => Promise<IBalance>;
  bulkInsertTransactions: (docs: TransactionData[]) => Promise<{ insertedIndexes: number[] }>;
  findBalanceByUser: (user: string) => Promise<IBalance | null>;
  upsertBalanceFields: (user: string, fields: IBalanceUpdate) => Promise<IBalance | null>;
  getTransactions: (filter: FilterQuery<ITransaction>) => Promise<ITransaction[]>;
  deleteTransactions: (
    filter: FilterQuery<ITransaction>,
  ) => Promise<import('mongodb').DeleteResult>;
  deleteBalances: (filter: FilterQuery<IBalance>) => Promise<import('mongodb').DeleteResult>;
  createTransaction: (_txData: TxData) => Promise<TransactionResult | undefined>;
  createAutoRefillTransaction: (txData: TxData) => Promise<
    | {
        rate: number;
        user: string;
        balance: number;
        transaction: ITransaction;
      }
    | undefined
  >;
  createStructuredTransaction: (_txData: TxData) => Promise<TransactionResult | undefined>;
  reportDuplicateRequestKeys: (
    filter?: FilterQuery<ITransaction>,
  ) => Promise<DuplicateRequestKeyGroup[]>;
} {
  function normalizeUsageMetadata(txData: TxData): Partial<TxData> {
    const rawModel =
      typeof txData.model === 'string' && txData.model.trim() ? txData.model.trim() : undefined;
    const providerKey = inferProviderKey(rawModel, txData.providerKey);
    const providerModelId =
      typeof txData.providerModelId === 'string' && txData.providerModelId.trim()
        ? txData.providerModelId.trim()
        : rawModel;
    const modelCandidate =
      providerKey && rawModel?.startsWith(`${providerKey}/`)
        ? rawModel.slice(providerKey.length + 1)
        : rawModel;
    const modelKey =
      (modelCandidate && txMethods.matchModelName?.(modelCandidate)) ||
      (rawModel && txMethods.matchModelName?.(rawModel)) ||
      modelCandidate ||
      rawModel;
    const usageKind =
      typeof txData.usageKind === 'string' && txData.usageKind.trim()
        ? txData.usageKind.trim()
        : txData.context;
    const usageUnit = txData.usageUnit ?? 'tokens';
    /**
     * The requestKey is the idempotency key for the ledger (P1-3). An explicit
     * key supplied by the caller (e.g. the agents path, which includes a
     * per-call sequence) is trusted as unique-per-event. Otherwise a key is
     * derived ONLY when both conversationId and messageId are present, so it is
     * stable across retries of the same message yet still distinct per message.
     * When messageId is absent the key is intentionally left undefined: a
     * coarser conversation-level key would collapse genuinely distinct usage
     * events and must never gate the unique index.
     */
    const explicitRequestKey =
      typeof txData.requestKey === 'string' && txData.requestKey.trim()
        ? txData.requestKey.trim()
        : undefined;
    const derivedRequestKey =
      txData.conversationId && txData.messageId
        ? [txData.conversationId, txData.messageId, usageKind, providerKey, modelKey]
            .filter(Boolean)
            .join(':')
        : undefined;
    const requestKey = explicitRequestKey ?? derivedRequestKey;

    return {
      providerKey,
      providerModelId,
      modelKey,
      usageKind,
      usageUnit,
      requestKey,
    };
  }

  function calculateTokenValue(txn: InternalTxDoc) {
    const { valueKey, tokenType, model, endpointTokenConfig, inputTokenCount } = txn;
    const multiplier = Math.abs(
      txMethods.getMultiplier({
        valueKey,
        tokenType: tokenType as 'prompt' | 'completion' | undefined,
        model,
        endpointTokenConfig: endpointTokenConfig ?? undefined,
        inputTokenCount,
      }),
    );
    txn.rate = multiplier;
    txn.tokenValue = (txn.rawAmount ?? 0) * multiplier;
    if (txn.context && txn.tokenType === 'completion' && txn.context === 'incomplete') {
      txn.tokenValue = Math.ceil((txn.tokenValue ?? 0) * cancelRate);
      txn.rate = (txn.rate ?? 0) * cancelRate;
    }
  }

  /** Calculate token value for structured tokens */
  function calculateStructuredTokenValue(txn: InternalTxDoc) {
    if (!txn.tokenType) {
      txn.tokenValue = txn.rawAmount;
      return;
    }

    const { model, endpointTokenConfig, inputTokenCount } = txn;
    const etConfig = endpointTokenConfig ?? undefined;

    if (txn.tokenType === 'prompt') {
      const inputMultiplier = txMethods.getMultiplier({
        tokenType: 'prompt',
        model,
        endpointTokenConfig: etConfig,
        inputTokenCount,
      });
      const writeMultiplier =
        txMethods.getCacheMultiplier({
          cacheType: 'write',
          model,
          endpointTokenConfig: etConfig,
          inputTokenCount,
        }) ?? inputMultiplier;
      const readMultiplier =
        txMethods.getCacheMultiplier({
          cacheType: 'read',
          model,
          endpointTokenConfig: etConfig,
          inputTokenCount,
        }) ?? inputMultiplier;

      txn.rateDetail = {
        input: inputMultiplier,
        write: writeMultiplier,
        read: readMultiplier,
      };

      const totalPromptTokens =
        Math.abs(txn.inputTokens ?? 0) +
        Math.abs(txn.writeTokens ?? 0) +
        Math.abs(txn.readTokens ?? 0);

      if (totalPromptTokens > 0) {
        txn.rate =
          (Math.abs(inputMultiplier * (txn.inputTokens ?? 0)) +
            Math.abs(writeMultiplier * (txn.writeTokens ?? 0)) +
            Math.abs(readMultiplier * (txn.readTokens ?? 0))) /
          totalPromptTokens;
      } else {
        txn.rate = Math.abs(inputMultiplier);
      }

      txn.tokenValue = -(
        Math.abs(txn.inputTokens ?? 0) * inputMultiplier +
        Math.abs(txn.writeTokens ?? 0) * writeMultiplier +
        Math.abs(txn.readTokens ?? 0) * readMultiplier
      );

      txn.rawAmount = -totalPromptTokens;
    } else if (txn.tokenType === 'completion') {
      const multiplier = txMethods.getMultiplier({
        tokenType: txn.tokenType,
        model,
        endpointTokenConfig: etConfig,
        inputTokenCount,
      });
      txn.rate = Math.abs(multiplier);
      txn.tokenValue = -Math.abs(txn.rawAmount ?? 0) * multiplier;
      txn.rawAmount = -Math.abs(txn.rawAmount ?? 0);
    }

    if (txn.context && txn.tokenType === 'completion' && txn.context === 'incomplete') {
      txn.tokenValue = Math.ceil((txn.tokenValue ?? 0) * cancelRate);
      txn.rate = (txn.rate ?? 0) * cancelRate;
      if (txn.rateDetail) {
        txn.rateDetail = Object.fromEntries(
          Object.entries(txn.rateDetail).map(([k, v]) => [k, v * cancelRate]),
        );
      }
    }
  }

  /**
   * Updates a user's token balance using optimistic concurrency control.
   * Always returns an IBalance or throws after exhausting retries.
   */
  async function updateBalance({
    user,
    incrementValue,
    setValues,
  }: {
    user: string;
    incrementValue: number;
    setValues?: IBalanceUpdate;
  }): Promise<IBalance> {
    const Balance = mongoose.models.Balance as Model<IBalance>;
    const maxRetries = 10;
    let delay = 50;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      let currentBalanceDoc: IBalance | null;
      try {
        currentBalanceDoc = await Balance.findOne({ user }).lean<IBalance>();
        const currentCredits = currentBalanceDoc ? currentBalanceDoc.tokenCredits : 0;
        const potentialNewCredits = currentCredits + incrementValue;
        const newCredits = Math.max(0, potentialNewCredits);

        const updatePayload = {
          $set: {
            tokenCredits: newCredits,
            ...(setValues ?? {}),
          },
        };

        let updatedBalance: IBalance | null = null;
        if (currentBalanceDoc) {
          updatedBalance = await Balance.findOneAndUpdate(
            { user, tokenCredits: currentCredits },
            updatePayload,
            { new: true },
          ).lean<IBalance>();

          if (updatedBalance) {
            return updatedBalance;
          }
          lastError = new Error(`Concurrency conflict for user ${user} on attempt ${attempt}.`);
        } else {
          try {
            updatedBalance = await Balance.findOneAndUpdate({ user }, updatePayload, {
              upsert: true,
              new: true,
            }).lean<IBalance>();

            if (updatedBalance) {
              return updatedBalance;
            }
            lastError = new Error(
              `Upsert race condition suspected for user ${user} on attempt ${attempt}.`,
            );
          } catch (error: unknown) {
            if (
              error instanceof Error &&
              'code' in error &&
              (error as { code: number }).code === 11000
            ) {
              lastError = error;
            } else {
              throw error;
            }
          }
        }
      } catch (error) {
        logger.error(`[updateBalance] Error during attempt ${attempt} for user ${user}:`, error);
        lastError = error instanceof Error ? error : new Error(String(error));
      }

      if (attempt < maxRetries) {
        const jitter = Math.random() * delay * 0.5;
        await new Promise((resolve) => setTimeout(resolve, delay + jitter));
        delay = Math.min(delay * 2, 2000);
      }
    }

    logger.error(
      `[updateBalance] Failed to update balance for user ${user} after ${maxRetries} attempts.`,
    );
    throw (
      lastError ??
      new Error(
        `Failed to update balance for user ${user} after maximum retries due to persistent conflicts.`,
      )
    );
  }

  /**
   * Creates an auto-refill transaction that also updates balance.
   */
  async function createAutoRefillTransaction(txData: TxData): Promise<
    | {
        rate: number;
        user: string;
        balance: number;
        transaction: ITransaction;
      }
    | undefined
  > {
    if (txData.rawAmount != null && isNaN(txData.rawAmount)) {
      return;
    }
    const Transaction = mongoose.models.Transaction;
    const transaction = new Transaction({ ...txData, ...normalizeUsageMetadata(txData) });
    transaction.endpointTokenConfig = txData.endpointTokenConfig;
    transaction.inputTokenCount = txData.inputTokenCount;
    calculateTokenValue(transaction);
    await transaction.save();

    const balanceResponse = await updateBalance({
      user: transaction.user as string,
      incrementValue: txData.rawAmount ?? 0,
      setValues: { lastRefill: new Date() },
    });
    const result = {
      rate: transaction.rate as number,
      user: transaction.user.toString() as string,
      balance: balanceResponse.tokenCredits,
      transaction,
    };
    logger.debug('[Balance.check] Auto-refill performed', result);
    return result;
  }

  /**
   * Persists a freshly-computed transaction exactly once (P1-3). A replayed
   * usage write carries the same `requestKey` natural key and is rejected by
   * the idempotency index; that replay is treated as a no-op so the balance is
   * never charged twice. `tenantId` rides along on the document (explicit from
   * `TxData` or injected from async context by the isolation plugin's
   * pre-save hook); a keyed usage write with no resolvable tenant is surfaced
   * as a warning rather than silently attributed to the null tenant.
   */
  async function persistTransactionOnce(
    transaction: ITransaction,
    requireTenant = false,
  ): Promise<{ inserted: boolean }> {
    const tenantId = transaction.tenantId ?? getTenantId();
    if (!tenantId && requireTenant) {
      throw new Error(
        '[Transaction] Billable usage requires an explicit or request-scoped tenantId',
      );
    }
    if (tenantId) {
      transaction.tenantId = tenantId;
    }

    const missingFields = tenantId
      ? [
          !transaction.user && 'user',
          !transaction.providerKey && 'providerKey',
          !transaction.modelKey && 'modelKey',
          !transaction.requestKey && 'requestKey',
        ].filter(Boolean)
      : [];
    if (missingFields.length > 0) {
      throw new Error(
        `[Transaction] Billable tenant usage is missing required metadata: ${missingFields.join(', ')}`,
      );
    }

    try {
      await transaction.save();
      return { inserted: true };
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        logger.debug('[Transaction] duplicate usage write ignored (idempotent replay)', {
          requestKey: transaction.requestKey,
        });
        return { inserted: false };
      }
      throw error;
    }
  }

  /** Balance snapshot returned for an idempotent replay, where no charge is
   * applied because the original write already settled it. */
  async function unchargedResult(transaction: ITransaction): Promise<TransactionResult> {
    const userId = transaction.user.toString();
    const current = await findBalanceByUser(userId);
    return {
      rate: transaction.rate as number,
      user: userId,
      balance: current?.tokenCredits ?? 0,
      [transaction.tokenType as string]: 0,
    } as TransactionResult;
  }

  /**
   * Creates a transaction and updates the balance.
   */
  async function createTransaction(_txData: TxData): Promise<TransactionResult | undefined> {
    const { balance, transactions, requireTenant, ...txData } = _txData;
    if (txData.rawAmount != null && isNaN(txData.rawAmount)) {
      return;
    }

    if (transactions?.enabled === false && !(txData.tenantId ?? getTenantId())) {
      return;
    }

    const Transaction = mongoose.models.Transaction;
    const transaction = new Transaction({ ...txData, ...normalizeUsageMetadata(txData) });
    transaction.endpointTokenConfig = txData.endpointTokenConfig;
    transaction.inputTokenCount = txData.inputTokenCount;
    calculateTokenValue(transaction);

    const { inserted } = await persistTransactionOnce(transaction, requireTenant);
    if (!balance?.enabled) {
      return;
    }
    if (!inserted) {
      return await unchargedResult(transaction);
    }

    const incrementValue = transaction.tokenValue as number;
    const balanceResponse = await updateBalance({
      user: transaction.user as string,
      incrementValue,
    });

    return {
      rate: transaction.rate as number,
      user: transaction.user.toString() as string,
      balance: balanceResponse.tokenCredits,
      [transaction.tokenType as string]: incrementValue,
    } as TransactionResult;
  }

  /**
   * Creates a structured transaction and updates the balance.
   */
  async function createStructuredTransaction(
    _txData: TxData,
  ): Promise<TransactionResult | undefined> {
    const { balance, transactions, requireTenant, ...txData } = _txData;
    if (transactions?.enabled === false && !(txData.tenantId ?? getTenantId())) {
      return;
    }

    const Transaction = mongoose.models.Transaction;
    const transaction = new Transaction({ ...txData, ...normalizeUsageMetadata(txData) });
    transaction.endpointTokenConfig = txData.endpointTokenConfig;
    transaction.inputTokenCount = txData.inputTokenCount;

    calculateStructuredTokenValue(transaction);

    const { inserted } = await persistTransactionOnce(transaction, requireTenant);

    if (!balance?.enabled) {
      return;
    }
    if (!inserted) {
      return await unchargedResult(transaction);
    }

    const incrementValue = transaction.tokenValue as number;

    const balanceResponse = await updateBalance({
      user: transaction.user as string,
      incrementValue,
    });

    return {
      rate: transaction.rate as number,
      user: transaction.user.toString() as string,
      balance: balanceResponse.tokenCredits,
      [transaction.tokenType as string]: incrementValue,
    } as TransactionResult;
  }

  /**
   * Queries and retrieves transactions based on a given filter.
   */
  async function getTransactions(filter: FilterQuery<ITransaction>): Promise<ITransaction[]> {
    try {
      const Transaction = mongoose.models.Transaction;
      return await Transaction.find(filter).lean<ITransaction[]>();
    } catch (error) {
      logger.error('Error querying transactions:', error);
      throw error;
    }
  }

  /**
   * Reports keyed transactions that already share an idempotency natural key
   * more than once (P1-3). Run this before building the unique ledger index on
   * an existing deployment: a non-empty result means historical duplicates
   * must be reconciled first, or the unique index build will fail.
   */
  async function reportDuplicateRequestKeys(
    filter: FilterQuery<ITransaction> = {},
  ): Promise<DuplicateRequestKeyGroup[]> {
    const Transaction = mongoose.models.Transaction;
    const groups = await Transaction.aggregate([
      { $match: { ...filter, requestKey: { $type: 'string' } } },
      {
        $group: {
          _id: {
            tenantId: '$tenantId',
            requestKey: '$requestKey',
            tokenType: '$tokenType',
            valueKey: '$valueKey',
          },
          count: { $sum: 1 },
          ids: { $push: '$_id' },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $sort: { count: -1 } },
    ]);

    return groups.map((group) => ({
      tenantId: group._id.tenantId ?? null,
      requestKey: group._id.requestKey,
      tokenType: group._id.tokenType,
      valueKey: group._id.valueKey ?? null,
      count: group.count,
      ids: group.ids.map((id: Types.ObjectId) => id.toString()),
    }));
  }

  /** Retrieves a user's balance record. */
  async function findBalanceByUser(user: string): Promise<IBalance | null> {
    const Balance = mongoose.models.Balance as Model<IBalance>;
    return Balance.findOne({ user }).lean<IBalance>();
  }

  /** Upserts balance fields for a user. */
  async function upsertBalanceFields(
    user: string,
    fields: IBalanceUpdate,
  ): Promise<IBalance | null> {
    const Balance = mongoose.models.Balance as Model<IBalance>;
    return Balance.findOneAndUpdate(
      { user },
      { $set: fields },
      { upsert: true, new: true },
    ).lean<IBalance>();
  }

  /** Deletes transactions matching a filter. */
  async function deleteTransactions(
    filter: FilterQuery<ITransaction>,
  ): Promise<import('mongodb').DeleteResult> {
    const Transaction = mongoose.models.Transaction;
    return Transaction.deleteMany(filter);
  }

  /** Deletes balance records matching a filter. */
  async function deleteBalances(
    filter: FilterQuery<IBalance>,
  ): Promise<import('mongodb').DeleteResult> {
    const Balance = mongoose.models.Balance as Model<IBalance>;
    return Balance.deleteMany(filter);
  }

  /**
   * Inserts usage documents idempotently. Duplicate `requestKey` writes are
   * replays of usage already recorded, so they are dropped while every other
   * document in the batch still lands. The returned indexes tell the caller
   * which documents were genuinely recorded, so a balance is only ever charged
   * for those.
   */
  async function bulkInsertTransactions(
    docs: TransactionData[],
  ): Promise<{ insertedIndexes: number[] }> {
    if (!docs.length) {
      return { insertedIndexes: [] };
    }
    const allIndexes = docs.map((_, index) => index);
    try {
      const Transaction = mongoose.models.Transaction;
      await Transaction.insertMany(docs, { ordered: false });
      return { insertedIndexes: allIndexes };
    } catch (error) {
      const writeErrors = (
        error as { writeErrors?: Array<{ index?: number; code?: number; err?: WriteErrorLike }> }
      )?.writeErrors;
      if (!Array.isArray(writeErrors) || writeErrors.length === 0) {
        logger.error('[bulkInsertTransactions] Error inserting transaction docs:', error);
        throw error;
      }

      const failedIndexes = new Set<number>();
      let hasNonDuplicateFailure = false;
      for (const writeError of writeErrors) {
        const index = writeError?.index ?? writeError?.err?.index;
        if (typeof index === 'number') {
          failedIndexes.add(index);
        }
        const code = writeError?.code ?? writeError?.err?.code;
        if (code !== DUPLICATE_KEY_ERROR_CODE) {
          hasNonDuplicateFailure = true;
        }
      }

      if (hasNonDuplicateFailure) {
        logger.error('[bulkInsertTransactions] Error inserting transaction docs:', error);
        throw error;
      }

      logger.debug('[bulkInsertTransactions] duplicate usage writes ignored (idempotent replay)', {
        duplicates: failedIndexes.size,
        total: docs.length,
      });
      return { insertedIndexes: allIndexes.filter((index) => !failedIndexes.has(index)) };
    }
  }

  return {
    updateBalance,
    bulkInsertTransactions,
    findBalanceByUser,
    upsertBalanceFields,
    getTransactions,
    deleteTransactions,
    deleteBalances,
    createTransaction,
    createAutoRefillTransaction,
    createStructuredTransaction,
    reportDuplicateRequestKeys,
  };
}

export type TransactionMethods = ReturnType<typeof createTransactionMethods>;
