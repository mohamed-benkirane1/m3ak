import Fastify from "fastify";

const server = Fastify({ logger: true });

server.get("/", async () => ({ service: "m3ak-api" }));

const port = Number(process.env.API_PORT ?? 3001);

server.listen({ port, host: "0.0.0.0" }).catch((error) => {
  server.log.error(error);
  process.exit(1);
});
