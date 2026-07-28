# Production deployment — chat.bdren.ai

A reviewable plan for hosting `synapse` (the app) and `synapse-admin` (the admin
panel) on `203.96.189.213`, with the code interpreter staying on
`203.96.189.202`.

**Nothing in this document has been executed.** Every command is proposed. Read
§3 first — it contains the one architectural change that the two-server split
forces, and two decisions only you can make.

---

## 1. Verified starting state

Checked directly, not assumed:

| | App server | Interpreter server |
|---|---|---|
| Address | `203.96.189.213` → `chat.bdren.ai` ✅ | `203.96.189.202` → `interpreter.bdren.ai` ✅ |
| OS | Ubuntu 24.04.3 LTS, kernel 6.8 | Ubuntu, Docker |
| Hardware | 8 cores, 31 GB RAM, 457 GB free | — |
| Installed | **git only** — no node, npm, bun, pm2, mongod, nginx, redis, docker, certbot | Docker stack running, healthy |
| Open ports | 22 only | 22 only — all service ports are loopback-bound |
| sudo | passwordless | requires password |
| SSH | `id_ed25519`, user `bdren` | `bdren_interpreter`, user `bdren` |

Both DNS records resolve correctly. The app server is a clean machine — this is
a first-time provision, not a redeploy.

---

## 2. Target architecture

```
                    Internet
                       │
        ┌──────────────┴───────────────┐
        │                              │
  chat.bdren.ai                 interpreter.bdren.ai
  203.96.189.213                203.96.189.202
        │                              │
   nginx :443 (TLS, HTTP/2)      nginx :443 (TLS)
        │                         ↑ firewall: .213 only
   ┌────┴─────┬──────────┐             │
   │          │          │        Docker stack
 Synapse    Admin      static      (api, sandbox,
 :3080      :3000      assets       redis, minio…)
   │          │                    all loopback-bound
   └────┬─────┘
        │
  MongoDB :27017 ── Redis :6379   (both loopback-only)
```

Everything except nginx binds to `127.0.0.1`. Only 22, 80 and 443 are ever
publicly reachable on either host.

---

## 3. Read this before anything else

### 3.1 The interpreter is currently unreachable from the app server

This is a direct consequence of the security fix applied earlier. The
interpreter's port 3112 is bound to `127.0.0.1` on `.202`. That was correct when
the app ran on the same box (or reached it through an SSH tunnel from your Mac).
**Now the app lives on a different machine, so it cannot reach the interpreter at
all until §4 is done.**

Two ways to bridge it:

| Option | How | Trade-off |
|---|---|---|
| **A. nginx + TLS + IP allowlist** (recommended) | `interpreter.bdren.ai` over 443, firewalled to `.213` only | Encrypted, survives reboots, no moving parts. Matches the DNS record you already created |
| B. Persistent SSH tunnel | systemd unit on `.213` holding `-L 3112:127.0.0.1:3112` | No certificate needed, but a background process that can die; you have already been bitten by exactly this in dev |

This plan uses **A**. The DNS record for `interpreter.bdren.ai` suggests that was
your intent anyway.

### 3.2 Decision: MongoDB topology

Quota **enforcement** needs multi-document transactions, which need a replica
set. Shadow-mode accounting does not.

- **Recommended:** provision as a single-node replica set from day one (§5.3).
  It is the same single `mongod` process, costs nothing, and converting later
  means downtime plus a keyFile dance on a live database.
- Shadow mode still runs regardless; enforcement stays off until the readiness
  gate passes.

### 3.3 Decision: admin panel exposure

`synapse-admin` is a platform-superadmin console. Options:

1. **Same host, path-based:** `chat.bdren.ai/admin` — simplest, one certificate.
2. **Separate subdomain:** `admin.bdren.ai` — needs another DNS record and cert.
3. **Not public at all:** bind to `127.0.0.1:3000`, reach it over an SSH tunnel.

**Recommended: option 3 for launch**, moving to 2 later if other staff need
access. It is a console that can suspend institutions and rewrite quota policy;
there is no reason for it to face the internet during a pilot. Nothing in the
app depends on it being public.

---

## 4. Interpreter server (`203.96.189.202`)

Publishes the interpreter to the app server only. Requires your password (sudo
is not passwordless here).

```bash
ssh -i ~/.ssh/bdren_interpreter bdren@203.96.189.202

sudo apt update && sudo apt install -y nginx certbot python3-certbot-nginx

sudo tee /etc/nginx/sites-available/interpreter > /dev/null <<'EOF'
server {
    server_name interpreter.bdren.ai;
    client_max_body_size 50M;          # matches CODEAPI_HTTP_JSON_LIMIT
    location / {
        proxy_pass http://127.0.0.1:3112;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 330s;       # > SANDBOX_RUN_TIMEOUT (300s)
        proxy_buffering off;           # keeps streamed output flowing
    }
    listen 80;
}
EOF

sudo ln -sf /etc/nginx/sites-available/interpreter /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d interpreter.bdren.ai

# Firewall: 443 reachable only from the app server
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow ssh
sudo ufw allow from 203.96.189.213 to any port 443 proto tcp
sudo ufw enable
```

Leave the container port bindings alone — they are already loopback-only, which
is what makes this safe. `ufw` does not filter Docker-published ports (Docker
writes its own iptables rules ahead of ufw), so the loopback binding is the
control that matters, not the firewall.

**Verify:** `curl -fsS https://interpreter.bdren.ai/v1/health` succeeds from
`.213` and times out from anywhere else.

---

## 5. App server (`203.96.189.213`)

Passwordless sudo, so this section can run unattended.

### 5.1 Base packages and hardening

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y build-essential curl git ufw fail2ban

sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow ssh
sudo ufw allow 'Nginx Full'
sudo ufw enable

sudo systemctl enable --now fail2ban
```

### 5.2 Node 24 + Bun + PM2

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
curl -fsSL https://bun.sh/install | bash        # admin panel runs on Bun
sudo npm install -g pm2
pm2 startup systemd -u bdren --hp /home/bdren   # prints a command to run with sudo
```

Bun is required: `synapse-admin`'s production start is `bun server.ts`.

### 5.3 MongoDB 8.0 as a single-node replica set

```bash
curl -fsSL https://www.mongodb.org/static/pgp/server-8.0.asc | \
  sudo gpg -o /usr/share/keyrings/mongodb-server-8.0.gpg --dearmor
echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg ] \
https://repo.mongodb.org/apt/ubuntu noble/mongodb-org/8.0 multiverse" | \
  sudo tee /etc/apt/sources.list.d/mongodb-org-8.0.list
sudo apt update && sudo apt install -y mongodb-org
sudo systemctl enable --now mongod
```

Create the application user **before** enabling auth:

```bash
mongosh --eval 'db.getSiblingDB("admin").createUser({
  user: "synapse", pwd: "REPLACE_STRONG_PASSWORD",
  roles: [{role: "readWrite", db: "Synapse"}, {role: "clusterMonitor", db: "admin"}]
})'
```

Then the keyFile (mandatory once auth **and** replication are both on — omitting
it leaves `mongod` refusing to start), replication, and cache sizing:

```bash
sudo mkdir -p /etc/mongodb
openssl rand -base64 756 | sudo tee /etc/mongodb/keyfile > /dev/null
sudo chown mongodb:mongodb /etc/mongodb/keyfile && sudo chmod 400 /etc/mongodb/keyfile

sudo tee -a /etc/mongod.conf > /dev/null <<'EOF'
replication:
  replSetName: rs0
EOF
# under the existing `security:` block add:
#   authorization: enabled
#   keyFile: /etc/mongodb/keyfile
# under `storage:` add (≈40% of 31 GB, leaving room for Node and Redis):
#   wiredTiger:
#     engineConfig:
#       cacheSizeGB: 12

sudo systemctl restart mongod
mongosh -u synapse -p --authenticationDatabase admin \
  --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"127.0.0.1:27017"}]})'
mongosh -u synapse -p --authenticationDatabase admin --eval 'rs.status().myState'   # expect 1
```

`mongod` binds to `127.0.0.1` by default — keep it that way.

### 5.4 Redis

```bash
sudo apt install -y redis-server
sudo sed -i 's/^# *requirepass .*/requirepass REPLACE_STRONG_REDIS_PASSWORD/' /etc/redis/redis.conf
sudo sed -i 's/^bind .*/bind 127.0.0.1 -::1/' /etc/redis/redis.conf
sudo sed -i 's/^# *maxmemory .*/maxmemory 4gb/' /etc/redis/redis.conf
sudo sed -i 's/^# *maxmemory-policy .*/maxmemory-policy allkeys-lru/' /etc/redis/redis.conf
sudo systemctl enable --now redis-server && redis-cli -a REPLACE_STRONG_REDIS_PASSWORD ping
```

`allkeys-lru` is deliberate: this Redis is a cache and stream buffer, not a
system of record. If it fills, evicting the coldest key is correct; refusing
writes would take the app down.

### 5.5 Deploy the application

```bash
sudo mkdir -p /opt/synapse && sudo chown bdren:bdren /opt/synapse
git clone -b bdren-prod https://github.com/nafew0/synapse.git /opt/synapse
cd /opt/synapse
npm run smart-reinstall        # installs, then builds every workspace
```

Write `/opt/synapse/.env` from your dev `.env`, changing everything in §7. Then:

```bash
node config/migrate-usage-policies.js --dry-run
node config/migrate-usage-policies.js       # only if the dry run is clean
```

Run the migration **before** traffic: until every `tenantId` has an Institution
row, those users hit the fail-closed quota path.

### 5.6 Admin panel

```bash
sudo mkdir -p /opt/synapse-admin && sudo chown bdren:bdren /opt/synapse-admin
git clone -b bdren-prod https://github.com/nafew0/synapse-admin.git /opt/synapse-admin
cd /opt/synapse-admin && bun install && bun run build
```

`.env` needs `SESSION_SECRET` (32+ chars — `bun run start` refuses to boot
without it; the dev fallback only applies to `bun run dev`) and the Synapse API
base URL.

### 5.7 PM2

`/opt/synapse/ecosystem.config.js`:

```js
module.exports = {
  apps: [
    {
      name: 'synapse',
      script: 'api/server/index.js',
      cwd: '/opt/synapse',
      instances: 2,               // see §6.2 before increasing
      exec_mode: 'cluster',
      max_memory_restart: '2G',
      env: { NODE_ENV: 'production' },
    },
    {
      name: 'synapse-admin',
      script: 'bun',
      args: 'server.ts',
      cwd: '/opt/synapse-admin',
      instances: 1,
      exec_mode: 'fork',
      env: { NODE_ENV: 'production', PORT: '3000' },
    },
  ],
};
```

```bash
pm2 start /opt/synapse/ecosystem.config.js && pm2 save
```

### 5.8 nginx + TLS

```bash
sudo apt install -y nginx certbot python3-certbot-nginx

sudo tee /etc/nginx/sites-available/synapse > /dev/null <<'EOF'
upstream synapse {
    server 127.0.0.1:3080;
    keepalive 64;                       # reuse connections; avoids per-request TCP setup
}

server {
    server_name chat.bdren.ai;
    client_max_body_size 100M;          # file uploads

    gzip on;
    gzip_types text/plain text/css application/json application/javascript
               application/x-javascript text/xml application/xml image/svg+xml;
    gzip_min_length 1024;

    location / {
        proxy_pass http://synapse;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Token streaming dies without these two.
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 600s;
    }

    listen 80;
}
EOF

sudo ln -sf /etc/nginx/sites-available/synapse /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d chat.bdren.ai      # adds 443, HTTP/2 and the redirect
```

`proxy_buffering off` is not optional. With buffering on, nginx holds the SSE
stream and responses arrive in one lump at the end — the app appears frozen
during generation.

---

## 6. Performance

### 6.1 Set expectations honestly

For an LLM chat application, **perceived speed is dominated by model provider
latency and time-to-first-token**, not by this server. With 8 cores and 31 GB
serving a pilot, CPU will not be the bottleneck. Redis and clustering protect
throughput under concurrency and make the UI feel instant *around* the model
call; they do not make tokens arrive faster.

The changes that will actually be felt, ordered by impact:

| Change | Effect |
|---|---|
| HTTP/2 + TLS session resumption (certbot default) | Fewer round trips on every page load |
| Brotli static assets + immutable caching | First load smaller; repeat loads near-instant |
| Redis caching of config, roles and permissions | Removes repeated Mongo reads from the hot path |
| nginx upstream keepalive | No TCP handshake per proxied request |
| `proxy_buffering off` | Tokens stream as generated instead of arriving in a lump |
| PM2 cluster | Concurrency, not single-request latency |
| MongoDB WiredTiger cache 12 GB | Working set stays in RAM |

### 6.2 Redis and clustering

Add to `.env`:

```bash
USE_REDIS=true
USE_REDIS_STREAMS=true
REDIS_URI=redis://:REPLACE_STRONG_REDIS_PASSWORD@127.0.0.1:6379
REDIS_KEY_PREFIX=synapse
```

`USE_REDIS_STREAMS=true` is what makes cluster mode safe: resumable LLM streams
move out of per-worker memory, so a reconnect handled by a different worker still
finds the stream.

**Known caveat — the quota reconciler runs per worker.** It is started with
`setInterval` in `api/server/index.js`, so with `instances: 2` it runs twice a
minute instead of once. It is idempotent and derives its work from the
reservation ledger, so this is wasted effort rather than corruption. Mitigation,
in preference order:

1. Start at `instances: 2`, confirm behaviour under real traffic, then scale.
2. If you go beyond ~4 workers, gate the interval on
   `process.env.NODE_APP_INSTANCE === '0'` (PM2 sets this per worker). That is a
   one-line code change and should be reviewed, not slipped in during a deploy.

### 6.3 Static assets

```bash
ENABLE_STATIC_ASSET_BROTLI=true
STATIC_CACHE_MAX_AGE=31536000
STATIC_CACHE_S_MAX_AGE=86400
```

The app already serves precompressed assets and sets cache headers itself
(`api/server/utils/staticCache.js`), so nginx does not need to duplicate this —
which is why the nginx block above only gzips dynamic responses.

### 6.4 Search (optional)

Meilisearch powers conversation search. It is a separate service with its own
memory footprint. Leave `SEARCH=false` for launch and add it once the pilot is
stable — it is additive and needs no migration.

---

## 7. Production `.env` — what must change from dev

| Key | Dev | Production |
|---|---|---|
| `DOMAIN_CLIENT` | `http://localhost:3090` | `https://chat.bdren.ai` |
| `DOMAIN_SERVER` | `http://localhost:3080` | `https://chat.bdren.ai` |
| `MONGO_URI` | `mongodb://127.0.0.1:27017/LibreChat` | `mongodb://synapse:PASS@127.0.0.1:27017/Synapse?replicaSet=rs0&authSource=admin` |
| `LIBRECHAT_CODE_BASEURL` | `http://127.0.0.1:3112/v1` | `https://interpreter.bdren.ai/v1` |
| `ADMIN_PANEL_URL` | `http://localhost:3000` | per §3.3 |
| `NODE_ENV` | — | `production` |
| `USE_REDIS`, `REDIS_URI` | unset | §6.2 |
| `LIBRECHAT_LOG_DIR` | unset | `/opt/synapse/api/logs` |

Two naming notes:

- **`LIBRECHAT_LOG_DIR` keeps its name** — it is read by
  `@librechat/data-schemas`, so renaming the variable would simply stop working.
  Set it explicitly: with it unset the package picks the log directory by testing
  whether the working directory path contains "LibreChat", and `/opt/synapse`
  does not, so logs would land somewhere non-obvious.
- **The production database is `Synapse`, while dev is `LibreChat`.** Restoring a
  dev dump into production (or the reverse) therefore needs an explicit namespace
  mapping — `mongorestore` will otherwise recreate the source database name
  alongside the real one:

  ```bash
  mongorestore --uri "$MONGO_URI" --archive=dump.gz --gzip \
    --nsFrom 'LibreChat.*' --nsTo 'Synapse.*'
  ```

**Regenerate, do not copy:** `JWT_SECRET`, `JWT_REFRESH_SECRET`, `CREDS_KEY`,
`CREDS_IV`, `MEILI_MASTER_KEY`, `METRICS_SECRET`, and the admin panel's
`SESSION_SECRET`. Dev values have been on a developer laptop.

**Carry across unchanged:** `PLATFORM_SUPERADMIN_EMAILS` (without it nobody can
reach the platform console on a fresh database — the implicit "first user becomes
superadmin" bootstrap was removed as a privilege-escalation hole) and
`ALLOW_REGISTRATION=false` (self-signup is closed; invitations bypass this switch
via `req.invite`, so onboarding is unaffected).

The interpreter JWT keypair (`CODEAPI_*`) must match `.202`. Re-mint it rather
than copying the dev key, which was exposed in a terminal transcript.

---

## 8. Pre-flight gates

Do not open to users until all pass. Full detail in
[`production-runbook.md`](./production-runbook.md) §1.

```bash
node -e "require('dotenv').config();
['JWT_SECRET','JWT_REFRESH_SECRET','CREDS_KEY','CREDS_IV','METRICS_SECRET',
 'PLATFORM_SUPERADMIN_EMAILS','DOMAIN_CLIENT','ALLOW_REGISTRATION','REDIS_URI']
.forEach(k=>console.log((process.env[k]?'ok      ':'MISSING ')+k))"
```

Plus: `ALLOW_REGISTRATION=false`; every institution policy in `shadow`; nothing
but 22/80/443 reachable on either host; and `interpreter.bdren.ai` reachable from
`.213` but nowhere else.

---

## 9. Verification

```bash
curl -fsS https://chat.bdren.ai/health                       # 200
curl -sI https://chat.bdren.ai | grep -i "^HTTP\|strict-transport"
curl -s -o /dev/null -w '%{http_code}\n' https://chat.bdren.ai/metrics          # 401
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $METRICS_SECRET" \
  https://chat.bdren.ai/metrics                                                  # 200
pm2 logs synapse --lines 50 | grep -i "institution model is not registered"    # expect none
```

Then, by hand: log in as the superadmin, open the platform console, invite a test
member, accept the invitation in a private window, send a message, and request a
`.docx`. That last one exercises the full path — app → interpreter over TLS →
sandbox → file back — which nothing else covers.

---

## 10. Rollback

```bash
cd /opt/synapse && git log --oneline -5
git checkout <previous-sha> && npx turbo build --force && pm2 restart synapse
```

No migration in this release destroys data — the policy migration only adds rows
and indexes — so rolling code back is safe without touching the database. Feature
flags that act as instant switches (`TENANT_REQUIRE_REGISTERED_INSTITUTION`,
per-institution `mode: shadow`) are in the runbook §3.

---

## 11. Open risks

1. **The interpreter is a single point of failure and a separate host.** If
   `.202` or the TLS cert lapses, document generation stops. Certbot renewal
   should be verified with `sudo certbot renew --dry-run` on both hosts.
2. **`.213` is a single machine.** No redundancy. Acceptable for a pilot;
   note it before general availability.
3. **Backups are not automated by this plan.** Add the nightly `mongodump` from
   runbook §4 as a cron job on day one, and prove a restore before onboarding a
   second institution.
4. **Enforcement stays off.** Shadow mode collects everything needed to size
   limits. Turning it on is a later, deliberate step behind the readiness gate.
5. **`.202` still has dev-era exposure history.** Its ports are loopback-bound
   now, but it was briefly internet-reachable. Rotating the interpreter's JWT
   keypair and internal service tokens during this deployment is cheap insurance.
