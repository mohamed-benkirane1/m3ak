import { createClient } from "redis";
import { createNodeRedisClient, Queue } from "bullmq";
import { FOLLOWUP_QUEUE_NAME, type FollowupJobData } from "@m3ak/shared";

const CONNECT_TIMEOUT_MS = 2_000;

// TASK-026: repository-required bounded retry policy (CLAUDE.md §21 — retries
// limités, backoff, état, gestion explicite de l'échec). Exact numbers are an
// implementation default, not a value sourced from spec/design/tasks.md.
// TASK-027 inherits this via Queue defaultJobOptions unless it has a future
// reason to override it per-job.
const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 1000 },
};

// TASK-026: a SEPARATE, dedicated raw node-redis client — never the API's
// own healthcheck client in ./redis.ts, which keeps its own health/reconnect/
// lifecycle responsibility unmodified. Lazy: created only on first
// getFollowupQueue() call, never as a side effect of importing this module.
let rawClient: ReturnType<typeof createClient> | null = null;
let queue: Queue<FollowupJobData> | null = null;

export function getFollowupQueue(): Queue<FollowupJobData> {
  if (queue) {
    return queue;
  }

  rawClient = createClient({
    url: process.env.REDIS_URL,
    socket: {
      // Same finite-connect-attempt philosophy as ./redis.ts: the HTTP-serving
      // API process must fail reasonably fast, never retry indefinitely.
      reconnectStrategy: false,
      connectTimeout: CONNECT_TIMEOUT_MS,
    },
  });
  rawClient.on("error", (error: Error) => {
    console.error("[followupQueue] redis client error:", error.message);
  });

  queue = new Queue<FollowupJobData>(FOLLOWUP_QUEUE_NAME, {
    connection: createNodeRedisClient(rawClient),
    // Fail fast rather than silently queuing calls while Redis is down —
    // consistent with the producer's finite-connect-attempt requirement.
    skipWaitingForReady: true,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });

  return queue;
}

// Safe to call even when the queue was never initialized (no-op). Closes the
// Queue first, then releases the dedicated raw client — never the reverse.
// Idempotent: a second call after a successful close is also a safe no-op.
export async function closeFollowupQueue(): Promise<void> {
  if (queue) {
    await queue.close();
    queue = null;
  }
  if (rawClient?.isOpen) {
    await rawClient.quit();
  }
  rawClient = null;
}
