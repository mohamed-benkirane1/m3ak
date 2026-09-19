import { closeFollowupWorker, createFollowupWorker } from "./followupWorker";
import { closePostgres } from "./infrastructure/postgres";

// TASK-026: real BullMQ Worker bootstrap (replaces the TASK-002 placeholder
// heartbeat). TASK-028: the processor now performs real, contextualized
// followup execution — see followupExecution.ts.
const worker = createFollowupWorker();

console.log(`m3ak-worker: démarrage, écoute la file "${worker.name}"`);

let shuttingDown = false;

// TASK-028: closeFollowupWorker() first — it stops accepting new jobs and
// waits for any in-flight processor work (including its own PostgreSQL
// queries) to finish, via BullMQ's own worker.close() semantics — only then
// is it safe to close the worker-owned Postgres pool. Closing the pool
// first could otherwise cut off an active query.
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  console.log(`m3ak-worker: signal ${signal} reçu, arrêt`);
  try {
    await closeFollowupWorker();
    await closePostgres();
  } finally {
    process.exit(0);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
