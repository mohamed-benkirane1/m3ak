import { createClient } from "redis";
import { createNodeRedisClient, Worker, type Job } from "bullmq";
import { FOLLOWUP_JOB_NAME, FOLLOWUP_QUEUE_NAME, FollowupJobDataSchema, type FollowupJobData } from "@m3ak/shared";

const CONNECT_TIMEOUT_MS = 10_000;

// TASK-026: infrastructure-only failure — deliberate, stable, and always
// thrown for a valid, correctly-named, correctly-shaped job. A silent
// success here would mark a BullMQ job "completed" even though no real
// followup was ever executed. TASK-028 replaces the processor body (never
// this validation) with real execution and removes this throw.
export class FollowupExecutionNotImplementedError extends Error {
  readonly followupId: string;

  constructor(followupId: string) {
    super(`followup_execution_not_implemented: followupId=${followupId} (TASK-028)`);
    this.name = "FollowupExecutionNotImplementedError";
    this.followupId = followupId;
  }
}

// Exported separately from Worker construction so it is directly unit-
// testable against a plain fake job object, without any real BullMQ/Redis
// machinery. Never performs TASK-028's revérification/génération de
// message/persistence/émission — only validates job name + payload shape,
// then fails explicitly.
export async function processFollowupJob(job: Job<FollowupJobData>): Promise<never> {
  if (job.name !== FOLLOWUP_JOB_NAME) {
    throw new Error(`unexpected_job_name: expected "${FOLLOWUP_JOB_NAME}", received "${job.name}"`);
  }

  const data = FollowupJobDataSchema.parse(job.data);

  throw new FollowupExecutionNotImplementedError(data.followupId);
}

let rawClient: ReturnType<typeof createClient> | null = null;
let worker: Worker<FollowupJobData> | null = null;

// TASK-026: apps/worker is a long-running background consumer, a separate
// process from the API — it needs its own dedicated node-redis client, never
// shared with any client the API process owns. Unlike the API producer
// (CONNECT_TIMEOUT_MS + reconnectStrategy: false, fail fast), the worker
// should recover from a transient Redis outage: reconnectStrategy is
// deliberately left unset so node-redis's own built-in default reconnect
// behavior applies, rather than hand-rolling arbitrary custom tuning.
export function createFollowupWorker(): Worker<FollowupJobData> {
  if (worker) {
    return worker;
  }

  rawClient = createClient({
    url: process.env.REDIS_URL,
    socket: {
      connectTimeout: CONNECT_TIMEOUT_MS,
    },
  });
  rawClient.on("error", (error: Error) => {
    console.error("[followupWorker] redis client error:", error.message);
  });

  worker = new Worker<FollowupJobData>(FOLLOWUP_QUEUE_NAME, processFollowupJob, {
    connection: createNodeRedisClient(rawClient),
  });

  worker.on("failed", (job, error) => {
    console.error("[followupWorker] job failed:", {
      jobId: job?.id,
      followupId: (job?.data as FollowupJobData | undefined)?.followupId,
      error: error.message,
    });
  });
  worker.on("error", (error: Error) => {
    console.error("[followupWorker] worker error:", error.message);
  });

  return worker;
}

// Safe to call even when the worker was never created (no-op). Stops
// accepting new work and lets BullMQ's own graceful shutdown semantics run
// (worker.close()), then releases the dedicated raw client — never the
// reverse. Idempotent: a second call after a successful close is a safe
// no-op too.
export async function closeFollowupWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (rawClient?.isOpen) {
    await rawClient.quit();
  }
  rawClient = null;
}
