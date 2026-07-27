const path = require('path');
require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });

const { runAsSystem } = require('@librechat/data-schemas');
const connect = require('./connect');
const db = require('~/models');

/**
 * Reports Transaction ledger rows that already share an idempotency natural
 * key (tenantId + requestKey + tokenType + valueKey) more than once. Run this
 * BEFORE building the unique ledger index (P1-3) on an existing deployment: a
 * non-empty result means historical duplicates must be reconciled first, or
 * the unique index build will fail.
 *
 * Read-only. Usage:
 *   node config/report-duplicate-usage-keys.js [--tenant=<tenantId>]
 */
function parseArgs(argv) {
  const args = { tenantId: undefined };
  for (const arg of argv) {
    if (arg.startsWith('--tenant=')) {
      const tenantId = arg.slice('--tenant='.length).trim();
      if (tenantId) {
        args.tenantId = tenantId;
      }
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await connect();

  const filter = args.tenantId ? { tenantId: args.tenantId } : {};
  const duplicates = await runAsSystem(() => db.reportDuplicateRequestKeys(filter));

  if (duplicates.length === 0) {
    console.log('No duplicate usage keys found. Safe to enable the unique ledger index.');
    return;
  }

  console.log(`Found ${duplicates.length} duplicated usage key(s):`);
  console.log('');
  for (const group of duplicates) {
    console.log(
      `  tenant=${group.tenantId ?? '(none)'} requestKey=${group.requestKey} ` +
        `tokenType=${group.tokenType} valueKey=${group.valueKey ?? '(none)'} ` +
        `count=${group.count}`,
    );
    console.log(`    ids: ${group.ids.join(', ')}`);
  }
  console.log('');
  console.log(
    'Reconcile these before enabling the unique index; keeping the earliest row ' +
      'and deleting the rest is the usual resolution.',
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Duplicate usage-key report failed:', error);
    process.exit(1);
  });
