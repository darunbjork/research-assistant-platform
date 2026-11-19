# deploy/k8s — ResearchBot on the shared k3s cluster

Target: `https://research.voxcript.app`, namespace `researchbot`, on the
single-node k3s cluster shared with Transcribe (which lives in `default` and is
never touched from here).

| Path | What | Applied by |
|---|---|---|
| `kustomization.yaml` | entry point, renders `overlays/voxcript` | deploy workflow |
| `base/data/` | tier `data`: NetworkPolicies, `researchbot-config`, postgres, redis | deploy workflow, first |
| `base/app/` | tier `app`: backend, web, Ingress, Certificate, Traefik middlewares, ServiceMonitor, Grafana dashboards, db-backup CronJob | deploy workflow, after migrations |
| `overlays/voxcript/` | host and CORS origin for research.voxcript.app | deploy workflow |
| `components/images/` | digest placeholders for backend, migrator and web | replaced at deploy time |
| `migrate/` | the `prisma migrate deploy` Job | deploy workflow, between the tiers |
| `admin/` | the ResourceQuota and the `deployer` RBAC | **the human**, once, with cluster-admin |

## How a deploy runs

`.github/workflows/deploy.yml` runs after the Images workflow succeeds on
`main`, or by hand with a commit SHA (redeploy or roll back). It opens an SSH
tunnel to the API server, then runs `scripts/k8s-deploy.sh` as the
namespace-scoped `deployer`:

1. **Render** with the digests from that Images run's `image-digests`
   artifact (`scripts/k8s-render.sh`). Only digests are deployed, never `:main`.
2. **Data tier**: `kubectl apply -l researchbot.io/tier=data`, then wait for
   postgres and redis to be Ready.
3. **Migrate**: delete the previous `migrate` Job, apply the new one, wait for
   Complete. **On failure: print its logs and stop. The app is not touched.**
4. **App tier**: `kubectl apply -l researchbot.io/tier=app`, then wait for the
   backend and web rollouts.
5. **TLS and smoke check**: wait up to 5 minutes for
   `certificate/researchbot-tls` to be Ready (instant after the first
   deploy; on timeout the deploy prints `kubectl describe
   certificate,certificaterequest,order,challenge` and fails), then expect
   `GET /health` = 200 for up to 2 minutes.
6. **On any failure in 4–5**: `kubectl rollout undo` backend and web to the
   revisions that were live before the deploy, then fail. On the very first
   deploy there's nothing to roll back to; the failed pods stay for
   inspection.

To redeploy or roll back: Actions → Deploy → Run workflow → the full commit
SHA. Its manifests are deployed together with its images. The Images run's
artifact is kept 90 days; for an older commit, run Images for it first.

### Migrations must be backward compatible

A rollback, automatic or by hand, **reverts pods, not the schema**.
Migrations run before the new backend starts and are never undone, so after a
rollback the *previous* backend runs against the *new* schema. Every
migration must therefore work with the release before it:

- **Add, don't change.** New columns are nullable or have a default; new
  tables and indexes are fine.
- **Rename or drop in two releases.** First ship code that stops using the
  old column (and, for a rename, writes both); drop or rename it in a later
  release.
- **No destructive data rewrites** in the same release that depends on them.
- **Never drop `document_chunks_embedding_hnsw_idx`** (CI blocks `DROP INDEX`).

If a schema change can't be made compatible, restore the database from the
R2 backup instead of rolling back (see the runbook).

## Render and validate (offline)

```bash
kubectl kustomize deploy/k8s            # app (placeholder digests)
kubectl kustomize deploy/k8s/migrate    # migrate Job
BACKEND_DIGEST=sha256:… MIGRATOR_DIGEST=sha256:… WEB_DIGEST=sha256:… \
  ./scripts/k8s-render.sh /tmp/rendered # exactly what a deploy applies
```

CI's "Kubernetes manifests" job runs `k8s-render.sh` with dummy digests and
validates the result with `kubeconform -strict` (CRD schemas included).

## Secrets: created by hand on the cluster, never committed

The manifests only reference these by name; CI fails if a manifest ever
defines a Secret. The deployer has **no** access to Secrets.

| Secret | Keys | Used by |
|---|---|---|
| `researchbot-secrets` | see below | backend (all keys, `envFrom`), postgres (`POSTGRES_PASSWORD`), migrate Job and db-backup (`DATABASE_URL`), Prometheus via the ServiceMonitor (`METRICS_TOKEN`) |
| `r2-backup` | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_ENDPOINT` | db-backup upload container (already created) |
| `deployer-token` | `token`, `ca.crt` (filled in by Kubernetes) | nobody in-cluster: its token goes into the CI kubeconfig |

### `researchbot-secrets`

| Key | Value / how to generate |
|---|---|
| `POSTGRES_PASSWORD` | `openssl rand -hex 24` (hex: safe inside a URL). Only applied when the postgres volume is first initialised; changing it later needs `ALTER USER rag PASSWORD …` too. |
| `DATABASE_URL` | `postgresql://rag:<POSTGRES_PASSWORD>@postgres:5432/ragdb?connection_limit=10` |
| `REDIS_URL` | `redis://redis:6379` |
| `JWT_SECRET` | `openssl rand -hex 32` |
| `JWT_REFRESH_SECRET` | `openssl rand -hex 32` (must differ from `JWT_SECRET`) |
| `GEMINI_API_KEY` | Google AI Studio → API keys |
| `METRICS_TOKEN` | `openssl rand -hex 24` (≥ 24 chars). Required: the ServiceMonitor sends it. |
| `DEEPGRAM_API_KEY` | only when `VOICE_MOCK=false`: Deepgram console |
| `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` | only when `TTS_PROVIDER=elevenlabs`: ElevenLabs → API keys / Voices |

Leave the three voice keys out while voice is mocked (the defaults in
`base/data/kustomization.yaml`). Create the Secret from a file that never
touches the repo, values unquoted:

```bash
umask 077
cat > /tmp/researchbot.env <<'EOF'
POSTGRES_PASSWORD=…
DATABASE_URL=postgresql://rag:…@postgres:5432/ragdb?connection_limit=10
REDIS_URL=redis://redis:6379
JWT_SECRET=…
JWT_REFRESH_SECRET=…
GEMINI_API_KEY=…
METRICS_TOKEN=…
EOF
kubectl -n researchbot create secret generic researchbot-secrets --from-env-file=/tmp/researchbot.env
rm -P /tmp/researchbot.env   # macOS; `shred -u` on Linux
```

To change a value later: `kubectl -n researchbot create secret generic
researchbot-secrets --from-env-file=… --dry-run=client -o yaml | kubectl apply -f -`,
then `kubectl -n researchbot rollout restart deployment/backend` (pods read
Secrets only at start).

## Deployer credentials (one-time, by the human)

Run on a machine with cluster-admin (e.g. on the VPS). Nothing below is
committed; the token only ever lives in the kubeconfig you upload to GitHub.

**1. Quota and RBAC**

```bash
kubectl apply -f deploy/k8s/admin/resourcequota.yaml -f deploy/k8s/admin/deployer-rbac.yaml
```

**2. A long-lived token for the `deployer` ServiceAccount**

```bash
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: Secret
metadata:
  name: deployer-token
  namespace: researchbot
  annotations:
    kubernetes.io/service-account.name: deployer
type: kubernetes.io/service-account-token
EOF
```

Kubernetes fills in `token` and `ca.crt` within a second or two.

**3. The kubeconfig** (server = the tunnel's local end; CA = the cluster CA
from the token Secret)

```bash
umask 077
TOKEN="$(kubectl -n researchbot get secret deployer-token -o jsonpath='{.data.token}' | base64 --decode)"
CA="$(kubectl -n researchbot get secret deployer-token -o jsonpath='{.data.ca\.crt}')"
cat > deployer.kubeconfig <<EOF
apiVersion: v1
kind: Config
clusters:
  - name: voxcript
    cluster:
      server: https://127.0.0.1:6443
      certificate-authority-data: ${CA}
users:
  - name: deployer
    user:
      token: ${TOKEN}
contexts:
  - name: researchbot-deployer
    context:
      cluster: voxcript
      user: deployer
      namespace: researchbot
current-context: researchbot-deployer
EOF
unset TOKEN CA
```

**4. Check it** (through the tunnel from your laptop:
`ssh -i <deploy-rb key> -f -N -L 6443:127.0.0.1:6443 deploy-rb@<host>`)

```bash
export KUBECONFIG=$PWD/deployer.kubeconfig
kubectl auth can-i --list                    # the Role's rules only
kubectl auth can-i get secrets               # no
kubectl auth can-i list pods -n default      # no
kubectl auth can-i create clusterroles       # no
```

**5. GitHub secrets** (environment `production`)

```bash
gh secret set KUBE_CONFIG --env production < deployer.kubeconfig
gh secret set DEPLOY_HOST --env production --body '<VPS IP>'
gh secret set DEPLOY_SSH_KEY --env production < <private key for deploy-rb>
ssh-keyscan -t ed25519 <VPS IP> > known_hosts.deploy
ssh-keygen -lf known_hosts.deploy            # must print SHA256:FXKJAovhjJRn9zSKMuIYDIWDdY9ydQSEXGsXQ090A0M
gh secret set DEPLOY_KNOWN_HOSTS --env production < known_hosts.deploy
rm -P deployer.kubeconfig known_hosts.deploy
```

Only upload `known_hosts.deploy` if the fingerprint matches.

**Rotate or revoke** the token: `kubectl -n researchbot delete secret
deployer-token`, then repeat steps 2, 3 and 5. Deleting it invalidates the
old token immediately.

## Images

The GHCR packages are **public** and pulled anonymously: no pod has an
`imagePullSecrets`. Deliberately so: GHCR answers 403 when a pull sends
invalid credentials, even for a public package, so an expired pull token
would break every pull. (The hand-made `ghcr-pull` Secret is unused and can
be deleted: `kubectl -n researchbot delete secret ghcr-pull`.)

All images are pinned by digest. Third-party images (pgvector, redis,
aws-cli) carry their digest inline. ResearchBot's own images get theirs at
deploy time; the all-zero placeholders in `components/images` make a manual
`kubectl apply -k deploy/k8s` fail with an image pull error, on purpose.

## Dashboards

`base/app/dashboards/*.json` are generated from `monitoring/grafana/dashboards/`
with titles prefixed `ResearchBot · `. After changing a dashboard, run
`./scripts/sync-k8s-dashboards.sh` and commit both; CI fails if they differ.
