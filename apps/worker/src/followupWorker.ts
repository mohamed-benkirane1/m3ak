import { createClient } from "redis";
import { createNodeRedisClient, Worker, type Job } from "bullmq";
import { FOLLOWUP_JOB_NAME, FOLLOWUP_QUEUE_NAME, FollowupJobDataSchema, type FollowupJobData } from "@m3ak/shared";
import { executeFollowup, markFollowupExecutionFailed, type ExecuteFollowupResult } from "./followupExecution";

const CONNECT_TIMEOUT_MS = 10_000;

// TASK-028: BullMQ/job boundary only — validates job name + payload shape,
// then delegates all domain execution to followupExecution.ts. Never
// performs revérification/génération/persistence itself.
//
// Retry-aware final-failure bookkeeping lives HERE, not in
// followupExecution.ts or the Worker's `failed` event: only this processor
// has the job's own attemptsStarted/opts.attempts context needed to tell a
// retryable failure apart from a genuinely exhausted final attempt.
// job.attemptsStarted (not attemptsMade) already reflects the CURRENT
// attempt while the processor is running (it increments when the job moves
// to active, before the processor body executes); attemptsMade only
// increments after a failure is recorded, so it is always one behind and
// would misidentify the second-to-last attempt as final.
export async function processFollowupJob(job: Job<FollowupJobData>): Promise<void> {
  if (job.name !== FOLLOWUP_JOB_NAME) {
    throw new Error(`unexpected_job_name: expected "${FOLLOWUP_JOB_NAME}", received "${job.name}"`);
  }

  const data = FollowupJobDataSchema.parse(job.data);

  let result: ExecuteFollowupResult;
  try {
    result = await executeFollowup(data.followupId);
  } catch (error) {
    const configuredAttempts = job.opts.attempts ?? 1;
    const isFinalAttempt = job.attemptsStarted >= configuredAttempts;
    if (isFinalAttempt) {
      // Best-effort bookkeeping only — mirrors apps/api's followup.ts
      // enqueue-failure pattern: never let a failure to mark the row failed
      // mask or replace the original error; both remain diagnosable via logs.
      await markFollowupExecutionFailed(data.followupId).catch((updateError: unknown) => {
        console.error("[followupWorker] failed to mark followup as failed after final attempt error:", {
          followupId: data.followupId,
          updateError: updateError instanceof Error ? updateError.message : String(updateError),
        });
      });
    }
    throw error;
  }

  console.log("[followupWorker] followup execution outcome:", { followupId: data.followupId, outcome: result.outcome });
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
