# Deploying the backend to Google Cloud Run

The API runs on **Cloud Run** (service `chamaro-api`, region `asia-south1`, project
`project-2e1ca4ee-4c62-4f01-a4c`) with a **Cloud SQL for MySQL 8.4** database (instance
`free-trial-first-project`). Cloud Run's built-in Cloud SQL connection mounts the instance's Unix
socket, so `DATABASE_URL` has the form
`mysql://user:pass@localhost/db?socket=/cloudsql/project-2e1ca4ee-4c62-4f01-a4c:asia-south1:free-trial-first-project`
(see `src/plugins/prisma.ts`). There is no proxy sidecar.

| File | Purpose |
| --- | --- |
| `Dockerfile` (repo root) | `runtime` target: the API image. `migrate` target: Prisma CLI, schema and migrations. |
| `deploy/cloudrun/cloudbuild.yaml` | Builds both images for one commit, checks their contents, smoke-tests the API image, pushes both. |
| `deploy/cloudrun/service.yaml` | Record of the live `chamaro-api` configuration. Not applied directly (see below). |
| `deploy/cloudrun/migrate-job.yaml` | Cloud Run job `chamaro-migrate` that runs `prisma migrate deploy`. |

Images live in `asia-south1-docker.pkg.dev/project-2e1ca4ee-4c62-4f01-a4c/chamaro-images`
(`chamaro-api`, `chamaro-migrate`), tagged with the short Git commit. Never deploy `latest`.

Secrets (Secret Manager, read by the `chamaro-backend` service account): `DATABASE_URL`, `JWT_SECRET`,
`CORS_ORIGIN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`,
`GOOGLE_FRONTEND_CALLBACK_URL`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`. Plain settings: `APP_ENV`, `NODE_ENV`,
`HOST`, `APP_BASE_URL` (`https://chamaro.com`), optional `PASSWORD_RESET_TOKEN_TTL_MINUTES` (5-120, default 30).

## Each release

Run from a clean working tree on the commit being released.

```sh
P=project-2e1ca4ee-4c62-4f01-a4c; R=asia-south1
TAG=$(git rev-parse --short HEAD)
REPO=$R-docker.pkg.dev/$P/chamaro-images

# 1. Build, check and push both images (Cloud Build; no local Docker needed).
gcloud builds submit --project $P --region $R --config deploy/cloudrun/cloudbuild.yaml --substitutions _TAG=$TAG .

# 2. Point the migration job at this commit's migrate image (creates the job the first time).
sed "s/<TAG>/$TAG/" deploy/cloudrun/migrate-job.yaml > /tmp/migrate-job.yaml
gcloud run jobs replace /tmp/migrate-job.yaml --project $P --region $R

# 3. Read-only: list applied and pending migrations. Changes nothing.
gcloud run jobs execute chamaro-migrate --project $P --region $R --wait --args=migrate,status
#    Then read the execution's logs in Cloud Logging.

# 4. Only if migrations are pending: take a backup first, then apply them.
gcloud sql backups create --project $P --instance free-trial-first-project --description "before $TAG"
gcloud run jobs execute chamaro-migrate --project $P --region $R --wait

# 5. New revision with no traffic; every other live setting and secret reference is kept.
gcloud run deploy chamaro-api --project $P --region $R --image $REPO/chamaro-api:$TAG \
  --update-env-vars APP_BASE_URL=https://chamaro.com --no-traffic --tag c$TAG
#    Test it at the tagged URL printed by the command, then move traffic:
gcloud run services update-traffic chamaro-api --project $P --region $R --to-tags c$TAG=100
```

Rollback: `gcloud run services update-traffic chamaro-api --region $R --to-revisions <previous revision>=100`.
Migrations are additive, so the previous revision keeps working on the migrated schema.

Do not `gcloud run services replace deploy/cloudrun/service.yaml` unless it has first been diffed against
`gcloud run services describe chamaro-api --region $R --format export`: replace drops any setting missing from the
file and moves all traffic to the new revision at once.

## Notes

- Swagger (`/docs`) is off in production. `/health` does not touch the database.
- Migrations never run at application startup; only the `chamaro-migrate` job applies them.
- Request logs record `remoteAddress`; the login rate limit keys on it (`trustProxy` in `src/app.ts`).
- The temporary startup and database diagnostics in `src/server.ts` log only non-secret values.
