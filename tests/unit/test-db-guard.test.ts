// The database safety guard itself, and a check that every test that can reach a database uses it.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { staticIsolationProblem } from "../helpers/throwaway-db.js";

const base = { JWT_SECRET: "x".repeat(40), DATABASE_URL: "mysql://root@127.0.0.1:3399/chamaro_test", CHAMARO_ISOLATED_TEST_DB: "chamaro_test" };
const problem = (over: Record<string, string | undefined> = {}) => staticIsolationProblem({ ...base, ...over } as NodeJS.ProcessEnv);

test("guard: an explicitly confirmed loopback chamaro_test database passes the static checks", () => {
  assert.equal(problem(), undefined);
  assert.equal(problem({ DATABASE_URL: "mysql://root@localhost:3399/chamaro_test_variants", CHAMARO_ISOLATED_TEST_DB: "chamaro_test_variants" }), undefined);
});

test("guard: refuses everything else (fail closed)", () => {
  const refused: Record<string, Record<string, string | undefined>> = {
    "no explicit confirmation": { CHAMARO_ISOLATED_TEST_DB: undefined },
    "confirmation names a different database": { CHAMARO_ISOLATED_TEST_DB: "chamaro_dev" },
    "no database url": { DATABASE_URL: undefined },
    "not a url": { DATABASE_URL: "not a url" },
    "wrong protocol": { DATABASE_URL: "postgres://root@127.0.0.1:3399/chamaro_test" },
    "Cloud SQL public IP": { DATABASE_URL: "mysql://u:p@203.0.113.10:3306/chamaro_test" },
    "remote host named like loopback": { DATABASE_URL: "mysql://root@127.0.0.1.evil.example:3399/chamaro_test" },
    "private network host": { DATABASE_URL: "mysql://root@10.0.0.5:3306/chamaro_test" },
    "Cloud SQL socket form": { DATABASE_URL: "mysql://u:p@localhost/chamaro_test?socket=/cloudsql/p:r:i" },
    "dev database on loopback (maybe a proxy)": { DATABASE_URL: "mysql://root@127.0.0.1:3307/chamaro_dev", CHAMARO_ISOLATED_TEST_DB: "chamaro_dev" },
    "name merely contains test": { DATABASE_URL: "mysql://root@127.0.0.1:3399/my_test_db", CHAMARO_ISOLATED_TEST_DB: "my_test_db" },
    "production-looking name": { DATABASE_URL: "mysql://root@127.0.0.1:3399/chamaro_app", CHAMARO_ISOLATED_TEST_DB: "chamaro_app" },
    "name with trailing junk": { DATABASE_URL: "mysql://root@127.0.0.1:3399/chamaro_testing-prod", CHAMARO_ISOLATED_TEST_DB: "chamaro_testing-prod" },
    "no JWT secret": { JWT_SECRET: undefined },
    "Cloud Run service": { K_SERVICE: "chamaro-api" },
    "Cloud Run revision": { K_REVISION: "chamaro-api-00012-jas" },
    "APP_ENV=production": { APP_ENV: "production" },
    "NODE_ENV=production": { NODE_ENV: "production" },
  };
  for (const [label, over] of Object.entries(refused)) assert.ok(problem(over), `should refuse: ${label}`);
});

// ---- every DB-capable test file uses the guard ----------------------------------------------------------
// A file is "database capable" if it builds the app, creates a Prisma client, or names DATABASE_URL.
// Files listed here never connect: they use stubs, or only exercise routes that don't query (/health, /docs).
const NO_DATABASE_ACCESS = new Map([
  ["security/login-timing.test.ts", "stubbed Prisma client"],
  ["security/product-rules.test.ts", "stubbed Prisma client"],
  ["security/production-config.test.ts", "child processes that only call /health and /docs (no queries)"],
]);

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "unit" || entry.name === "helpers" ? [] : testFiles(path);
    return entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

test("every test file that can reach a database uses the isolated-database guard", () => {
  const root = join(import.meta.dirname, "..");
  const files = testFiles(root);
  assert.ok(files.length >= 10, "found the test files");
  for (const file of files) {
    const name = relative(root, file).replaceAll("\\", "/");
    const source = readFileSync(file, "utf8");
    const reachesDatabase = /buildApp|PrismaClient|DATABASE_URL|\.prisma\b/.test(source);
    if (NO_DATABASE_ACCESS.has(name)) continue;
    if (!reachesDatabase) continue;
    assert.match(source, /isolatedDatabaseSkipReason/, `${name} can reach a database but does not use the guard (add it, or list the file in NO_DATABASE_ACCESS with a reason)`);
    assert.match(source, /skip: skipReason/, `${name} must pass the guard's result to every database-using test`);
  }
});
