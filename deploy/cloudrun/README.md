# Deploying the backend to Google Cloud Run

The API runs on **Cloud Run** with a **Cloud SQL (MySQL 8)** database. A Cloud SQL Auth Proxy
sidecar sits next to the API container, so the database needs no public IP allowlist and
`DATABASE_URL` points at `127.0.0.1:3306` (see `src/config/database-ssl.ts`).

| File | Purpose |
| --- | --- |
| `Dockerfile` (repo root) | `runtime` target: the API image. `migrate` target: Prisma CLI for migrations. |
| `deploy/cloudrun/service.yaml` | Cloud Run service `chamaro-api` (already exists): API + Cloud SQL proxy sidecar. |
| `deploy/cloudrun/migrate-job.yaml` | Cloud Run job that runs `prisma migrate deploy`. |

## What you need

- A Google Cloud project with billing enabled, and a region (for example `asia-south1`).
- A Cloud SQL for MySQL instance (existing or new), a database and a user for the app.
- Values for: `DATABASE_URL`, `JWT_SECRET` (32+ random characters), `GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET`, `CORS_ORIGIN` (admin and web origins, comma separated),
  `GOOGLE_REDIRECT_URI` and `GOOGLE_FRONTEND_CALLBACK_URL`.

## One-time setup

```sh
PROJECT_ID=project-2e1ca4ee-4c62-4f01-a4c
REGION=asia-south1
INSTANCE=free-trial-first-project   # MySQL 8.4, Enterprise Plus
gcloud config set project $PROJECT_ID

gcloud services enable run.googleapis.com sqladmin.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com cloudbuild.googleapis.com

gcloud artifacts repositories create chamaro --repository-format=docker --location=$REGION

# Runtime identity for the service and the migration job.
gcloud iam service-accounts create chamaro-backend
SA=chamaro-backend@$PROJECT_ID.iam.gserviceaccount.com
gcloud projects add-iam-policy-binding $PROJECT_ID --member=serviceAccount:$SA --role=roles/cloudsql.client

# Database: the instance exists already, so skip `instances create`; create the database and user if missing.
gcloud sql instances create $INSTANCE --database-version=MYSQL_8_0 --region=$REGION --tier=db-f1-micro
gcloud sql databases create chamaro --instance=$INSTANCE
gcloud sql users create chamaro --instance=$INSTANCE --password='<db-password>'

# Secrets. DATABASE_URL always uses 127.0.0.1 (the proxy sidecar); URL-encode the password.
printf 'mysql://chamaro:<db-password>@127.0.0.1:3306/chamaro' | gcloud secrets create chamaro-database-url --data-file=-
openssl rand -base64 48 | tr -d '\n' | gcloud secrets create chamaro-jwt-secret --data-file=-
printf '<google-client-secret>' | gcloud secrets create chamaro-google-client-secret --data-file=-
for s in chamaro-database-url chamaro-jwt-secret chamaro-google-client-secret; do
  gcloud secrets add-iam-policy-binding $s --member=serviceAccount:$SA --role=roles/secretmanager.secretAccessor
done
```

## Each release

```sh
TAG=$(git rev-parse --short HEAD)
REPO=$REGION-docker.pkg.dev/$PROJECT_ID/chamaro

# Build both images with Cloud Build (no local Docker needed).
gcloud builds submit --tag $REPO/chamaro-backend:$TAG .   # builds the last stage, `runtime`
# The migrate image needs --target; with Docker locally:
docker build --target migrate -t $REPO/chamaro-migrate:$TAG . && docker push $REPO/chamaro-migrate:$TAG

# Fill the placeholders in both YAML files (PROJECT_ID, TAG, URLs), then:
gcloud run jobs replace deploy/cloudrun/migrate-job.yaml --region $REGION
gcloud run jobs execute chamaro-migrate --region $REGION --wait
# chamaro-api already exists: compare with its live config first so no env var is lost.
gcloud run services describe chamaro-api --region $REGION --format export > live-chamaro-api.yaml
gcloud run services replace deploy/cloudrun/service.yaml --region $REGION
gcloud run services add-iam-policy-binding chamaro-api --region $REGION \
  --member=allUsers --role=roles/run.invoker   # public API
```

First deploy only: create the admin account by running `npm run admin:create` against the
database (for example through `cloud-sql-proxy` on your machine), or seed with `npm run prisma:seed`.

After deploying, add the Cloud Run URL (or your custom domain) callback to the Google OAuth client's
authorized redirect URIs, and point the admin and web frontends at the new API URL.

## Notes

- Swagger (`/docs`) is off in production, as before. `/health` is the startup probe.
- Request logs record `remoteAddress`; check after the first deploy that it shows real visitor
  IPs, since the login rate limit keys on it (`trustProxy` in `src/app.ts` trusts link-local and
  private proxies, which should cover Cloud Run's front end).
- The temporary Hostinger startup and database diagnostics in `src/server.ts` still run and log
  only non-secret values; they can be removed once the move is done.
