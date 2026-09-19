import { randomUUID } from "node:crypto";
import { PoolClient } from "pg";
import { z } from "zod";
import { FOLLOWUP_JOB_NAME, Followup, FollowupSchema } from "@m3ak/shared";
import { getFollowupQueue } from "../infrastructure/followupQueue";
import { postgresPool } from "../infrastructure/postgres";
import { withTimeout } from "../infrastructure/timeout";

const FOLLOWUP_QUERY_TIMEOUT_MS = 3_000;
const DEFAULT_FOLLOWUP_DELAY_MINUTES = 5;

const ConversationIdInputSchema = z.string().trim().uuid();

export type ScheduleFollowupResult =
  | { scheduled: true; replayed: boolean; followup: Followup }
  | { scheduled: false; reason: "conversation_not_found" }
  | { scheduled: false; reason: "conversation_not_active" }
  | { scheduled: false; reason: "order_already_exists" }
  | { scheduled: false; reason: "open_escalation_exists" };

interface ConversationStatusRow {
  status: string;
}

interface FollowupRow {
  id: string;
  conversation_id: string;
  scheduled_at: Date;
  executed_at: Date | null;
  status: string;
  message: string | null;
}

function mapRowToFollowup(row: FollowupRow): Followup {
  return FollowupSchema.parse({
    id: row.id,
    conversationId: row.conversation_id,
    scheduledAt: row.scheduled_at.toISOString(),
    ...(row.executed_at ? { executedAt: row.executed_at.toISOString() } : {}),
    status: row.status,
    ...(row.message ? { message: row.message } : {}),
  });
}

// Lazy, read at scheduling time only (same convention as graph.ts's
// getMaxAgentSteps()). A missing/blank env value defaults to 5 minutes; a
// configured-but-malformed value fails explicitly rather than silently
// producing a dangerous (e.g. zero/negative/immediate) schedule.
function getFollowupDelayMinutes(): number {
  const raw = process.env.FOLLOWUP_DELAY_MINUTES?.trim();

  if (!raw) {
    return DEFAULT_FOLLOWUP_DELAY_MINUTES;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid FOLLOWUP_DELAY_MINUTES: must be a positive integer, got "${raw}"`);
  }

  return parsed;
}

interface TxOutcome<T> {
  commit: boolean;
  value: T;
}

// Same pattern as escalation.ts's withEscalationTransaction: one checked-out
// client from the existing shared pool, single BEGIN..COMMIT/ROLLBACK unit of
// work.
async function withFollowupTransaction<T>(fn: (client: PoolClient) => Promise<TxOutcome<T>>): Promise<T> {
  const client = await postgresPool.connect();
  try {
    await client.query("BEGIN");
    const { commit, value } = await fn(client);
    await client.query(commit ? "COMMIT" : "ROLLBACK");
    return value;
  } catch (error) {
    // Best-effort: never let a rollback failure mask the original error.
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// Locks the parent conversation BEFORE evaluating eligibility or checking for
// an existing scheduled followup: that lock serializes any concurrent
// scheduleFollowup attempt for the same conversation at the PostgreSQL
// transaction level — the same idempotency mechanism createEscalation()
// already relies on, since followups has no unique constraint on
// conversation_id (TASK-027A).
//
// The BullMQ job id is chosen deterministically as the followup's own UUID
// (generated here, application-side, via crypto.randomUUID()) and stored as
// followups.bullmq_job_id at insert time — never a separate correlation
// UPDATE after a successful enqueue, since the id is already known and
// already persisted before queue.add() is ever called.
export async function scheduleFollowup(rawConversationId: unknown): Promise<ScheduleFollowupResult> {
  const conversationId = ConversationIdInputSchema.parse(rawConversationId);
  const delayMinutes = getFollowupDelayMinutes();

  const now = new Date();
  const delayMs = delayMinutes * 60_000;
  const scheduledAt = new Date(now.getTime() + delayMs);
  const followupId = randomUUID();

  const txResult = await withFollowupTransaction<ScheduleFollowupResult>(async (client) => {
    const conversationLock = await withTimeout(
      client.query<ConversationStatusRow>("SELECT status FROM conversations WHERE id = $1 FOR UPDATE", [conversationId]),
      FOLLOWUP_QUERY_TIMEOUT_MS,
      "scheduleFollowup:lockConversation",
    );
    if (conversationLock.rows.length === 0) {
      return { commit: false, value: { scheduled: false, reason: "conversation_not_found" } };
    }
    const conversationStatus = (conversationLock.rows[0] as ConversationStatusRow).status;
    if (conversationStatus !== "active") {
      return { commit: false, value: { scheduled: false, reason: "conversation_not_active" } };
    }

    const existingOrder = await withTimeout(
      client.query("SELECT 1 FROM orders WHERE conversation_id = $1 LIMIT 1", [conversationId]),
      FOLLOWUP_QUERY_TIMEOUT_MS,
      "scheduleFollowup:findExistingOrder",
    );
    if (existingOrder.rows.length > 0) {
      return { commit: false, value: { scheduled: false, reason: "order_already_exists" } };
    }

    const openEscalation = await withTimeout(
      client.query("SELECT 1 FROM escalations WHERE conversation_id = $1 AND status = 'open' LIMIT 1", [conversationId]),
      FOLLOWUP_QUERY_TIMEOUT_MS,
      "scheduleFollowup:findOpenEscalation",
    );
    if (openEscalation.rows.length > 0) {
      return { commit: false, value: { scheduled: false, reason: "open_escalation_exists" } };
    }

    const existingScheduled = await withTimeout(
      client.query<FollowupRow>(
        `SELECT id, conversation_id, scheduled_at, executed_at, status, message
         FROM followups
         WHERE conversation_id = $1 AND status = 'scheduled'
         ORDER BY created_at ASC
         LIMIT 1`,
        [conversationId],
      ),
      FOLLOWUP_QUERY_TIMEOUT_MS,
      "scheduleFollowup:findExistingScheduled",
    );
    if (existingScheduled.rows.length > 0) {
      const existingRow = existingScheduled.rows[0] as FollowupRow;
      return { commit: false, value: { scheduled: true, replayed: true, followup: mapRowToFollowup(existingRow) } };
    }

    const inserted = await withTimeout(
      client.query<FollowupRow>(
        `INSERT INTO followups (id, conversation_id, scheduled_at, executed_at, status, message, bullmq_job_id)
         VALUES ($1, $2, $3, NULL, 'scheduled', NULL, $1)
         RETURNING id, conversation_id, scheduled_at, executed_at, status, message`,
        [followupId, conversationId, scheduledAt],
      ),
      FOLLOWUP_QUERY_TIMEOUT_MS,
      "scheduleFollowup:insert",
    );
    const insertedRow = inserted.rows[0] as FollowupRow;
    return { commit: true, value: { scheduled: true, replayed: false, followup: mapRowToFollowup(insertedRow) } };
  });

  // Only a genuinely NEW row needs enqueueing. The worker must never be able
  // to observe a job whose durable followup row is still uncommitted, so
  // this always runs strictly after the transaction above has committed —
  // and a replay (an already-scheduled followup) must never enqueue a
  // second job.
  if (!txResult.scheduled || txResult.replayed) {
    return txResult;
  }

  try {
    const job = await getFollowupQueue().add(FOLLOWUP_JOB_NAME, { followupId }, { jobId: followupId, delay: delayMs });
    if (job.id !== followupId) {
      throw new Error(`Integrity error: BullMQ returned job.id "${job.id}", expected "${followupId}"`);
    }
  } catch (error) {
    // Bookkeeping only, not TASK-028 execution logic: the durable row already
    // exists and must not keep pretending to be a validly scheduled job.
    // executed_at/message are deliberately left untouched so scheduling
    // failure remains structurally distinguishable from execution failure.
    await withTimeout(
      postgresPool.query(`UPDATE followups SET status = 'failed' WHERE id = $1 AND status = 'scheduled'`, [followupId]),
      FOLLOWUP_QUERY_TIMEOUT_MS,
      "scheduleFollowup:markFailedAfterEnqueueError",
    ).catch((updateError: unknown) => {
      // Never let a failure to mark the row failed mask or replace the
      // original enqueue error — both remain diagnosable via logs, the same
      // best-effort posture already used for rollback above.
      console.error("[scheduleFollowup] failed to mark followup as failed after enqueue error:", {
        followupId,
        updateError: updateError instanceof Error ? updateError.message : String(updateError),
      });
    });
    throw error;
  }

  return txResult;
}
