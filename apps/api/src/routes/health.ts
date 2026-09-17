import type { FastifyInstance } from "fastify";
import { checkPostgres } from "../infrastructure/postgres";
import { checkRedis } from "../infrastructure/redis";

type CheckStatus = "healthy" | "unhealthy";

interface HealthResponse {
  status: CheckStatus;
  checks: {
    api: CheckStatus;
    postgres: CheckStatus;
    redis: CheckStatus;
  };
}

export function registerHealthRoute(server: FastifyInstance): void {
  server.get("/health", async (_request, reply) => {
    const [postgresOk, redisOk] = await Promise.all([checkPostgres(), checkRedis()]);

    const response: HealthResponse = {
      status: postgresOk && redisOk ? "healthy" : "unhealthy",
      checks: {
        api: "healthy",
        postgres: postgresOk ? "healthy" : "unhealthy",
        redis: redisOk ? "healthy" : "unhealthy",
      },
    };

    return reply.status(response.status === "healthy" ? 200 : 503).send(response);
  });
}
