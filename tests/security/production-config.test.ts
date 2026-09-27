// L3 and M4 in production mode. Each case runs in its own process because env.ts reads the
// environment once at import. Values given here override .env (dotenv never overwrites them).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const SCRIPT = `
  const { buildApp } = await import("./src/app.ts");
  const app = await buildApp();
  const docs = await app.inject({ method: "GET", url: "/docs" });
  const json = await app.inject({ method: "GET", url: "/docs/json" });
  const health = await app.inject({ method: "GET", url: "/health" });
  console.log(JSON.stringify({ docs: docs.statusCode, json: json.statusCode, health: health.statusCode }));
  await app.close();
`;

function run(env: Record<string, string>) {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", SCRIPT], {
    cwd: process.cwd(),
    env: { ...process.env, APP_ENV: "production", CORS_ORIGIN: "https://admin.chamaro.com,https://chamaro.com", ...env },
    encoding: "utf8",
  });
  // stdout also carries Fastify's request logs; the result is the line with the "docs" key.
  const out = result.stdout.split("\n").find((line) => line.startsWith('{"docs"')) ?? "";
  return { ok: result.status === 0, out, err: result.stderr };
}

test("production: CORS_ORIGIN must be set explicitly", () => {
  const res = run({ CORS_ORIGIN: "" });
  assert.equal(res.ok, false);
  assert.match(res.err, /CORS_ORIGIN must be set explicitly/);
});

test("production: localhost origins are refused", () => {
  const res = run({ CORS_ORIGIN: "https://admin.chamaro.com,http://localhost:3000" });
  assert.equal(res.ok, false);
  assert.match(res.err, /must not include localhost/);
});

test("production: the .env.example placeholder JWT secret is refused (and not printed)", () => {
  const placeholder = "replace-with-a-random-secret-of-at-least-32-characters";
  const res = run({ JWT_SECRET: placeholder });
  assert.equal(res.ok, false);
  assert.match(res.err, /JWT_SECRET looks like a placeholder/);
  assert.ok(!res.err.includes(placeholder), "the secret value is not in the error output");
});

test("production: Swagger (/docs, /docs/json) is not served; the API still is", () => {
  const res = run({});
  assert.equal(res.ok, true, res.err);
  assert.deepEqual(JSON.parse(res.out), { docs: 404, json: 404, health: 200 });
});
