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
| `deploy/cloudrun/payment-worker-job.yaml` | Cloud Run job `chamaro-payment-worker`: reconciles Razorpay payments and expires unpaid orders. |
| `deploy/cloudrun/email-outbox-job.yaml` | Cloud Run job `chamaro-email-outbox`: retries the email outbox (API image, one pass, then exit). |

Images live in `asia-south1-docker.pkg.dev/project-2e1ca4ee-4c62-4f01-a4c/chamaro-images`
(`chamaro-api`, `chamaro-migrate`), tagged with the short Git commit. Never deploy `latest`.

Secrets (Secret Manager, read by the `chamaro-backend` service account): `DATABASE_URL`, `JWT_SECRET`,
`CORS_ORIGIN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`,
`GOOGLE_FRONTEND_CALLBACK_URL`, `RESEND_API_KEY`, and `RESEND_FROM_EMAIL_DOMAIN` (version 1, the verified sender
`Chamaro <no-reply@chamaro.com>`, read as `RESEND_FROM_EMAIL`). Plain settings: `APP_ENV`, `NODE_ENV`,
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

# 6. Point the email outbox worker at the same image (creates the job the first time).
sed "s/<TAG>/$TAG/" deploy/cloudrun/email-outbox-job.yaml > /tmp/email-outbox-job.yaml
gcloud run jobs replace /tmp/email-outbox-job.yaml --project $P --region $R
```

Always pass `--image` to `gcloud run deploy`, and never run a bare `gcloud run services update chamaro-api`: a new
revision is made from the service template, so it runs whatever image the last deploy left there.

Rollback: `gcloud run services update-traffic chamaro-api --region $R --to-revisions <previous revision>=100`.
Migrations are additive, so the previous revision keeps working on the migrated schema.

Do not `gcloud run services replace deploy/cloudrun/service.yaml` unless it has first been diffed against
`gcloud run services describe chamaro-api --region $R --format export`: replace drops any setting missing from the
file and moves all traffic to the new revision at once.

## Email outbox

Order, shipment, cancellation and password-changed emails are written to the `EmailNotification` table in the same
transaction as the change, then sent once it commits (see `src/services/email-outbox.service.ts`). If that first
attempt fails or never finishes, the `chamaro-email-outbox` job retries it: at most 5 attempts in all, waiting 1, 5,
15 and 60 minutes, never for anything older than 23 hours (Resend keeps idempotency keys for 24 hours, and the
event key is the idempotency key). Sign-up/login codes and reset links are sent directly and never stored.

Cloud Scheduler starts the job every five minutes, as the `chamaro-outbox-scheduler` service account, which may only
run this one job (`roles/run.invoker` on it). One-time setup:

```sh
gcloud services enable cloudscheduler.googleapis.com --project $P
gcloud iam service-accounts create chamaro-outbox-scheduler --project $P --display-name "Starts the chamaro-email-outbox job"
gcloud run jobs add-iam-policy-binding chamaro-email-outbox --project $P --region $R \
  --member serviceAccount:chamaro-outbox-scheduler@$P.iam.gserviceaccount.com --role roles/run.invoker
gcloud scheduler jobs create http chamaro-email-outbox-every-5-min --project $P --location $R \
  --schedule "*/5 * * * *" --time-zone Asia/Kolkata --http-method POST \
  --uri https://run.googleapis.com/v2/projects/$P/locations/$R/jobs/chamaro-email-outbox:run \
  --oauth-service-account-email chamaro-outbox-scheduler@$P.iam.gserviceaccount.com
```

Check it without emailing anyone (one self-test row, sent to a Resend test inbox that delivers to nobody):
`gcloud run jobs execute chamaro-email-outbox --project $P --region $R --wait --args=dist/src/scripts/email-outbox-worker.js,--self-test,delivered@resend.dev`

What the rows mean: `SENT` (the provider accepted it), `PENDING` (waiting for a retry, see `nextAttemptAt`,
`lastErrorName`), `FAILED` (given up: a provider error name, `outcome_unknown` or `retry_window_expired`),
`SKIPPED` (`UNVERIFIED_RECIPIENT`: the account never proved it reads that address; nothing was sent).
To pause sending, pause the scheduler job; requests still record rows, and the first attempt still happens in the API.

## Razorpay payments

Customers pay for a placed order with Razorpay Checkout (`POST /api/v1/orders/:id/payment`, then
`POST /api/v1/orders/:id/payment/verify` with Checkout's callback). Nothing the browser or a webhook body says is taken
as payment state: signatures are checked, then the payment is read back from Razorpay's API, and only an amount and
currency matching the order's stored total marks it PAID (see `src/services/payment.service.ts`). Without the
Razorpay settings below, payment answers 503 `PAYMENTS_NOT_CONFIGURED` and nothing else changes.

Secrets (Secret Manager, readable by `chamaro-backend`), set by a person from the Razorpay dashboard, never in Git:

| Secret | Value |
| --- | --- |
| `RAZORPAY_KEY_ID` | API key id, `rzp_test_...` while testing |
| `RAZORPAY_KEY_SECRET` | that key's secret |
| `RAZORPAY_WEBHOOK_SECRET` | the secret typed into the webhook below (not the API secret) |

Live keys (`rzp_live_...`) are refused unless the plain setting `RAZORPAY_ALLOW_LIVE_KEYS=true` is also set, so going
live is a deliberate, separate step. Optional: `ORDER_PAYMENT_TTL_MINUTES` (15-1440, default 60).

Webhook (Razorpay dashboard > Settings > Webhooks), URL `https://api.chamaro.com/api/v1/payments/razorpay/webhook`,
events `payment.authorized`, `payment.captured`, `payment.failed`, `order.paid`, `refund.processed`.

One-time setup, after the secrets exist:

```sh
gcloud run deploy chamaro-api --project $P --region $R --image $REPO/chamaro-api:$TAG --no-traffic --tag c$TAG \
  --update-secrets RAZORPAY_KEY_ID=RAZORPAY_KEY_ID:latest,RAZORPAY_KEY_SECRET=RAZORPAY_KEY_SECRET:latest,RAZORPAY_WEBHOOK_SECRET=RAZORPAY_WEBHOOK_SECRET:latest
sed "s/<TAG>/$TAG/" deploy/cloudrun/payment-worker-job.yaml > /tmp/payment-worker-job.yaml
gcloud run jobs replace /tmp/payment-worker-job.yaml --project $P --region $R
gcloud run jobs add-iam-policy-binding chamaro-payment-worker --project $P --region $R \
  --member serviceAccount:chamaro-outbox-scheduler@$P.iam.gserviceaccount.com --role roles/run.invoker
gcloud scheduler jobs create http chamaro-payment-worker-every-5-min --project $P --location $R \
  --schedule "*/5 * * * *" --time-zone Asia/Kolkata --http-method POST \
  --uri https://run.googleapis.com/v2/projects/$P/locations/$R/jobs/chamaro-payment-worker:run \
  --oauth-service-account-email chamaro-outbox-scheduler@$P.iam.gserviceaccount.com
```

Each release then also runs `gcloud run jobs replace` for `payment-worker-job.yaml` with the new tag, like step 6.

Money that needs a person (a second payment, a wrong amount, money for a cancelled order, a refund after dispatch) is
never applied to an order; it is listed by `GET /api/v1/admin/payments?needsReview=true` and is refunded from the
Razorpay dashboard. Uncaptured (authorized-only) payments are returned to the customer by Razorpay itself.

## Notes

- Swagger (`/docs`) is off in production. `/health` does not touch the database.
- Migrations never run at application startup; only the `chamaro-migrate` job applies them.
- Request logs record `remoteAddress`; the login rate limit keys on it (`trustProxy` in `src/app.ts`).
- The temporary startup and database diagnostics in `src/server.ts` log only non-secret values.
