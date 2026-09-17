import { Pool } from "pg";
import { withTimeout } from "./timeout";

const CHECK_TIMEOUT_MS = 2_000;

export const postgresPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: CHECK_TIMEOUT_MS,
});

// Un pool "idle client error" ne doit jamais faire crasher le process (comportement par défaut de node-postgres).
postgresPool.on("error", (error) => {
  console.error("[postgres] pool error:", error.message);
});

export async function checkPostgres(): Promise<boolean> {
  try {
    await withTimeout(postgresPool.query("SELECT 1"), CHECK_TIMEOUT_MS, "postgres healthcheck");
    return true;
  } catch (error) {
    console.error("[postgres] healthcheck failed:", (error as Error).message);
    return false;
  }
}

export async function closePostgres(): Promise<void> {
  await postgresPool.end();
}
