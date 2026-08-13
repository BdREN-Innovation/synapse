import logger from '~/config/winston';

export const CANCEL_RATE = 1.15;

/**
 * Checks if the connected MongoDB deployment supports transactions
 * This requires a MongoDB replica set configuration
 *
 * @returns True if transactions are supported, false otherwise
 */
export const supportsTransactions = async (
  mongoose: typeof import('mongoose'),
): Promise<boolean> => {
  try {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();

      await mongoose.connection.db?.collection('__transaction_test__').findOne({}, { session });

      await session.commitTransaction();
      logger.debug('MongoDB transactions are supported');
      return true;
    } catch (transactionError: unknown) {
      try {
        await session.abortTransaction();
      } catch (transactionError) {
        /** best-effort abort */
        logger.error(`[supportsTransactions] Error aborting transaction:`, transactionError);
      }
      logger.debug(
        'MongoDB transactions not supported (transaction error):',
        (transactionError as Error)?.message || 'Unknown error',
      );
      return false;
    } finally {
      await session.endSession();
    }
  } catch (error) {
    logger.debug(
      'MongoDB transactions not supported (session error):',
      (error as Error)?.message || 'Unknown error',
    );
    return false;
  }
};

/**
 * Gets whether the current MongoDB deployment supports transactions
 * Caches the result for performance
 *
 * @returns True if transactions are supported, false otherwise
 */
export const getTransactionSupport = async (
  mongoose: typeof import('mongoose'),
  transactionSupportCache: boolean | null | undefined,
): Promise<boolean> => {
  if (typeof transactionSupportCache === 'boolean') {
    return transactionSupportCache;
  }
  return await supportsTransactions(mongoose);
};

/**
 * Resolves the canonical provider slug for a usage record.
 *
 * Usage collected from title generation, tool loops, and other secondary calls
 * often carries a model but no provider, while tenant-attributed ledger writes
 * require one. An explicit provider always wins; otherwise it is derived from a
 * `provider/model` prefix or a well-known model-name family.
 */
export const inferProviderKey = (model?: string, providerKey?: string): string | undefined => {
  if (typeof providerKey === 'string' && providerKey.trim()) {
    return providerKey.trim().toLowerCase();
  }

  if (typeof model !== 'string' || !model.trim()) {
    return undefined;
  }

  const normalized = model.trim().toLowerCase();
  const slashIndex = normalized.indexOf('/');
  if (slashIndex > 0) {
    return normalized.slice(0, slashIndex);
  }

  if (
    normalized.startsWith('gpt-') ||
    normalized.startsWith('o1') ||
    normalized.startsWith('o3') ||
    normalized.startsWith('o4') ||
    normalized.startsWith('chat-latest')
  ) {
    return 'openai';
  }
  if (normalized.startsWith('claude-')) {
    return 'anthropic';
  }
  if (normalized.startsWith('gemini') || normalized.startsWith('gemma')) {
    return 'google';
  }
  if (normalized.startsWith('grok-')) {
    return 'xai';
  }
  return undefined;
};
