// Fail-closed safety guard for every test that touches the database.
//
// A test may use the database only when ALL of these hold, otherwise it is skipped (nothing is read or written):
//   1. CHAMARO_ISOLATED_TEST_DB is set to the database name, a deliberate "yes, this one is disposable".
//   2. DATABASE_URL is a mysql:// URL on a loopback host (no Cloud SQL socket, no remote host) and the
//      database name is chamaro_test or chamaro_test_<suffix>.
//   3. The environment is not production and not Cloud Run.
//   4. The database contains the marker table below, holding the marker token. A database that was not
//      deliberately prepared as a test database (production, a shared dev database, or a proxy to one)
//      has no such table, so even a loopback Cloud SQL proxy is refused.
// Any error while checking counts as "not isolated".
//
// Prepare the local test database once (see tests/README.md):
//   CREATE TABLE __chamaro_isolated_test_db (token VARCHAR(64) PRIMARY KEY);
//   INSERT INTO __chamaro_isolated_test_db VALUES ('chamaro-isolated-test-db-v1');

export const MARKER_TABLE = "__chamaro_isolated_test_db";
export const MARKER_TOKEN = "chamaro-isolated-test-db-v1";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const TEST_DATABASE_NAME = /^chamaro_test(_[a-z0-9_]+)?$/;

// The checks that need no database connection.
export function staticIsolationProblem(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!env.JWT_SECRET) return "JWT_SECRET is required";
  if (env.K_SERVICE || env.K_REVISION) return "running on Cloud Run";
  if (env.APP_ENV === "production" || env.NODE_ENV === "production") return "production environment";

  let url: URL;
  try {
    url = new URL(env.DATABASE_URL ?? "");
  } catch {
    return "DATABASE_URL is missing or not a URL";
  }
  if (url.protocol !== "mysql:") return "DATABASE_URL must be a mysql:// URL";
  if (!LOOPBACK_HOSTS.has(url.hostname)) return "DATABASE_URL host is not loopback";
  if (url.searchParams.has("socket")) return "DATABASE_URL uses a socket (Cloud SQL form)";
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!TEST_DATABASE_NAME.test(database)) return "database name must be chamaro_test or chamaro_test_<suffix>";
  if (env.CHAMARO_ISOLATED_TEST_DB !== database) return `set CHAMARO_ISOLATED_TEST_DB=${database} to confirm this database is disposable`;
  return undefined;
}

async function markerProblem(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  try {
    const url = new URL(env.DATABASE_URL!);
    const mariadb = await import("mariadb");
    const connection = await mariadb.createConnection({
      host: url.hostname.replace(/^\[|\]$/g, ""),
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: decodeURIComponent(url.pathname.replace(/^\//, "")),
      connectTimeout: 5_000,
    });
    try {
      const rows = (await connection.query(`SELECT token FROM \`${MARKER_TABLE}\``)) as { token: string }[];
      return rows.length === 1 && rows[0].token === MARKER_TOKEN ? undefined : "marker table does not hold the expected token";
    } finally {
      await connection.end();
    }
  } catch {
    return `marker table ${MARKER_TABLE} not found (or the database is unreachable)`;
  }
}

// Used as `{ skip: await isolatedDatabaseSkipReason() }`. Returns undefined only when the database is verified isolated.
export async function isolatedDatabaseSkipReason(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const problem = staticIsolationProblem(env) ?? (await markerProblem(env));
  return problem ? `Refusing to use the database: ${problem}. See tests/README.md.` : undefined;
}
