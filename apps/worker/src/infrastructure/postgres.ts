import { Pool } from "pg";

// TASK-028: apps/worker owns its own PostgreSQL pool — a separate process
// from the API, never reusing apps/api's own pool (which isn't importable
// cross-workspace anyway). Mirrors apps/api/src/infrastructure/postgres.ts's
// small, generic semantics; no worker-specific healthcheck route exists, so
// no checkPostgres() equivalent is needed here.
export const postgresPool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// An idle-client pool error must never crash the process (node-postgres
// default behavior otherwise) — same reasoning as the API's own pool.
postgresPool.on("error", (error) => {
  console.error("[postgres] pool error:", error.message);
});

export async function closePostgres(): Promise<void> {
  await postgresPool.end();
}
