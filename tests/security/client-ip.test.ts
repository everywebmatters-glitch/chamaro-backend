// Client IP resolution behind the production load balancer, and per-client rate limiting (2026-11-13 audit, H1).
// In-process inject only: no server, no database (every request below fails validation or rate limiting first).
import "dotenv/config";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { buildApp, TRUSTED_PROXIES } from "../../src/app.js";
import { rateLimitKey } from "../../src/plugins/auth.js";
import { env } from "../../src/config/env.js";

const LB = "8.233.190.129";
// The hop that connects to the container on Cloud Run is a link-local address.
const CLOUD_RUN_PEER = "169.254.8.1";

const app = await buildApp();
// Test-only probe: what the app resolves for a request (registered before the app is ready; not part of the API).
app.get("/__test/client-ip", async (request) => ({ ip: request.ip, key: rateLimitKey(request) }));
after(() => app.close());

type Hop = { peer?: string; xff?: string };
const headersFor = ({ xff }: Hop) => (xff === undefined ? {} : { "x-forwarded-for": xff });
// What Google's external Application Load Balancer sends to Cloud Run: "<whatever the client sent>,<client>,<LB>".
const viaLoadBalancer = (client: string, clientSupplied?: string): Hop => ({
  peer: CLOUD_RUN_PEER,
  xff: [clientSupplied, client, LB].filter(Boolean).join(", "),
});
const resolve = async (hop: Hop) => {
  const res = await app.inject({ method: "GET", url: "/__test/client-ip", headers: headersFor(hop), remoteAddress: hop.peer ?? CLOUD_RUN_PEER });
  return res.json() as { ip: string; key: string };
};
const register = (hop: Hop) =>
  app.inject({ method: "POST", url: "/api/v1/auth/register", headers: headersFor(hop), remoteAddress: hop.peer ?? CLOUD_RUN_PEER, payload: { email: "not-an-email" } });
const login = (hop: Hop) =>
  app.inject({ method: "POST", url: "/api/v1/auth/login", headers: headersFor(hop), remoteAddress: hop.peer ?? CLOUD_RUN_PEER, payload: {} });
const otp = (hop: Hop) =>
  app.inject({ method: "POST", url: "/api/v1/auth/send-login-otp", headers: headersFor(hop), remoteAddress: hop.peer ?? CLOUD_RUN_PEER, payload: {} });
const statuses = async (n: number, send: () => Promise<{ statusCode: number }>) => {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await send()).statusCode);
  return out;
};

test("trusted proxies: only the platform hop and the production load balancer, never 'trust everything'", () => {
  assert.deepEqual(TRUSTED_PROXIES, ["loopback", "linklocal", "uniquelocal", "8.233.190.129/32"]);
});

test("through the load balancer, request.ip is the real client (IPv4 and IPv6)", async () => {
  assert.deepEqual(await resolve(viaLoadBalancer("198.51.100.1")), { ip: "198.51.100.1", key: "198.51.100.1" });
  assert.deepEqual(await resolve(viaLoadBalancer("2001:db8::7")), { ip: "2001:db8::7", key: "2001:db8::7" });
});

test("two clients through the load balancer get independent rate-limit buckets", async () => {
  const a = viaLoadBalancer("198.51.100.21");
  const b = viaLoadBalancer("198.51.100.22");
  assert.deepEqual(await statuses(6, () => register(a)), [400, 400, 400, 400, 400, 429], "client A is limited after 5");
  assert.equal((await register(b)).statusCode, 400, "client B still has its own allowance");
});

test("repeated requests from one client share that client's bucket", async () => {
  const c = viaLoadBalancer("198.51.100.31");
  assert.deepEqual(await statuses(3, () => register(c)), [400, 400, 400]);
  assert.deepEqual(await statuses(3, () => register(c)), [400, 400, 429]);
});

test("a spoofed X-Forwarded-For cannot pick a new bucket", async () => {
  const real = "198.51.100.41";
  const spoofs = ["1.2.3.4", `1.2.3.5, ${LB}`, "10.0.0.9", "garbage", "192.0.2.1, 192.0.2.2", `${LB}, ${LB}`];
  // Every request carries a different forged prefix; all must count against the real client.
  for (const forged of spoofs) assert.equal((await resolve(viaLoadBalancer(real, forged))).ip, real, `forged "${forged}"`);
  const sent: number[] = [];
  for (let i = 0; i < 6; i++) sent.push((await register(viaLoadBalancer(real, `203.0.113.${i + 1}`))).statusCode);
  assert.deepEqual(sent, [400, 400, 400, 400, 400, 429]);
});

test("a request sent straight to the run.app URL resolves to the client Cloud Run appended, not to forged entries", async () => {
  // Cloud Run's front end appends the connecting client after anything the client wrote, including a fake LB hop.
  assert.equal((await resolve({ peer: CLOUD_RUN_PEER, xff: `1.2.3.4, ${LB}, 198.51.100.51` })).ip, "198.51.100.51");
});

test("X-Forwarded-For from an untrusted peer is ignored", async () => {
  assert.equal((await resolve({ peer: "203.0.113.60", xff: "198.51.100.61" })).ip, "203.0.113.60");
  assert.equal((await resolve({ peer: LB, xff: "198.51.100.62" })).ip, "198.51.100.62", "the LB address itself is a trusted hop");
});

test("missing or malformed forwarding headers fail safe", async () => {
  // No header: the connecting peer.
  assert.deepEqual(await resolve({ peer: CLOUD_RUN_PEER }), { ip: CLOUD_RUN_PEER, key: CLOUD_RUN_PEER });
  // Empty and junk entries left of the real client are skipped by the right-to-left walk.
  assert.equal((await resolve({ peer: CLOUD_RUN_PEER, xff: `garbage, , 198.51.100.71, ${LB}` })).ip, "198.51.100.71");
  // Junk in the client position (impossible through Google's LB, which writes it) never becomes its own bucket:
  // the rate-limit key falls back to the connecting peer.
  for (const junk of ["garbage", `garbage, ${LB}`, `not-an-ip-${Date.now()}, ${LB}`, "%00, 8.233.190.129", " , "]) {
    const { key } = await resolve({ peer: CLOUD_RUN_PEER, xff: junk });
    assert.equal(key, CLOUD_RUN_PEER, `junk "${junk}" uses the peer's bucket`);
  }
  const peerOnly = "169.254.8.99";
  const sent: number[] = [];
  for (let i = 0; i < 6; i++) sent.push((await register({ peer: peerOnly, xff: `junk-${i}, ${LB}` })).statusCode);
  assert.deepEqual(sent, [400, 400, 400, 400, 400, 429], "rotating junk values share one bucket");
});

test("rate-limit thresholds are unchanged", async () => {
  // Registration: 5 per hour (literal in auth.routes.ts).
  assert.deepEqual(await statuses(6, () => register(viaLoadBalancer("198.51.100.81"))), [400, 400, 400, 400, 400, 429]);
  // Login: AUTH_RATE_LIMIT_MAX per minute; production sets no override, so the default 10 applies.
  assert.equal(env.AUTH_RATE_LIMIT_MAX, Number(process.env.AUTH_RATE_LIMIT_MAX ?? 10));
  const loginLimit = env.AUTH_RATE_LIMIT_MAX;
  const l = await statuses(loginLimit + 1, () => login(viaLoadBalancer("198.51.100.82")));
  assert.deepEqual(l, [...Array(loginLimit).fill(400), 429]);
  // OTP: OTP_RATE_LIMIT_MAX (default 5; may be overridden in a local .env, never in production).
  assert.equal(env.OTP_RATE_LIMIT_MAX, Number(process.env.OTP_RATE_LIMIT_MAX ?? 5));
  const otpLimit = env.OTP_RATE_LIMIT_MAX;
  const o = await statuses(otpLimit + 1, () => otp(viaLoadBalancer("198.51.100.83")));
  assert.deepEqual(o, [...Array(otpLimit).fill(400), 429]);
});
