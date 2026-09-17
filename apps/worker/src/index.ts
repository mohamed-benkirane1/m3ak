// Infrastructure provisoire (TASK-002) : aucun traitement de job réel n'existe encore.
// Le worker reste vivant dans son conteneur en attendant BullMQ (tâche ultérieure).
const HEARTBEAT_INTERVAL_MS = 30_000;

console.log("m3ak-worker: démarrage (aucune file de tâches configurée)");

const heartbeat = setInterval(() => {
  console.log("m3ak-worker: en attente (infrastructure provisoire, pas de traitement réel)");
}, HEARTBEAT_INTERVAL_MS);

function shutdown(signal: NodeJS.Signals): void {
  console.log(`m3ak-worker: signal ${signal} reçu, arrêt`);
  clearInterval(heartbeat);
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
