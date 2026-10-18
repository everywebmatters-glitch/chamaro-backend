# Backend tests

| Command | What it needs |
| --- | --- |
| `npm run test:unit` | nothing (pure functions) |
| `npm run test:security` | nothing, except the L2 test, which needs the isolated test database |
| `npm test` | the isolated test database |

## The isolated test database

Tests that touch the database write real rows. They run only when `helpers/throwaway-db.ts` verifies the
database is disposable (see the checklist at the top of that file); otherwise they are skipped with the reason.
**Never point them at Cloud SQL, a shared database, or a proxy to either.**

One-time setup against a throwaway local MySQL (loopback, its own data directory):

```sql
CREATE DATABASE chamaro_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE chamaro_test;
CREATE TABLE __chamaro_isolated_test_db (token VARCHAR(64) PRIMARY KEY);
INSERT INTO __chamaro_isolated_test_db VALUES ('chamaro-isolated-test-db-v1');
```

Then apply the migrations to that database only (`npx prisma migrate deploy`) and run, for example:

```powershell
$env:DATABASE_URL = "mysql://root@127.0.0.1:3399/chamaro_test"
$env:CHAMARO_ISOLATED_TEST_DB = "chamaro_test"
$env:JWT_SECRET = "any-local-test-secret-at-least-32-characters"
npm test
```

`admin-provisioning` also expects at least one other ADMIN user to exist; seed one in the test database.
Every test file that can reach the database must use the guard; `unit/test-db-guard.test.ts` enforces that.
