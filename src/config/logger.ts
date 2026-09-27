import type { FastifyServerOptions } from "fastify";

// Auth URLs carry one-time secrets in the query string (Google's authorization `code`, the OAuth
// `state`, the PKCE `code_challenge`), so request logs keep only their path. Other query strings
// (e.g. product search) are kept because they're useful and not sensitive.
const REDACTED_QUERY_PREFIX = "/api/v1/auth/";

export function redactUrl(url: string): string {
  const queryStart = url.indexOf("?");
  if (queryStart === -1 || !url.startsWith(REDACTED_QUERY_PREFIX)) return url;
  return `${url.slice(0, queryStart)}?[redacted]`;
}

type LoggedRequest = { method: string; url: string; hostname?: string; ip?: string; socket?: { remotePort?: number } };

// Same fields as Fastify's default request serializer, with the URL redacted. Headers (and so
// Authorization tokens and cookies) and bodies are never logged.
export const loggerOptions: FastifyServerOptions["logger"] = {
  serializers: {
    req(request: LoggedRequest) {
      return {
        method: request.method,
        url: redactUrl(request.url),
        host: request.hostname,
        remoteAddress: request.ip,
        remotePort: request.socket?.remotePort,
      };
    },
  },
};
