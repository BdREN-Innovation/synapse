# Parallel Docker candidate CI/CD for BdREN

This pipeline lets you build and test Docker deployments on `203.96.189.213` without replacing or
reconfiguring the running PM2 production deployment.

The current production topology remains the source of truth:

- PM2 `synapse` continues serving `127.0.0.1:3080`.
- Host Nginx continues serving `https://chat.bdren.ai` and is never modified or reloaded.
- PM2 `synapse-admin` continues serving `127.0.0.1:3000`.
- Production host MongoDB and Redis are not used by the Docker candidate.
- The interpreter remains on `203.96.189.202` behind its current Docker/Caddy configuration.

The new candidate lane runs separately:

```text
127.0.0.1:3081 -> synapse-candidate Docker container
                         |
                         +-> isolated candidate MongoDB container
                         +-> isolated candidate Redis container
                         +-> existing interpreter.bdren.ai over HTTPS
```

There is intentionally no production cutover command in this phase. After you validate Docker,
we can design a separate, explicitly approved Nginx blue-green cutover and retire PM2.

## What the pipeline provides

- Immutable images named `synapse-candidate:<40-character-commit-sha>`.
- A preflight container on `127.0.0.1:3082` before replacing the previous candidate.
- Candidate readiness checks through `/readyz`.
- Automatic restoration of the previous candidate if activation fails.
- Manual candidate rollback.
- Isolated MongoDB, Redis, uploads, logs, images, and runtime data.
- No Docker ports exposed publicly.
- No production migration, PM2 restart, Nginx reload, or Caddy change.

## Deployment flow

```text
feature PR -> main -> release PR to production -> Production Gate
                                               |
                                               +-> tests and Docker image build check

merge to production -> self-hosted candidate runner
                     -> build SHA-tagged Docker image
                     -> start isolated MongoDB and Redis
                     -> run candidate migration against candidate DB
                     -> preflight image on localhost:3082
                     -> activate candidate on localhost:3081
                     -> retain previous candidate image for rollback
```

## Important isolation boundary

The candidate scripts override these values regardless of what appears in the copied `.env`:

```dotenv
MONGO_URI=mongodb://candidate-mongodb:27017/SynapseCandidate
REDIS_URI=redis://candidate-redis:6379
REDIS_KEY_PREFIX=synapse-candidate
SEARCH=false
PORT=3080
```

This prevents tests from writing to production MongoDB or Redis. The candidate `.env` may still
contain real provider credentials and the interpreter URL, so it remains a root-only secret.

## Step 1: Verify production before adding Docker

SSH to the application server and capture the healthy baseline:

```sh
ssh bdren@203.96.189.213
pm2 status
curl -fsS http://127.0.0.1:3080/health
curl -fsS https://chat.bdren.ai/health
curl -fsS https://interpreter.bdren.ai/v1/health
sudo nginx -t
sudo systemctl status nginx mongod redis-server --no-pager
```

Nothing in the remaining setup should change these results. If production is unhealthy, fix it
before introducing the candidate lane.

## Step 2: Install Docker Engine and Compose

For a non-interactive installation on the documented Ubuntu 24.04 server, run the repository
installer as root:

```sh
sudo /home/bdren/synapse/deploy/install-docker.sh
```

The script validates Ubuntu 24.04/`noble` and `amd64` or `arm64`, repairs or creates Docker's
signed APT repository configuration, installs Docker Engine/Buildx/Compose, enables Docker and
containerd at boot, verifies the services, and runs a `hello-world` container. It is safe to run
again. It does not add any user to the privileged `docker` group.

If the repository has not yet been cloned to `/home/bdren/synapse`, copy the script from the trusted
checkout and run it there:

```sh
sudo install -m 0750 deploy/install-docker.sh /usr/local/sbin/synapse-install-docker
sudo /usr/local/sbin/synapse-install-docker
```

The script requires outbound HTTPS access to `download.docker.com` and Docker Hub for the smoke
test. It intentionally stops on unsupported operating systems, architectures, failed package
updates, invalid repository configuration, or an unhealthy Docker service.

The deployment notes identify the host as Ubuntu 24.04.3 LTS. Confirm that before installing:

```sh
source /etc/os-release
printf 'OS: %s %s (%s)\n' "$NAME" "$VERSION_ID" "$VERSION_CODENAME"
dpkg --print-architecture
```

Install Docker Engine from Docker's official apt repository, including Buildx and the Compose
plugin. Do not use an unreviewed convenience script on the production server:

```sh
sudo apt update
sudo apt install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

. /etc/os-release
docker_suite="${UBUNTU_CODENAME:-$VERSION_CODENAME}"
docker_arch="$(dpkg --print-architecture)"
[[ "$docker_suite" == noble ]] || { printf 'Unexpected Ubuntu codename: %s\n' "$docker_suite" >&2; exit 1; }

sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $docker_suite
Components: stable
Architectures: $docker_arch
Signed-By: /etc/apt/keyrings/docker.asc
EOF

sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin
```

Start Docker and enable it after reboot:

```sh
sudo systemctl enable --now docker
sudo systemctl enable containerd
sudo systemctl status docker --no-pager
docker --version
docker compose version
sudo docker run --rm hello-world
```

The Docker socket grants effective root control of the host. Do not add `bdren`, `synapse-runner`,
or ordinary users to the `docker` group. The workflow invokes the root-owned candidate command via
the narrowly scoped sudo rule, and only that command uses Docker.

Docker may change host firewall rules. Confirm that existing Nginx and SSH access still work:

```sh
sudo ss -lntp | grep -E ':(22|80|443|3080|3081|3082)\b'
sudo nginx -t
curl -fsS https://chat.bdren.ai/health
```

The candidate scripts bind only to `127.0.0.1:3081` and `127.0.0.1:3082`; they must never publish
these ports on `0.0.0.0`. Candidate MongoDB and Redis have no host-published ports.

Do not expose `/var/run/docker.sock` over TCP or configure a remote Docker API. Docker documents
that an unprotected remote daemon provides root-level host access. Rootless Docker is possible, but
this pipeline expects the system Docker daemon and root-scoped commands; switching to rootless mode
requires a separate runner design.

## Step 3: Install candidate CI/CD assets

From the existing trusted checkout:

```sh
cd /home/bdren/synapse
sudo bash deploy/bootstrap.sh
```

This creates:

```text
/home/bdren/synapse/
  bin/                    root-owned candidate commands
  config/deploy.env       non-secret pipeline controls
  config/candidate.yml    isolated MongoDB/Redis Compose file
  candidate/.env          candidate application secrets (you create this)
  candidate/librechat.yaml
  candidate/uploads/
  candidate/logs/
  candidate/images/
  candidate/data/
  state/release.env
```

Bootstrap does not start or restart PM2, Nginx, MongoDB, Redis, the admin panel, or the interpreter.

## Step 4: Configure the candidate application

Copy the existing production environment as a starting point, then edit the candidate copy:

```sh
sudo cp /opt/synapse/.env /home/bdren/synapse/candidate/.env
sudo cp /opt/synapse/librechat.yaml /home/bdren/synapse/candidate/librechat.yaml
sudo cp -a /opt/synapse/client/public/images/. /home/bdren/synapse/candidate/images/
sudo chmod 600 /home/bdren/synapse/candidate/.env
sudo chmod 640 /home/bdren/synapse/candidate/librechat.yaml
sudo editor /home/bdren/synapse/candidate/.env
```

Use candidate-facing values where appropriate:

```dotenv
DOMAIN_CLIENT=http://localhost:3081
DOMAIN_SERVER=http://localhost:3081
ALLOW_REGISTRATION=true
SEARCH=false
LIBRECHAT_LOG_DIR=/app/api/logs
```

`ALLOW_REGISTRATION=true` is reasonable only because the candidate is loopback-only and reached
through an SSH tunnel. It lets you create a separate candidate test account. Set it back to false
if you later expose the candidate through a staging hostname.

Keep the current interpreter configuration so document-generation tests exercise the real remote
service:

```dotenv
LIBRECHAT_CODE_BASEURL=https://interpreter.bdren.ai/v1
```

The interpreter JWT settings must match the interpreter service. Provider keys may be retained for
real model testing, but remember that candidate requests consume provider credits.

Do not manually point candidate `MONGO_URI` or `REDIS_URI` at production. The runner overrides both
as a defense-in-depth measure.

Review pipeline controls:

```sh
sudo editor /home/bdren/synapse/config/deploy.env
sudo chmod 600 /home/bdren/synapse/config/deploy.env
```

Expected settings:

```dotenv
EXPECTED_REPOSITORY_SLUG=nafew0/synapse
DEPLOY_BRANCH=production
CANDIDATE_ENV_FILE=/home/bdren/synapse/candidate/.env
CANDIDATE_CONFIG_FILE=/home/bdren/synapse/candidate/librechat.yaml
CANDIDATE_PORT=3081
PREFLIGHT_PORT=3082
READY_ATTEMPTS=90
RUN_USAGE_POLICY_MIGRATION=true
KEEP_IMAGES=3
```

## Step 5: Start only the candidate data services

You may start and inspect the isolated MongoDB and Redis before configuring GitHub:

```sh
sudo docker compose \
  -f /home/bdren/synapse/config/candidate.yml \
  -p synapse-candidate-services up -d

sudo docker compose \
  -f /home/bdren/synapse/config/candidate.yml \
  -p synapse-candidate-services ps
```

Neither service publishes a host port. Confirm:

```sh
sudo docker ps --format 'table {{.Names}}\t{{.Ports}}'
sudo ss -lntp | grep -E ':(27017|6379)\b'
```

The only host listeners for MongoDB and Redis should still be the existing production loopback
services. Candidate data services communicate only through the `synapse-candidate` Docker network.

## Step 6: Install the self-hosted GitHub runner

Create a dedicated runner account:

```sh
sudo useradd --create-home --shell /bin/bash synapse-runner
sudo install -d -o synapse-runner -g synapse-runner /opt/actions-runner
```

In GitHub, open **Settings → Actions → Runners → New self-hosted runner**, select Linux x64, then
run GitHub's current download and registration commands as `synapse-runner`:

```sh
sudo -iu synapse-runner
cd /opt/actions-runner
# Run the download/checksum/extract/config commands displayed by GitHub.
```

Use:

- Runner name: `bdren-synapse-candidate-01`
- Custom label: `synapse-candidate`
- Work folder: `_work`

Install its systemd service:

```sh
exit
cd /opt/actions-runner
sudo ./svc.sh install synapse-runner
sudo ./svc.sh start
sudo ./svc.sh status
```

The runner does not need Docker-group membership because the reviewed root deployment command
performs Docker operations. Do not grant the runner direct Docker access.

## Step 7: Configure restricted sudo

Open a sudoers file:

```sh
sudo visudo -f /etc/sudoers.d/synapse-runner
```

Add:

```text
synapse-runner ALL=(root) NOPASSWD: /home/bdren/synapse/bin/sync, /home/bdren/synapse/bin/deploy, /home/bdren/synapse/bin/rollback, /home/bdren/synapse/bin/status, /home/bdren/synapse/bin/cleanup
```

Validate:

```sh
sudo chmod 440 /etc/sudoers.d/synapse-runner
sudo visudo -cf /etc/sudoers.d/synapse-runner
sudo -u synapse-runner sudo -n /home/bdren/synapse/bin/status
```

Anyone who can cause a job to execute on this runner can potentially deploy code. Keep the
repository private, limit write access, and review all changes under `.github/workflows/` and
`deploy/`.

## Step 8: Configure GitHub protection

Protect `production` and require:

1. A pull request from `main`.
2. At least one approval.
3. Resolved review conversations.
4. The **Production Gate / gate** check.
5. No force pushes or branch deletion.

Create a GitHub Environment named `candidate`:

1. Restrict it to the protected `production` branch.
2. Add a required reviewer if supported by your GitHub plan.
3. Store no application secrets there; candidate secrets remain on the server.

Pull requests use GitHub-hosted runners. Only a merge to `production` or explicit candidate rollback
uses the company-server runner.

## Step 9: Deploy the first Docker candidate

Open a pull request from `main` to `production`. After Production Gate and review, merge it and
watch **Docker Candidate Deploy** in GitHub Actions.

The job:

1. Verifies the checkout exactly matches `origin/production`.
2. Synchronizes root-owned candidate scripts from that commit.
3. Builds `synapse-candidate:<commit-sha>` using `Dockerfile.multi` target `api-build`.
4. Starts isolated candidate MongoDB and Redis.
5. Runs the usage-policy migration against `SynapseCandidate`, never production.
6. Boots a preflight container on `127.0.0.1:3082` and waits for `/readyz`.
7. Replaces the prior candidate on `127.0.0.1:3081` only after preflight succeeds.
8. Restores the previous candidate image if final activation fails.

Check status:

```sh
sudo /home/bdren/synapse/bin/status
sudo docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
curl -fsS http://127.0.0.1:3081/readyz
curl -fsS http://127.0.0.1:3080/health
curl -fsS https://chat.bdren.ai/health
pm2 status
```

The final three commands prove production is still owned by PM2 and remains healthy.

## Step 10: Test from your computer through SSH

Create a tunnel from your computer:

```sh
ssh -L 3081:127.0.0.1:3081 bdren@203.96.189.213
```

Keep that terminal open and visit:

```text
http://localhost:3081
```

Create a candidate-only account, then test:

- Login and logout.
- Normal chat and streaming responses.
- OpenAI, Anthropic, OpenRouter, and NVIDIA endpoints you intend to support.
- File upload and download.
- Follow-up prompts and clarifying questions.
- Document generation through `interpreter.bdren.ai`.
- Refresh/reconnect behavior with candidate Redis streams.
- Container restart persistence.

Inspect candidate logs without mixing them with PM2 logs:

```sh
sudo docker logs --tail 200 -f synapse-candidate
```

## Candidate rollback

After two successful candidate deployments:

```sh
sudo /home/bdren/synapse/bin/rollback
```

You can also run **Docker Candidate Deploy** manually from the `production` branch and provide an
existing candidate SHA. A blank SHA selects the recorded previous candidate.

Rollback affects only the container on port 3081. PM2 production remains untouched.

## Candidate cleanup and reset

Remove old candidate images while preserving current, previous, and configured recent images:

```sh
sudo /home/bdren/synapse/bin/cleanup
```

To stop the candidate application without touching production:

```sh
sudo docker rm -f synapse-candidate
```

To stop candidate MongoDB and Redis while preserving their named volumes:

```sh
sudo docker compose \
  -f /home/bdren/synapse/config/candidate.yml \
  -p synapse-candidate-services down
```

Deleting candidate volumes permanently removes candidate accounts and conversations. Do this only
when you intentionally want a clean test environment:

```sh
sudo docker compose \
  -f /home/bdren/synapse/config/candidate.yml \
  -p synapse-candidate-services down --volumes
```

## What is not automated yet

This phase does not:

- Send public Nginx traffic to Docker.
- Stop or remove PM2.
- Move production MongoDB or Redis into Docker.
- Deploy the admin panel as a container.
- Change the interpreter server.
- Copy candidate data into production.

After candidate testing succeeds, the next phase should add an explicit promotion workflow:

1. Run a Docker container against production host services with reviewed connectivity.
2. Preflight on an inactive localhost port.
3. Change a small Nginx upstream include from PM2 port 3080 to Docker port 3081/3082.
4. Validate and gracefully reload Nginx.
5. Run public health and business smoke tests.
6. Automatically restore the previous Nginx upstream on failure.
7. Keep PM2 available during a defined observation period.
8. Retire PM2 only after sustained successful Docker operation and a tested rollback.

That cutover must be implemented and approved separately; the candidate pipeline cannot perform it
accidentally.

## Troubleshooting

- **Image build fails:** PM2 production and the previous candidate remain running. Check Actions,
  `free -h`, `df -h`, and `docker system df`.
- **Preflight fails:** inspect `docker logs synapse-candidate-preflight`. The current candidate is
  not replaced.
- **Candidate activation fails:** inspect `docker logs synapse-candidate`; the script attempts to
  restore the prior candidate image.
- **Candidate cannot reach models:** verify provider keys in candidate `.env`; requests consume
  real provider credits.
- **Document generation fails:** test `https://interpreter.bdren.ai/v1/health` from the app server
  and verify matching interpreter JWT settings.
- **Candidate works locally but not in the browser:** confirm the SSH tunnel is still open and
  `DOMAIN_CLIENT`/`DOMAIN_SERVER` use `http://localhost:3081`.
- **Production changes unexpectedly:** stop immediately and compare `pm2 status`, Nginx config, and
  ports. Candidate scripts contain no PM2 or Nginx operations.

## Safety rules

- Never publish ports 3081, 3082, candidate MongoDB, or candidate Redis publicly.
- Never commit candidate `.env` or provider credentials.
- Do not add the runner to the Docker group.
- Keep production and candidate databases separate.
- Do not expose the candidate with production cookies or production OAuth callbacks without a
  separate staging hostname and reviewed configuration.
- Continue production backups and monitoring from `docs/production-runbook.md`.
- Treat Docker validation and production cutover as separate projects with separate approvals.
