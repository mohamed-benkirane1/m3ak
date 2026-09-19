import Fastify from "fastify";
import websocketPlugin from "@fastify/websocket";
import { closeFollowupQueue } from "./infrastructure/followupQueue";
import { setupLanggraphCheckpointer } from "./infrastructure/langgraphCheckpointer";
import { closePostgres } from "./infrastructure/postgres";
import { closeRedis, connectRedis } from "./infrastructure/redis";
import { registerChatRoute } from "./routes/chat";
import { registerDashboardRoute } from "./routes/dashboard";
import { registerHealthRoute } from "./routes/health";

const server = Fastify({ logger: true });

server.register(websocketPlugin, { options: { maxPayload: 64 * 1024 } });

server.get("/", async () => ({ service: "m3ak-api" }));

registerHealthRoute(server);
registerDashboardRoute(server);
registerChatRoute(server);

const port = Number(process.env.API_PORT ?? 3001);

async function start(): Promise<void> {
  await connectRedis().catch((error: unknown) => {
    server.log.warn(
      { err: (error as Error).message },
      "redis initial connection failed, will retry on next /health check",
    );
  });

  // TASK-024: the graph must never be served with an unready checkpoint
  // schema, so unlike Redis above this is not caught into a warning —
  // a failure here propagates to start().catch() below and aborts startup.
  await setupLanggraphCheckpointer();

  await server.listen({ port, host: "0.0.0.0" });
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  server.log.info(`received ${signal}, shutting down`);
  try {
    await server.close();
    // TASK-026: closeFollowupQueue() is a safe no-op when the lazy producer
    // Queue was never used this process — it is never created merely to be
    // closed at shutdown.
    await Promise.all([closePostgres(), closeRedis(), closeFollowupQueue()]);
  } finally {
    process.exit(0);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

start().catch((error) => {
  server.log.error(error);
  process.exit(1);
});
