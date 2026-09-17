import { createClient } from "redis";
import { withTimeout } from "./timeout";

const CHECK_TIMEOUT_MS = 2_000;

// reconnectStrategy: false volontairement — on ne veut pas d'un client qui retente
// indéfiniment en arrière-plan (et logue en boucle) pendant une panne Redis.
// La reconnexion est tentée explicitement, une seule fois par appel à checkRedis().
// connectTimeout borne la tentative de connexion elle-même (sinon seul le PING
// était borné par withTimeout, et un connect() en échec pouvait prendre ~5s).
export const redisClient = createClient({
  url: process.env.REDIS_URL,
  socket: {
    reconnectStrategy: false,
    connectTimeout: CHECK_TIMEOUT_MS,
  },
});

redisClient.on("error", (error: Error) => {
  console.error("[redis] client error:", error.message);
});

export async function connectRedis(): Promise<void> {
  if (!redisClient.isOpen) {
    await redisClient.connect();
  }
}

export async function checkRedis(): Promise<boolean> {
  try {
    await connectRedis();
    const reply = await withTimeout(redisClient.ping(), CHECK_TIMEOUT_MS, "redis healthcheck");
    return reply === "PONG";
  } catch (error) {
    console.error("[redis] healthcheck failed:", (error as Error).message);
    return false;
  }
}

export async function closeRedis(): Promise<void> {
  if (redisClient.isOpen) {
    await redisClient.quit();
  }
}
