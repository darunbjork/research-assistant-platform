# Restore runbook — Postgres (task 5.7)

Backups come from `deploy/backup.sh`: a nightly `pg_dump -Fc` (custom format)
into `/var/backups/rap/rap-<UTC timestamp>.dump`. The newest **7** dumps are
kept; older ones are deleted after each successful run.

Install (root crontab on the server):

```cron
# nightly at 03:15 UTC — keep the newest 7 dumps
15 3 * * * /srv/research-assistant-platform/deploy/backup.sh >> /var/log/rap-backup.log 2>&1
```

`backup.sh` environment overrides (all optional):

| Variable       | Default                 | Purpose                              |
| -------------- | ----------------------- | ------------------------------------ |
| `ENV_FILE`     | `.env.production`       | source of `POSTGRES_USER` / `POSTGRES_DB` and compose substitutions |
| `COMPOSE_FILE` | `docker-compose.prod.yml` | compose file defining the `postgres` service |
| `BACKUP_DIR`   | `/var/backups/rap`      | where `.dump` files are written      |
| `KEEP`         | `7`                     | how many dumps to keep               |

The commands below are run from the repository root on the server, where
`.env.production` lives. `POSTGRES_USER` / `POSTGRES_DB` are the values in that
file (e.g. `rap`).

## Restore into the production database

```bash
# 1. Stop the app so nothing writes during the restore.
docker compose --env-file .env.production -f docker-compose.prod.yml stop backend

# 2. Pick the dump (newest first).
ls -1t /var/backups/rap/rap-*.dump | head -1

# 3. Restore — custom format, --clean drops existing objects first,
#    --if-exists tolerates objects that are not there yet.
docker compose --env-file .env.production -f docker-compose.prod.yml exec -T postgres \
  pg_restore --clean --if-exists -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  < /var/backups/rap/rap-<timestamp>.dump

# 4. Verify row counts (compare with the source before/after).
docker compose --env-file .env.production -f docker-compose.prod.yml exec -T postgres \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "SELECT count(*) FROM document_chunks;" \
  -c "SELECT count(*) FROM documents;" \
  -c "SELECT count(*) FROM users;"

# 5. Restart and confirm health.
docker compose --env-file .env.production -f docker-compose.prod.yml start backend
curl -fsS https://<domain>/health
```

If `pg_restore` reports errors about individual objects, inspect them —
`--clean --if-exists` continues past object errors by design; a non-zero exit
still deserves a look before restarting the backend.

## Drill — restore into a scratch container (runbook test)

Run this after every change to `deploy/backup.sh`, and at least once before
relying on it. It never touches the real database.

```bash
DUMP=$(ls -1t /var/backups/rap/rap-*.dump | head -1)

# Source counts.
docker compose --env-file .env.production -f docker-compose.prod.yml exec -T postgres \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT count(*) FROM document_chunks;"

# Fresh scratch database (same image as production).
docker run -d --name rap-restore-drill \
  -e POSTGRES_USER="$POSTGRES_USER" -e POSTGRES_PASSWORD=drill \
  -e POSTGRES_DB="$POSTGRES_DB" pgvector/pgvector:pg16
until docker exec rap-restore-drill pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"; do sleep 1; done

# Restore and count — must match the source.
docker exec -i rap-restore-drill \
  pg_restore --clean --if-exists -U "$POSTGRES_USER" -d "$POSTGRES_DB" < "$DUMP"
docker exec rap-restore-drill \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT count(*) FROM document_chunks;"

docker rm -f rap-restore-drill
```

Drill result 2026-11-12 (local production rehearsal): source
`document_chunks` / `documents` / `users` = `1 / 1 / 1` (fixture rows inserted
for the drill, removed afterwards), restored scratch container identical
`1 / 1 / 1`, `pg_restore` exit 0. The `KEEP=7` pruning was verified in the
same run (10 dumps on disk → 7 after `backup.sh`).
