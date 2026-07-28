# BdREN Synapse — production runbook

Covers the Phase 9 operational surface: pre-flight gates, deploy, rollback,
backup/restore, reconciliation, retention, and the alerts worth paging on.

Host layout (from `librechat-ubuntu-npm-deployment-guide.md`): Node 24 + PM2
running from source, system `mongod`, and the code-interpreter in Docker on the
same box. There is no Compose deployment.

---

## 1. Pre-flight gates

Do not deploy until every line is satisfied. Each is a real failure, not a
formality.

| Gate | Check | Why |
|---|---|---|
| Registration is closed | `ALLOW_REGISTRATION=false`, **or** `registration.allowedDomains` set in `librechat.yaml` | Otherwise anyone on the internet self-registers and spends your model credits |
| Platform superadmin seeded | `PLATFORM_SUPERADMIN_EMAILS` set | The implicit "first user becomes superadmin" bootstrap was removed as a privilege-escalation hole; without this, nobody can reach the platform console on a fresh database |
| Admin panel secret | `SESSION_SECRET` set in `synapse-admin/.env` | `bun run start` refuses to boot without it. The dev fallback exists only under `bun run dev` |
| Interpreter not internet-facing | `nc -z <host> 3112` from off-box fails | It executes arbitrary code; the JWT check should not be the only thing between it and the internet |
| Public URLs | `DOMAIN_CLIENT` / `DOMAIN_SERVER` are the public origin, not `localhost` | `DOMAIN_CLIENT` builds every emailed link (invitations, password reset) |
| Metrics reachable | `METRICS_SECRET` set | Without it `/metrics` returns 401 and every alert below is blind |
| Secrets are not dev values | `JWT_SECRET`, `JWT_REFRESH_SECRET`, `CREDS_KEY`, `CREDS_IV`, `MEILI_MASTER_KEY` regenerated for prod | Dev values are in a repo you push |
| Quota mode | Every institution's active policy is `shadow` | Enforce needs a replica set; see §6 |

```bash
# quick audit on the server, prints status not values
node -e "require('dotenv').config();
['JWT_SECRET','JWT_REFRESH_SECRET','CREDS_KEY','CREDS_IV','METRICS_SECRET',
 'PLATFORM_SUPERADMIN_EMAILS','DOMAIN_CLIENT','ALLOW_REGISTRATION']
.forEach(k=>console.log((process.env[k]?'ok      ':'MISSING ')+k))"
```

---

## 2. Deploy

```bash
cd /opt/synapse
git fetch origin && git checkout bdren-prod && git pull
npm run smart-reinstall          # installs if the lockfile moved, then builds
node config/migrate-usage-policies.js --dry-run
node config/migrate-usage-policies.js        # only if the dry run is clean
pm2 restart librechat && pm2 logs librechat --lines 50
```

Two ordering rules that are easy to get wrong:

- **Build before restart.** `packages/api` and `packages/data-schemas` are
  consumed as built output. A restart without a build runs the previous
  compiled code against new source — during this project that produced test
  results that flipped between runs. After any branch change:
  `npx turbo build --force`.
- **Migrate before traffic.** Until every `tenantId` has an Institution row,
  those users hit the fail-closed quota path.

Verify: `curl -fsS localhost:3080/health`, then confirm the log has no
`Institution model is not registered` lines.

---

## 3. Rollback

```bash
cd /opt/synapse
git log --oneline -5                 # note the previous good SHA
git checkout <previous-sha>
npx turbo build --force
pm2 restart librechat
```

No schema migration in this release destroys data — the policy migration only
adds rows and indexes, so rolling code back is safe without touching the
database. The one-way step is the MongoDB replica-set conversion (§6): converting
back to standalone is a separate, planned operation.

**Feature flags that act as rollback switches**, no redeploy needed:

| Flag | Effect |
|---|---|
| `TENANT_REQUIRE_REGISTERED_INSTITUTION=false` | Tenants without an Institution row are admitted (default). Set `true` only once every tenant is migrated |
| `USAGE_RESERVATION_RETENTION_DAYS=0` | Stop aging out reservations |
| Policy `mode: shadow` | Turns enforcement off for one institution without touching the others |

---

## 4. Backup and restore

```bash
# nightly, before any deploy
mongodump --uri "$MONGO_URI" --archive=/backup/synapse-$(date +%F).gz --gzip

# restore into a scratch database first — never straight over production
mongorestore --uri "$MONGO_URI" --archive=/backup/synapse-2026-07-28.gz --gzip \
  --nsFrom 'LibreChat.*' --nsTo 'LibreChat_restore.*'
```

Drill quarterly and record the restore duration; an untested backup is not a
backup. Back up `.env` and `librechat.yaml` separately — they are not in the
database and `.env` is gitignored.

---

## 5. Reconciliation

`reconcileQuotaState` runs in-process every `QUOTA_RECONCILE_INTERVAL_MS`
(default 60s). It expires stale reservations and recomputes bucket totals from
the reservation ledger.

Under PM2 **cluster mode every worker runs its own reconciler**. It is
idempotent, but if you scale beyond one instance, either accept the duplicated
work or move the loop to a single scheduled process.

Manual integrity check:

```bash
node config/report-duplicate-usage-keys.js     # expect 0 duplicate groups
```

---

## 6. MongoDB topology

Shadow-mode accounting runs on a standalone `mongod` — the quota engine probes
for transaction support and falls back to non-transactional writes.

Enforce mode requires multi-document transactions, so a single-node replica set.
The conversion (including the keyFile that authenticated deployments need) is in
`librechat-ubuntu-npm-deployment-guide.md` §1.3. Until it is done:

- Creating an enforce policy returns `QUOTA_ENFORCEMENT_REQUIRES_TRANSACTIONS`.
- If an enforce policy somehow exists, the API **refuses to boot** — under PM2
  that is a restart loop. Convert first, then enable.

---

## 7. Retention and erasure

| Data | Retention | Control |
|---|---|---|
| Usage reservations | 90 days, TTL index | `USAGE_RESERVATION_RETENTION_DAYS` (`0` = keep) |
| Transactions (usage ledger) | Indefinite | The billing record — do not prune without a policy decision |
| Audit log | **Indefinite, no TTL** | Deliberate: silently deleting an audit trail is worse than growth. Set one explicitly when a retention period is agreed |

To apply an audit retention period once decided (example: 400 days):

```js
db.auditlogs.createIndex({ createdAt: 1 }, { expireAfterSeconds: 34560000 })
```

**Erasure request for one member:** remove the user and their conversations and
messages, but keep their usage ledger rows — they are financial records.
Pseudonymise instead by clearing name/email on the user document; ledger rows
reference the user id, not their identity.

---

## 8. Alerts

Exposed on `/metrics` (Prometheus), gated by `METRICS_SECRET`.

| Metric | Alert when | Means |
|---|---|---|
| `quota_denials_total` | Any increase while every policy is `shadow` | Enforcement is on somewhere it should not be |
| `usage_reservation_expiries_total` | Sustained non-zero | Reservation leak: runs hold capacity and never settle. In enforce mode this eventually starves the institution |
| `tenant_context_failures_total` | Any sustained rate | Requests arriving without a resolvable tenant |
| `cross_tenant_rejections_total` | **Any non-zero** | Something is addressing another tenant's data. Investigate immediately — this is the isolation boundary reporting a hit |
| `http_requests_total{status="5xx"}` | Above baseline | Standard availability signal |

`cross_tenant_rejections_total` deserves a page, not a dashboard tile. The others
are dashboard-with-threshold.

---

## 9. Staged rollout

1. **Internal tenant** — BdREN staff only. Confirm invitations, document
   generation, and usage attribution against real traffic.
2. **One pilot institution** — watch the shadow readiness gate and the alerts
   above for at least a week.
3. **Selected institutions** — only after a full backup/restore drill.
4. **General availability** — and only here consider enforce mode, after the
   replica-set conversion and the 7-day/1,000-call gate.

Enforcement stays off through steps 1–3. Shadow mode collects everything needed
to size limits without any risk of refusing a user's request.
