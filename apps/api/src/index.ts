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

// WS1: server.register() defers the plugin body (including @fastify/websocket's
// own onRoute hook, which rewrites a {websocket:true} route's handler into the
// real socket-aware dispatcher) to the async avvio boot queue — it does not run
// synchronously. Registering routes immediately after, as plain synchronous
// statements, let /ws/chat be added before that onRoute hook existed, so
// Fastify stored registerChatRoute's handler as an ordinary (request, reply)
// HTTP handler instead: "socket" was actually the FastifyRequest, and
// "request" was actually the FastifyReply, hence "socket.close is not a
// function". server.after() runs its callback only once every plugin queued
// ahead of it (here, the websocket plugin) has fully finished loading.
server.after(() => {
  server.get("/", async () => ({ service: "m3ak-api" }));

  registerHealthRoute(server);
  registerDashboardRoute(server);
  registerChatRoute(server);
});

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
