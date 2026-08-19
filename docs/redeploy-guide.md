# BdREN Synapse — redeploying a new version

Step-by-step procedure for shipping a new version of `synapse` (chat app) and
`synapse-admin` (platform console) to production.

This is the **how**. [`production-runbook.md`](production-runbook.md) is the
**why** — pre-flight gate rationale, alerts, retention, reconciliation, staged
rollout. Read that once; follow this every time.

First-time host build-out is [`production-deployment-bdren-ai.md`](production-deployment-bdren-ai.md).

Last validated: 2026-08-19, deploying 461 commits (v0.8.7 → v0.8.8).

---

## 0. Facts you need

| | |
|---|---|
| App host | `203.96.189.213` — user `bdren`, key `~/.ssh/id_ed25519`, passwordless sudo |
| Interpreter host | `203.96.189.202` — key `~/.ssh/bdren_interpreter`, **sudo needs a password** |
| App path | `/opt/synapse` (branch `bdren-prod`) |
| Admin path | `/opt/synapse-admin` (branch `bdren-prod`, **separate repo**, runs on Bun) |
| PM2 processes | `synapse` (cluster, 2 workers), `synapse-admin` (fork) |
| Mongo | replica set `rs0`, database `Synapse` |
| Public | `https://chat.bdren.ai` behind nginx; app listens on `127.0.0.1:3080`, admin on `:3000` |

Both hosts answer to `hostname bdren` — use `hostname -I` to tell them apart.

**Rule 1 applies throughout:** never edit config on the host. Change it locally,
commit, push, pull. `.env` is the documented exception (secrets, gitignored).

---

## 1. Before you touch the server

Do this on your machine, not the host.

```bash
cd "…/BdREN Synapse/synapse"
git checkout bdren-prod && git pull
npm run build:packages                     # must succeed
cd packages/data-schemas && npx tsc --noEmit -p tsconfig.json
cd ../api          && npx tsc --noEmit -p tsconfig.json
cd ../../client    && npx tsc --noEmit -p .
```

All three type-checks must be clean. Bundlers transpile without enforcing the
full TypeScript contract, so **a green build alone does not mean it compiles** —
that gap has bitten this project before.

Then confirm what you are about to ship:

```bash
git log --oneline origin/bdren-prod -5
git rev-list --count <deployed-sha>..origin/bdren-prod    # how many commits
```

---

## 2. Pre-flight gates on the host

Read-only. Every line must pass — see runbook §1 for why each one matters.

```bash
ssh -i ~/.ssh/id_ed25519 bdren@203.96.189.213
cd /opt/synapse

# secrets and config present (prints status, never values)
node -e "require('dotenv').config();
['JWT_SECRET','JWT_REFRESH_SECRET','CREDS_KEY','CREDS_IV','METRICS_SECRET',
 'PLATFORM_SUPERADMIN_EMAILS','DOMAIN_CLIENT','ALLOW_REGISTRATION']
.forEach(k=>console.log((process.env[k]?'ok      ':'MISSING ')+k))"

grep -E '^ALLOW_REGISTRATION=' .env          # must be false, or allowedDomains set in librechat.yaml
grep -q '^SESSION_SECRET=.' /opt/synapse-admin/.env && echo 'admin secret ok'

# no enforce policy — an enforce policy the topology can't support makes the API
# refuse to boot, which under PM2 is a restart loop (runbook §6)
mongosh --quiet "$(grep -E '^MONGO_URI=' .env | cut -d= -f2-)" \
  --eval 'db.usagepolicies.find({},{tenantId:1,mode:1,_id:0}).forEach(p=>print(p.tenantId+" -> "+p.mode))'
```

And from **off-box** (your laptop), the interpreter must not answer:

```bash
nc -z -w 5 203.96.189.202 3112     # must FAIL
```

> ⚠️ As of 2026-08-19 this gate **fails** — see [Known open issues](#known-open-issues).

### The check the runbook doesn't mention

Production carries untracked files that are not in git (`config/Caddyfile`,
`bin/`, `state/`, `shared/`, …). `git pull` aborts if an incoming commit adds a
file at one of those paths. Check before pulling, not after:

```bash
git fetch origin
git status --porcelain | grep '^??'                       # what's untracked here
for p in bin/ config/ shared/ state/; do
  n=$(git diff --name-only HEAD..origin/bdren-prod -- "$p" | wc -l)
  [ "$n" -gt 0 ] && echo "COLLISION in $p ($n files)"
done
echo "checked"
```

Also confirm nothing is **modified** (`^ M`) — that would mean someone edited the
server directly, and you need to understand what before overwriting it.

---

## 3. Back up

There is no automatic backup. Take one; it takes seconds.

```bash
cd /opt/synapse
sudo mkdir -p /backup && sudo chown bdren: /backup
URI=$(grep -E '^MONGO_URI=' .env | cut -d= -f2-)
mongodump --uri "$URI" --archive=/backup/synapse-predeploy-$(date +%F-%H%M).gz --gzip

git rev-parse HEAD | tee /backup/rollback-sha-$(date +%F-%H%M).txt   # ← rollback target
```

Write that SHA somewhere you'll still have it if your SSH session dies.

---

## 4. Deploy

```bash
cd /opt/synapse
git checkout bdren-prod
git pull --ff-only                 # --ff-only: refuse a surprise merge on prod

npm run smart-reinstall            # installs if the lockfile moved, then builds
```

**Check the build output says `Cached: 0 cached`.** Turbo will happily serve a
cached build from a different commit, and `packages/api` / `packages/data-schemas`
are consumed as *built output* — a restart against stale artifacts runs old code
against new source. If it reports cache hits after a branch change:

```bash
npx turbo build --force
```

Then migrate **before** restarting:

```bash
node config/migrate-usage-policies.js --dry-run     # inspect
node config/migrate-usage-policies.js --apply       # note: --apply, not a bare invocation
```

The dry run prints institutions needing a policy and duplicate ledger groups.
**Duplicate groups must be 0** — the usage ledger's unique idempotency index
cannot build otherwise. If non-zero, stop and run
`node config/report-duplicate-usage-keys.js`.

Restart:

```bash
pm2 restart synapse
```

### Admin panel (separate repo, separate toolchain)

Easy to forget — it has its own repo and runs on Bun, not npm.

```bash
cd /opt/synapse-admin
git pull --ff-only
export PATH="$HOME/.bun/bin:$PATH"
export VITE_BASE_PATH=/adminpanel                # REQUIRED — see below
export VITE_API_BASE_URL=https://chat.bdren.ai
bun install && bun run build
pm2 restart synapse-admin
```

**`VITE_BASE_PATH` must be exported in the build shell, not just present in
`.env`.** The panel's `vite.config.ts` reads it via `process.env` at
config-evaluation time, and Vite loads `.env` files only into `import.meta.env`
— never into `process.env` for the config itself. A bare `bun run build`
therefore silently builds with base `/`: the panel serves, the shell renders
"Loading…", and the console shows
`Failed to fetch dynamically imported module: https://chat.bdren.ai/assets/main-*.js`
(note the missing `/adminpanel` prefix — root-based asset URLs land on the chat
app instead). This exact failure shipped on 2026-08-19.

Verify the base took before restarting:

```bash
grep -rao '/adminpanel/assets/main-[a-zA-Z0-9_-]*\.js' dist/server/ | head -1   # must match
```

---

## 5. Verify

On the host:

```bash
curl -fsS localhost:3080/health                        # expect: OK
pm2 list                                                # all three online, version bumped
pm2 logs synapse --lines 60 --nostream | grep -c "Institution model is not registered"   # expect: 0
pm2 logs synapse --lines 60 --nostream | grep -E "readiness|listening"
```

Want `Server readiness checks passing.` and `Server listening at http://127.0.0.1:3080`.

From your laptop — proves nginx, TLS, and the new bundle together:

```bash
curl -o /dev/null -w "%{http_code}\n" https://chat.bdren.ai/health   # 200
curl -s https://chat.bdren.ai/login | grep -o '<title>[^<]*</title>' # BdREN Synapse
curl -s https://chat.bdren.ai/api/config | tr ',' '\n' | grep appTitle
```

Then **actually use it**: log in, send one message, open the admin panel. Every
check above passed on a deploy that no human had yet exercised as a user; health
endpoints do not test auth, streaming, or the model path.

### Log noise that is not a problem

| You'll see | Verdict |
|---|---|
| `[ioredis] ECONNREFUSED 127.0.0.1:6379` during restart | **Fine.** Transient restart-window race. Confirm recovery: logs should show `[StreamServices] Created Redis-backed stream services`. |
| `redis-cli ping` → `NOAUTH Authentication required` | **Correct.** Redis requires auth; the app holds credentials in `REDIS_URI`. |
| `RAG API is … not reachable at undefined` | Expected — RAG is not deployed. Only matters if you want semantic file search. |
| `npm notice New major version of npm` | Ignore. Do not upgrade npm mid-deploy. |

---

## 6. Rollback

```bash
cd /opt/synapse
git checkout <sha-from-/backup/rollback-sha-*.txt>
npx turbo build --force        # not optional — stale artifacts are the trap
pm2 restart synapse
```

Safe without touching the database: the usage-policy migration only **adds** rows
and indexes. The one irreversible step in this system is the Mongo replica-set
conversion, which is already done.

Faster than a rollback, no redeploy needed (runbook §3):

| Flag | Effect |
|---|---|
| Policy `mode: shadow` | Disables enforcement for one institution |
| `TENANT_REQUIRE_REGISTERED_INSTITUTION=false` | Admits tenants lacking an Institution row |
| `USAGE_RESERVATION_RETENTION_DAYS=0` | Stops aging out reservations |

---

## 7. Syncing upstream LibreChat first

Only when the deploy includes new upstream code. Do this **locally** — never
resolve conflicts on the server.

```bash
git fetch upstream --tags
git checkout bdren-prod
git merge-tree --write-tree --name-only HEAD upstream/main   # dry run: exit 1 = conflicts
git merge upstream/main
```

Conflicts cluster in the same handful of files, because that is where BdREN
customization lives: `AuthService.js`, `preAuthTenant.ts`, `schema/user.ts`, the
`data-schemas` barrels, `admin/users.js`, `agents/client.js`. Two rules learned
the hard way:

- **Barrel/registration files** (`schema/index.ts`, `models/index.ts`) are almost
  always "keep both sides" — but `methods/index.ts` is a *type-intersection
  chain*, so a naive union duplicates a member and breaks the syntax.
- **Never blind-accept upstream on auth.** Upstream periodically reintroduces
  "first user becomes ADMIN". In this deployment tenant-less accounts are the
  platform-superadmin space, so that is a privilege-escalation hole. Keep our side.

After merging: rebuild, re-run all three type-checks, run the test suites, and
sync `main` separately (it is a clean mirror — never commit to it):

```bash
git branch -f main upstream/main && git push origin main
git branch --set-upstream-to=origin/main main    # -f resets tracking; put it back
```

---

## Known open issues

Carry these forward until closed.

**🔴 Interpreter is internet-facing.** `203.96.189.202:3112` accepts connections
from any host and binds `0.0.0.0`; Docker publishes the port past ufw. It has JWT
auth, but the runbook is explicit that JWT should not be the only barrier to a
service that executes arbitrary code. Fix by publishing to the private interface
(`127.0.0.1:3112:3112` or the internal IP) in the interpreter compose file —
committed to `synapse-interpreter` and pulled, not edited in place. Requires the
sudo password on that host.

**🔴 P0-2: suspended and removed members can still authenticate.** No
`membershipStatus` check exists in `localStrategy.js` or `jwtStrategy.js`, and
`openidStrategy.js` silently re-activates a suspended member on SSO login.
Suspension is currently cosmetic. Exposure is limited while
`ALLOW_REGISTRATION=false` and the user count is small.

**🟡 Tenant-isolation coverage guard fails** on `AdminScopeAssignment` — has a
`tenantId`, neither plugged into the isolation plugin nor allowlisted. Unqueried
scaffolding today, so nothing leaks; decide before wiring it up.

**🟡 Three backend suites fail to load** (`platform/users.test.js`,
`institutionMembers.spec.js`, `AuthService.spec.js`) — `createModels is not a
function` mock issues. Test-harness problems, but those paths are effectively
untested.

**🟡 No scheduled backup.** §3 is manual. Worth a nightly cron.

**🟡 Institution timezone.** Usage/billing periods are hardcoded UTC; BdREN is
UTC+6, so month boundaries are 6 hours off.

---

## If it goes wrong

| Symptom | Cause | Do |
|---|---|---|
| `git pull` aborts, "untracked working tree files would be overwritten" | Incoming commit adds a file that exists untracked on the host | §2 collision check; move the file aside, pull, reconcile |
| PM2 restart loop | Usually an enforce policy the topology can't support | `pm2 logs synapse --err --lines 50`; set the policy to `shadow` |
| App runs but behaves like the old version | Stale turbo cache — built output not rebuilt | `npx turbo build --force && pm2 restart synapse` |
| `Institution model is not registered` in logs | Migration not run, or ran against the wrong database | Re-run §4 migration; check `MONGO_URI` |
| Admin panel won't boot | `SESSION_SECRET` missing in `/opt/synapse-admin/.env` | Set it — the dev fallback only exists under `bun run dev` |
| Admin panel stuck on "Loading…", console shows `Failed to fetch dynamically imported module: …/assets/main-*.js` (no `/adminpanel` prefix) | Built without `VITE_BASE_PATH` exported in the shell — `.env` alone is not enough | Re-run the §4 admin build with the exports; verify with the `dist/server` grep |
| 502 from nginx | App not listening | `pm2 list`, `curl localhost:3080/health`, `pm2 logs synapse --err` |
