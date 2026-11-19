# deploy/k8s — ResearchBot on the shared k3s cluster

Target: `https://research.voxcript.app`, namespace `researchbot`, on the
single-node k3s cluster shared with Transcribe (which lives in `default` and is
never touched from here).

| Path | What | Applied by |
|---|---|---|
| `kustomization.yaml` | entry point, renders `overlays/voxcript` | deploy workflow (Phase B3) |
| `base/` | postgres, redis, backend, web, Ingress, Traefik middlewares, ServiceMonitor, Grafana dashboards, NetworkPolicies, db-backup CronJob, `default` ServiceAccount patch | deploy workflow |
| `overlays/voxcript/` | host and CORS origin for research.voxcript.app | deploy workflow |
| `components/images/` | image digests for backend, migrator and web, shared by the app and the migrate Job | filled in by the deploy workflow |
| `migrate/` | the `prisma migrate deploy` Job, run before every rollout | deploy workflow |
| `admin/` | the namespace ResourceQuota | **the human**, once, with cluster-admin |

## Render and validate (offline)

```bash
kubectl kustomize deploy/k8s            # app
kubectl kustomize deploy/k8s/migrate    # migrate Job
```

CI's "Kubernetes manifests" job renders both and validates them with
`kubeconform -strict` (CRD schemas included).

## Created by hand on the cluster, never committed

| Object | Contents |
|---|---|
| Namespace `researchbot` | already exists |
| Secret `researchbot-secrets` | `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `GEMINI_API_KEY`, `METRICS_TOKEN` (required: the ServiceMonitor uses it), `POSTGRES_PASSWORD`, and when voice is enabled `DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` |
| Secret `r2-backup` | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_ENDPOINT` (bucket-scoped token for `researchbot-db-backups`) |
| Secret `ghcr-pull` | docker-registry, `read:packages` |

`DATABASE_URL` and `REDIS_URL` use the in-namespace Service names:
`postgresql://rag:<POSTGRES_PASSWORD>@postgres:5432/ragdb?connection_limit=10`
and `redis://redis:6379`.

## Images

All images are pinned by digest. Third-party images (pgvector, redis,
aws-cli) carry their digest inline. ResearchBot's own images get theirs from
`components/images`, whose all-zero placeholders are replaced by the deploy
workflow with the digests `.github/workflows/images.yml` reports. Applying the
placeholders by hand fails with an image pull error, on purpose.

## Dashboards

`base/dashboards/*.json` are generated from `monitoring/grafana/dashboards/`
with titles prefixed `ResearchBot · `. After changing a dashboard, run
`./scripts/sync-k8s-dashboards.sh` and commit both; CI fails if they differ.
