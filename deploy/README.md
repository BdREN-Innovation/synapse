# Local server deployment

This directory implements the production plan in `plans/custom-local-server-cicd.md`.
It uses Docker Compose for shared services and application slots, Caddy for HTTPS and
traffic switching, and a self-hosted GitHub Actions runner for trusted post-merge jobs.

## Setup

1. Prepare an x86_64 Linux server with Docker Engine, the Compose plugin, Git, `curl`,
   `flock` (usually from `util-linux`), and at least 16 GB RAM and four CPU cores.
2. Point `chat.example.com` and `admin.chat.example.com` at the server. Open only TCP
   ports 80 and 443 in the firewall; application and database ports stay on localhost
   or the Docker network.
3. Clone this repository on the server, check out the intended deployment branch, and
   run `sudo ./deploy/bootstrap.sh`.
4. Edit `/opt/synapse/shared/.env` as root. Set both domains, replace every placeholder
   secret, add provider credentials, and replace `ADMIN_PANEL_IMAGE` and `RAG_IMAGE`
   tags with reviewed immutable digests. Keep mode 600.
5. Start and validate shared services:

   ```sh
   cd /opt/synapse
   docker compose --env-file shared/.env -f config/shared.yml -p synapse up -d
   docker compose -p synapse ps
   docker exec synapse-caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
   ```

6. Install a repository-scoped GitHub Actions runner as `synapse-runner` and apply the
   labels `self-hosted`, `linux`, `x64`, and `synapse-production`. Do not allow it to
   execute pull-request jobs. Add the runner user to the Docker group so it can build
   images, and grant only the required root commands with `/etc/sudoers.d/synapse-runner`:

   ```text
   synapse-runner ALL=(root) NOPASSWD: /opt/synapse/bin/deploy, /opt/synapse/bin/rollback, /opt/synapse/bin/status, /opt/synapse/bin/cleanup
   ```

7. Run `sudo visudo -cf /etc/sudoers.d/synapse-runner`, start the runner as a systemd
   service, and verify it is online in the repository Settings → Actions → Runners page.
8. Protect the `production` branch: require pull requests from `main`, one approval,
   resolved conversations, and the production gate. Disable force-push and deletion.
9. Merge a first release. The deployment workflow builds `synapse-api:<full SHA>` on
   the runner, starts the inactive slot, waits for `/readyz`, switches Caddy, and records
   state under `/opt/synapse/state/release.env`.

## Manual operations

```sh
sudo /opt/synapse/bin/status
sudo /opt/synapse/bin/deploy <40-character-commit-sha>
sudo /opt/synapse/bin/rollback
sudo /opt/synapse/bin/rollback <40-character-commit-sha>
sudo KEEP_RELEASES=5 /opt/synapse/bin/cleanup
```

The target image must already exist locally as `synapse-api:<sha>`. The first successful
release has no previous release to roll back to; rollback is available after the second.
Rollback changes application traffic and images only. It does not restore MongoDB or
Postgres data.

## Debugging runbook

- **Runner offline:** inspect `systemctl status actions.runner.*`, runner service logs,
  labels, Docker access (`sudo -u synapse-runner docker ps`), and outbound HTTPS/DNS.
- **Build fails or the host OOMs:** inspect `docker system df`, `free -h`, and the workflow
  build log. Keep builds serialized and ensure at least 16 GB RAM; do not prune active
  images or volumes.
- **Slot never becomes ready:** run `docker logs synapse-app-blue` or `synapse-app-green`,
  verify `/opt/synapse/shared/.env`, MongoDB connectivity, provider keys, and
  `docker inspect synapse-app-<slot>` for `BUILD_COMMIT`.
- **Caddy fails validation/reload:** inspect `/opt/synapse/config/Caddyfile`, run the
  validation command from the setup section, and check `docker logs synapse-caddy`.
- **HTTPS smoke test fails:** confirm DNS, firewall ports 80/443, certificate issuance,
  and `curl -vk https://<APP_DOMAIN>/readyz`. Use `SKIP_PUBLIC_SMOKE=true` only for an
  initial private/LAN test, then rerun the normal smoke test before production use.
- **Rollback fails:** verify the requested SHA is present with
  `docker image inspect synapse-api:<sha>`, check Caddy's active upstream, and inspect
  the same slot logs. Do not delete the previous image until recovery is complete.
- **After reboot:** run `docker ps`, `sudo /opt/synapse/bin/status`, and
  `docker compose --env-file /opt/synapse/shared/.env -f /opt/synapse/config/shared.yml -p synapse up -d`.

## Safety rules

- Never put `.env`, provider keys, GitHub runner tokens, or private keys in Git.
- Never run production deployment workflows for `pull_request` events on this runner.
- Keep database changes backward-compatible during blue-green overlap. Destructive
  migrations require a separate tested backup and recovery design.
- Keep at least the current and previous image. Cleanup is explicit and never removes
  either protected release.
