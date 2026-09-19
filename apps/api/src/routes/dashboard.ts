import type { FastifyInstance, FastifyRequest } from "fastify";
import { getDashboardData } from "../dashboard/dashboard";

const DASHBOARD_ERROR = {
  error: {
    code: "dashboard_unavailable",
    message: "Dashboard temporarily unavailable",
  },
} as const;

function getAllowedOrigin(request: FastifyRequest): string | null {
  const originHeader = request.headers.origin;
  if (originHeader === undefined) return null;

  try {
    const origin = new URL(originHeader);
    const isWebProtocol = origin.protocol === "http:" || origin.protocol === "https:";
    const isFrontendPort = origin.port === "5173";
    const isLocalHost = origin.hostname === "localhost" || origin.hostname === "127.0.0.1";
    const isSameHost = origin.hostname.toLowerCase() === request.hostname.toLowerCase();
    return isWebProtocol && isFrontendPort && (isLocalHost || isSameHost) ? origin.origin : null;
  } catch {
    return null;
  }
}

export function registerDashboardRoute(server: FastifyInstance): void {
  server.get("/api/dashboard", async (request, reply) => {
    if (request.headers.origin !== undefined) {
      reply.header("Vary", "Origin");
      const allowedOrigin = getAllowedOrigin(request);
      if (allowedOrigin !== null) reply.header("Access-Control-Allow-Origin", allowedOrigin);
    }

    try {
      return reply.status(200).send(await getDashboardData());
    } catch (error) {
      request.log.error({ err: error }, "dashboard load failed");
      return reply.status(503).send(DASHBOARD_ERROR);
    }
  });
}
