const path = require('path');
require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });

const mongoose = require('mongoose');
const { runAsSystem } = require('@librechat/data-schemas');
const connect = require('./connect');
const db = require('~/models');
require('~/db/models');

async function main() {
  const apply = process.argv.includes('--apply');
  await connect();

  const institutions = await runAsSystem(() => db.listInstitutions({ limit: 100000, offset: 0 }));
  const duplicates = await runAsSystem(() => db.reportDuplicateRequestKeys());
  const candidates = institutions.filter(
    (institution) => !institution.timezone || !institution.usagePolicyVersion,
  );

  console.log(`Institutions: ${institutions.length}`);
  console.log(`Institutions requiring a version-1 shadow policy: ${candidates.length}`);
  console.log(`Duplicate keyed ledger groups: ${duplicates.length}`);
  if (duplicates.length > 0) {
    console.log('Stop: reconcile duplicate usage keys before building the ledger indexes.');
    process.exitCode = 2;
    return;
  }
  if (!apply) {
    console.log('Dry run only. Re-run with --apply to migrate and build usage indexes.');
    return;
  }

  for (const institution of candidates) {
    const timezone = institution.timezone || 'Asia/Dhaka';
    await runAsSystem(async () => {
      await mongoose.models.UsagePolicy.updateOne(
        { tenantId: institution.tenantId, version: 1 },
        {
          $setOnInsert: {
            tenantId: institution.tenantId,
            version: 1,
            mode: 'shadow',
            timezone,
            period: 'calendar_month',
            limits: {
              institutionTokens: null,
              memberTokens: null,
              modelTokens: [],
            },
            warningThresholds: [0.8, 0.9],
            inputSafetyFactor: 1.15,
            inputSafetyTokens: 256,
            effectiveAt: new Date(),
            reason: 'Phase 6 shadow-mode migration',
          },
        },
        { upsert: true },
      );
      await mongoose.models.Institution.updateOne(
        { tenantId: institution.tenantId },
        { $set: { timezone, usagePolicyVersion: 1 } },
      );
    });
  }

  await Promise.all([
    mongoose.models.Transaction.syncIndexes(),
    mongoose.models.UsagePolicy.syncIndexes(),
    mongoose.models.UsageBucket.syncIndexes(),
    mongoose.models.UsageReservation.syncIndexes(),
    mongoose.models.UsageWarning.syncIndexes(),
    mongoose.models.Institution.syncIndexes(),
  ]);
  console.log(`Migrated ${candidates.length} institutions and synchronized usage indexes.`);
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((error) => {
    console.error('Usage policy migration failed:', error);
    process.exit(1);
  });
