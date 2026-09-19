import { closeFollowupWorker, createFollowupWorker } from "./followupWorker";

// TASK-026: replaces the TASK-002 placeholder heartbeat with a real BullMQ
// Worker bootstrap. No relance business logic runs here yet — see
// followupWorker.ts's processFollowupJob for the deliberate, explicit
// TASK-028-not-implemented failure boundary.
const worker = createFollowupWorker();

console.log(`m3ak-worker: démarrage, écoute la file "${worker.name}"`);

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  console.log(`m3ak-worker: signal ${signal} reçu, arrêt`);
  try {
    await closeFollowupWorker();
  } finally {
    process.exit(0);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
