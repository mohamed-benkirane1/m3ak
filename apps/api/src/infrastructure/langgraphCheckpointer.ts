import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { postgresPool } from "./postgres";

// TASK-024: single checkpointer instance sharing the existing postgresPool —
// never a second connection pool. postgresPool.end() (via closePostgres())
// remains the sole owner of that connection; PostgresSaver.end() must never
// be called here.
export const langgraphCheckpointer = new PostgresSaver(postgresPool);

// Must be awaited once before the graph is served in production. Creates/
// migrates the checkpointer's own internal tables (checkpoint_migrations,
// checkpoints, checkpoint_blobs, checkpoint_writes) — no M3AK-owned SQL
// migration exists for these. Never swallow a failure here: an unready
// checkpoint schema must fail API startup, not run silently.
export async function setupLanggraphCheckpointer(): Promise<void> {
  await langgraphCheckpointer.setup();
}
