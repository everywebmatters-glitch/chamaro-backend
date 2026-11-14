# Deploying the backend to Google Cloud Run

> **Status:** this document describes the NEW project. Nothing in it has been executed yet: the APIs below are not
> enabled, the Artifact Registry repository, service account, secrets and Cloud Run resources do not exist, and the
> `chamaro` database is empty until the data migration is approved and finished. Do not deploy before that.

The API runs on **Cloud Run** (service `chamaro-api`, region `asia-south1`, project
`project-d95e700a-8cd9-4c1a-bd5`) with a **Cloud SQL for MySQL 8.4** database (instance
`chamaro-mysql-prod`). Cloud Run's built-in Cloud SQL connection mounts the instance's Unix
socket, so `DATABASE_URL` has the form
`mysql://user:pass@localhost/db?socket=/cloudsql/project-d95e700a-8cd9-4c1a-bd5:asia-south1:chamaro-mysql-prod`
(see `src/plugins/prisma.ts`). There is no proxy sidecar.

| File | Purpose |
| --- | --- |
| `Dockerfile` (repo root) | `runtime` target: the API image. `migrate` target: Prisma CLI, schema and migrations. |
| `deploy/cloudrun/cloudbuild.yaml` | Builds both images for one commit, checks their contents, smoke-tests the API image, pushes both. |
| `deploy/cloudrun/service.yaml` | Record of the live `chamaro-api` configuration. Not applied directly (see below). |
| `deploy/cloudrun/migrate-job.yaml` | Cloud Run job `chamaro-migrate` that runs `prisma migrate deploy`. |
| `deploy/cloudrun/payment-worker-job.yaml` | Cloud Run job `chamaro-payment-worker`: reconciles Razorpay payments and expires unpaid orders. |
| `deploy/cloudrun/email-outbox-job.yaml` | Cloud Run job `chamaro-email-outbox`: retries the email outbox (API image, one pass, then exit). |

Images live in `asia-south1-docker.pkg.dev/project-d95e700a-8cd9-4c1a-bd5/chamaro-images`
(`chamaro-api`, `chamaro-migrate`), tagged with the short Git commit. Never deploy `latest`.

Secrets (Secret Manager, read by the `chamaro-backend` service account): `DATABASE_URL` (runtime, account
`chamaro_app`), `DATABASE_URL_MIGRATE` (migration job only, account `chamaro_migrator`), `JWT_SECRET`,
`CORS_ORIGIN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`,
`GOOGLE_FRONTEND_CALLBACK_URL`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`,
`RAZORPAY_WEBHOOK_SECRET`, `DELHIVERY_API_TOKEN` and `DELHIVERY_PICKUP_LOCATION`. The manifests pin the Resend, Razorpay and
Delhivery secrets to `@1`, so create each of those as version 1. `RAZORPAY_ALLOW_LIVE_KEYS`, `DELHIVERY_ENABLED` and
`DELHIVERY_AUTO_BOOKING` are `"false"` in every manifest until live payments and dispatch are deliberately approved.
`RESEND_FROM_EMAIL` is the verified sender `Chamaro <no-reply@chamaro.com>`. Plain settings: `APP_ENV`, `NODE_ENV`,
`HOST`, `APP_BASE_URL` (`https://chamaro.com`), optional `PASSWORD_RESET_TOKEN_TTL_MINUTES` (5-120, default 30).

## One-time setup in the new project (not yet performed)

Each step creates a billable or permission-bearing resource and needs explicit approval first.

```sh
P=project-d95e700a-8cd9-4c1a-bd5; R=asia-south1
gcloud services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com   secretmanager.googleapis.com cloudscheduler.googleapis.com --project $P
gcloud artifacts repositories create chamaro-images --repository-format=docker --location=$R --project $P
gcloud iam service-accounts create chamaro-backend --project $P
SA=chamaro-backend@$P.iam.gserviceaccount.com
gcloud projects add-iam-policy-binding $P --member=serviceAccount:$SA --role=roles/cloudsql.client
# Secret Manager: create each secret listed above (values never go in this repo), then:
#   gcloud secrets add-iam-policy-binding <NAME> --project $P --member=serviceAccount:$SA --role=roles/secretmanager.secretAccessor
```

Database accounts: `chamaro_app` (runtime, SELECT/INSERT/UPDATE/DELETE via `chamaro_app_role`) already exists.
`deploy/cloudrun/sql/create-migrator.sql` is a DRAFT for the separate `chamaro_migrator` account that
`prisma migrate deploy` needs (CREATE/ALTER/DROP/INDEX/REFERENCES). Review it and run it yourself as an admin user.

DATABASE_URL values use the Cloud SQL socket form, URL-encoding any special characters in the password:
`mysql://chamaro_app:<password>@localhost/chamaro?socket=/cloudsql/project-d95e700a-8cd9-4c1a-bd5:asia-south1:chamaro-mysql-prod`
(`DATABASE_URL_MIGRATE` is the same with `chamaro_migrator`).

## Health checks

- `GET /health` -- liveness; does not touch the database (used by the Cloud Build smoke test).
- `GET /health/ready` -- readiness; runs `SELECT 1` and answers `503` with a generic message if the database is
  unreachable. Never includes connection details.

## Admin and storefront

`admin` (static export served by `serve`) and `webapp` (`next start`) are separate images built from their own repos.
`NEXT_PUBLIC_API_URL` is public and baked in at build time (default `https://api.chamaro.com/api/v1`); no secret may
ever use a `NEXT_PUBLIC_` name. For each repo:

```sh
TAG=$(git rev-parse --short HEAD)
IMAGE=$R-docker.pkg.dev/$P/chamaro-images/chamaro-<admin|webapp>:$TAG
gcloud builds submit --project $P --region $R --config cloudbuild.yaml --substitutions _IMAGE=$IMAGE .
gcloud run deploy chamaro-<admin|webapp> --project $P --region $R --image $IMAGE   --min-instances 0 --max-instances 2 --memory 512Mi --cpu 1 --port 8080
```

To test before `api.chamaro.com` is repointed, build with `--substitutions _IMAGE=...,_API_URL=https://<api run.app url>/api/v1`
and add the test frontend origins to the `CORS_ORIGIN` secret. The Google OAuth state cookie is host-bound, so the
real OAuth flow must be tested on the final API host.

## Each release

Run from a clean working tree on the commit being released.

```sh
P=project-d95e700a-8cd9-4c1a-bd5; R=asia-south1
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

# 4. Only if migrations are pending: take an on-demand backup of THIS instance first, then apply them.
gcloud sql backups create --project $P --instance chamaro-mysql-prod --description "before $TAG"
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

## Coupon and delivery pricing

`WELCOME10` discounts Boss chairs by 10%, and `WELCOME5` discounts chairs by 5%. Each signed-in customer account may
redeem each code once; the order transaction recalculates the discount from current catalogue prices and records the
code and amount. Chair eligibility is determined from the product name and category name/slug.

The current checkout requests one Delhivery Surface estimate for the destination PIN and cart weight, using origin PIN
`600118` unless `DELHIVERY_ORIGIN_PIN` is set. Chargeable weight uses the greater of each packed unit's actual weight
and volumetric weight (`length × width × height ÷ 5000`, dimensions in cm and result in kg), summed by quantity.
Before deploying the storefront, enter each active product's actual packed weight and dimensions in Store Settings;
checkout deliberately refuses to guess missing measurements. The API temporarily
accepts the previous server-priced `standard` and `express` order requests so existing storefront sessions keep working
during rollout. Keep that compatibility until old storefront sessions have expired.

Migration `0018_coupons_and_chair_shipping` adds the order fields and uniqueness constraint; follow the backup and
migration steps above before deploying its API image.

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

Webhook (Razorpay dashboard > Accounts & Settings > Webhooks), set up separately in Test mode and in Live mode, each
with its own secret, URL `https://api.chamaro.com/api/v1/payments/razorpay/webhook`, events `payment.authorized`,
`payment.captured`, `payment.failed`, `order.paid`, `refund.created`, `refund.processed`, `refund.failed`. The webhook
body only says which payment to read: its state is always read back from Razorpay's API with the current keys.

Payment capture (Dashboard): manual capture is recommended. The server captures an authorized payment only while its
order can still be confirmed; a payment that arrives after the order was cancelled or expired is then never captured,
and Razorpay returns it to the customer by itself. With automatic capture such money is captured, flagged
`needsReview`, and must be refunded by a person.

Test mode and live mode: every payment records the key mode it was created with (`Payment.mode`). An order paid with
test keys is PAID but can never be shipped (`ORDER_PAID_IN_TEST_MODE`; Delhivery dispatch must use the same
`orderPaidLive()` check), and after switching keys, gateway orders of the other mode are never read back or reused.

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

## Delhivery shipping (not live)

Code is in place but **off**: every Delhivery route answers `503 SHIPPING_DISABLED` until `DELHIVERY_ENABLED=true`.
Outside `APP_ENV=production` only `https://staging-express.delhivery.com` is accepted; production accepts only
`https://track.delhivery.com`. Do not enable it until payments can mark orders `PAID` (nothing does yet).

Secrets to create in Secret Manager (values from Delhivery onboarding; readable by `chamaro-backend`):
`DELHIVERY_API_TOKEN` (the **production** token, different from staging), `DELHIVERY_PICKUP_LOCATION` (registered
warehouse name, exact case), `DELHIVERY_WEBHOOK_SECRET` (32+ random characters, e.g. `openssl rand -base64 48`; also
given to Delhivery as the scan-push `Authorization: Bearer ...` header). Plain settings: `DELHIVERY_ENABLED`,
`DELHIVERY_API_BASE_URL`, optional `DELHIVERY_SELLER_GST_TIN`, `DELHIVERY_HSN_CODE`, `DELHIVERY_TIMEOUT_MS`.

```sh
for S in DELHIVERY_API_TOKEN DELHIVERY_PICKUP_LOCATION DELHIVERY_WEBHOOK_SECRET; do
  gcloud secrets create $S --project $P --replication-policy automatic
  # paste the value, then Ctrl-D (never put it on the command line)
  gcloud secrets versions add $S --project $P --data-file=-
  gcloud secrets add-iam-policy-binding $S --project $P \
    --member serviceAccount:chamaro-backend@$P.iam.gserviceaccount.com --role roles/secretmanager.secretAccessor
done
# When live dispatch is approved (a new revision, no traffic first, as in "Each release"):
gcloud run deploy chamaro-api --project $P --region $R --image $REPO/chamaro-api:$TAG --no-traffic --tag c$TAG \
  --update-env-vars DELHIVERY_ENABLED=true,DELHIVERY_API_BASE_URL=https://track.delhivery.com \
  --update-secrets DELHIVERY_API_TOKEN=DELHIVERY_API_TOKEN:latest,DELHIVERY_PICKUP_LOCATION=DELHIVERY_PICKUP_LOCATION:latest,DELHIVERY_WEBHOOK_SECRET=DELHIVERY_WEBHOOK_SECRET:latest
```

Migration `0012_delhivery_shipments` is additive (three new tables). Tracking is read by the
`chamaro-shipment-tracking` job (`deploy/cloudrun/shipment-tracking-job.yaml`, every 15 minutes is ample) and, for
each scan Delhivery pushes, by `POST /api/v1/webhooks/delhivery/scans` (Delhivery sets the push up on request; the
body is only used to pick which AWB to re-read from the tracking API).

## Automatic courier booking (off)

A verified **live** Razorpay payment queues a Delhivery booking in the same transaction that marks the order paid; only
the shipment worker calls Delhivery. `DELHIVERY_ENABLED` and `DELHIVERY_AUTO_BOOKING` must have the same value on
**chamaro-api** (checkout callback and webhook settle payments), **payment-worker** (reconcile settles payments too) and
**shipment-tracking** (books and tracks); leave them `false` everywhere until live dispatch is approved. Test-mode
payments never queue a booking.

What a paid order shows in Retail Orders: `Booking queued` (the worker books it), `Booking needs attention` with the reason
(`PARCEL_DETAILS_MISSING`, `MULTI_PARCEL_ORDER`, `ADDRESS_INCOMPLETE`, `PINCODE_NOT_SERVICEABLE`, ...), or, when Delhivery
settings are missing (`DELHIVERY_API_TOKEN`, `DELHIVERY_PICKUP_LOCATION`, and on the production host `DELHIVERY_SELLER_GST_TIN`
and `DELHIVERY_HSN_CODE`), `QUEUED` with `DELHIVERY_NOT_CONFIGURED` naming the setting. Those bookings wait and are booked by
the first pass after the settings are fixed. A shipment flagged `BOOKED_FOR_INELIGIBLE_ORDER` was booked just as its order
was refunded or cancelled: cancel it in Delhivery.

Automatic pickup: with `DELHIVERY_AUTO_PICKUP=true` and `DELHIVERY_PICKUP_TIME=HH:MM` (Indian time) on the shipment
worker, each pass after booking asks Delhivery to collect the booked, not yet picked-up parcels: for today if the time
is at least 30 minutes away, else tomorrow. One request per warehouse and day; parcels booked after it wait for the next
day's. A request whose outcome is unknown is not re-sent automatically; confirm it in Retail Orders' pickup API.

Delhivery's scan-push webhook (`POST /api/v1/webhooks/delhivery/scans`) stays off (`503 SCAN_PUSH_DISABLED`) unless
`DELHIVERY_SCAN_PUSH_ENABLED=true`. Do not set it until how Delhivery authenticates the push has been confirmed from its
official documentation and with Delhivery; tracking is read by the shipment worker and by "Refresh tracking" in Retail
Orders. Settings (names only; values live in Secret Manager or the manifests): `DELHIVERY_ENABLED`,
`DELHIVERY_AUTO_BOOKING`, `DELHIVERY_API_BASE_URL`, `DELHIVERY_API_TOKEN`, `DELHIVERY_PICKUP_LOCATION`,
`DELHIVERY_SELLER_GST_TIN`, `DELHIVERY_HSN_CODE`, `DELHIVERY_WEBHOOK_SECRET`, `DELHIVERY_SCAN_PUSH_ENABLED`.

## Inventory ledger (expand stage: dormant)

Migration `0020_inventory_ledger_expand` only adds columns and tables; checkout, cancellation, expiry, refunds and the
admin product form behave exactly as before. Every stock write goes through `src/services/inventory.service.ts`.

The backfill, reconciliation and rollback scripts are for the approved cutover only (each production run needs its own
approval). They print a JSON summary, write `<path>.json` and `<path>.md` with `--report=<path>`, can be limited with
`--only=<productId>[,...]`, and contain no customer data.

| Script | Default | Purpose |
|---|---|---|
| `node dist/src/scripts/inventory-reconcile.js` | read-only | Invariants per stock row; lists products without a stock row. Exit 1 on any violation. |
| `node dist/src/scripts/inventory-backfill.js [--apply]` | dry run | Converts each product to on-hand / reserved (available stock unchanged), classifies orders, opens the ledger. Products that don't reconcile are skipped and reported, never repaired. Re-running converges orders the previous code placed, shipped or cancelled since. |
| `node dist/src/scripts/inventory-rollback.js [--apply]` | dry run | Returns migrated products to the legacy numbers exactly, then clears the ledger and order stock states (the JSON report keeps the ledger). Refused while variant-level stock exists. |

### Release orphaned reservation (admin action; live with this stage)

Migration `0021_stock_movement_orphan_release` (additive: one enum value appended, three nullable columns, one unique
index) adds the `ORPHAN_RELEASE` ledger movement. Admins release reserved units that **no order holds** from the
Inventory page ("Release orphaned reservation") or the API:

- `GET  /api/v1/admin/inventory/products/:id/orphan-release`: current on hand / reserved / available, units held by
  orders, releasable units, previous releases (read-only).
- `POST /api/v1/admin/inventory/products/:id/orphan-releases` with
  `{ quantity, expectedOnHand, expectedReserved, reason, reference }`: refused unless the stock row still shows the
  expected numbers (409 `STALE_STOCK`), the quantity is within the units no order holds (409 `HELD_BY_ORDERS`,
  `EXCEEDS_RESERVED`), the reason has 10–191 characters and the reference key was never used (409
  `DUPLICATE_REFERENCE`). Changes `reservedQuantity` only, in one transaction with the ledger row.

`ORPHAN_RELEASE` rows work on the legacy numbers: the backfill doesn't treat them as "already on the ledger" and
carries the released units in the opening balance; reconciliation keeps such products in the legacy model; the
rollback keeps these rows (audit trail) and removes the rest. There is no undo action: a reversal needs its own
reviewed change.

## Notes

- Swagger (`/docs`) is off in production. `/health` does not touch the database.
- Migrations never run at application startup; only the `chamaro-migrate` job applies them.
- Request logs record `remoteAddress`; the login rate limit keys on it (`trustProxy` in `src/app.ts`).
- The temporary startup and database diagnostics in `src/server.ts` log only non-secret values.
