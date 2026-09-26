import type { FastifyRequest } from "fastify";

type Role = "CUSTOMER" | "ADMIN";

// Shared by requireAdmin/requireCustomer: a verified access token whose role claim AND current
// database row both match `role`, on an account that is still active. Access tokens are signed
// with the default JWT key; the Google OAuth state/exchange tokens use separate derived keys
// (see google-oauth.tokens.ts), so they fail jwtVerify() here and can never act as access tokens.
async function requireRole(request: FastifyRequest, role: Role): Promise<void> {
  try { await request.jwtVerify(); } catch { throw Object.assign(new Error("Authentication required"), { statusCode: 401, code: "UNAUTHENTICATED" }); }
  const payload = request.user as { sub?: string; role?: Role };
  if (!payload.sub || payload.role !== role) throw Object.assign(new Error("Insufficient permissions"), { statusCode: 403, code: "FORBIDDEN" });
  const user = await request.server.prisma.user.findUnique({ where: { id: payload.sub }, select: { isActive: true, role: true } });
  if (!user?.isActive) throw Object.assign(new Error("Account is inactive"), { statusCode: 403, code: "ACCOUNT_INACTIVE" });
  if (user.role !== role) throw Object.assign(new Error("Insufficient permissions"), { statusCode: 403, code: "FORBIDDEN" });
}

export async function requireAdmin(request: FastifyRequest): Promise<void> {
  return requireRole(request, "ADMIN");
}

// ADMIN tokens get 403 here: administrators use the /api/v1/admin/* routes.
export async function requireCustomer(request: FastifyRequest): Promise<void> {
  return requireRole(request, "CUSTOMER");
}
