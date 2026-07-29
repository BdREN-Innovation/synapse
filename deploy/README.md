# Deployment configuration

Server configuration lives here so it is version controlled. **Do not edit these
files on a server.** Change them locally, commit, push, then update the server
from GitHub — otherwise the running configuration and the repository drift apart
and the next deploy silently reverts whatever was changed in place.

| File | Deployed to | Path on host |
|---|---|---|
| `nginx/chat.bdren.ai.conf` | `203.96.189.213` | `/etc/nginx/sites-available/synapse` |
| `caddy/interpreter.bdren.ai.Caddyfile` | `203.96.189.202` | `~/caddy/Caddyfile` |
| `../ecosystem.config.js` | `203.96.189.213` | `/opt/synapse/ecosystem.config.js` |
| `../librechat.yaml` | `203.96.189.213` | `/opt/synapse/librechat.yaml` |

`librechat.yaml` is deliberately un-ignored in this fork. It holds no literal
secrets — provider keys are `${ENV}` references — and tracking it is what makes
updating from GitHub possible.

## Applying a change

```bash
# locally
git add -A && git commit -m "..." && git push origin bdren-prod

# on the app server
cd /opt/synapse && git pull origin bdren-prod
npx turbo build --force          # only if app code changed
sudo cp deploy/nginx/chat.bdren.ai.conf /etc/nginx/sites-available/synapse
sudo nginx -t && sudo systemctl reload nginx
pm2 restart synapse
```

The nginx file is captured **after** certbot edited it, so it already contains
the managed TLS block. Re-running certbot rewrites it — pull the file back into
the repo afterwards rather than hand-editing the copy here.

## What is deliberately not here

- **`.env`** — contains real secrets, stays gitignored. The production values are
  listed by name in [`../docs/production-deployment-bdren-ai.md`](../docs/production-deployment-bdren-ai.md) §7.
- **Database state** — the Document Assistant agent, its public viewer grant, and
  user roles live in MongoDB, not in configuration. `librechat.yaml` references
  the agent by id, so a rebuilt database needs the agent recreated and the id
  updated here.
