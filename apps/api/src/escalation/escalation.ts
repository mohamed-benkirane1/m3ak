import { PoolClient } from "pg";
import { z } from "zod";
import { Escalation, EscalationSchema } from "@m3ak/shared";
import { postgresPool } from "../infrastructure/postgres";
import { withTimeout } from "../infrastructure/timeout";

const ESCALATION_QUERY_TIMEOUT_MS = 3_000;

const ConversationIdInputSchema = z.string().trim().uuid();
const ReasonInputSchema = z.string().trim().min(1);
const ContextSummaryInputSchema = z.string().trim().min(1);

export type CreateEscalationResult =
  | { created: true; replayed: boolean; escalation: Escalation }
  | { created: false; reason: "conversation_not_found" };

interface EscalationRow {
  id: string;
  conversation_id: string;
  reason: string;
  context_summary: string;
  status: string;
  created_at: Date;
}

function mapRowToEscalation(row: EscalationRow): Escalation {
  return EscalationSchema.parse({
    id: row.id,
    conversationId: row.conversation_id,
    reason: row.reason,
    contextSummary: row.context_summary,
    status: row.status,
    createdAt: row.created_at.toISOString(),
  });
}

interface TxOutcome<T> {
  commit: boolean;
  value: T;
}

// Same pattern as cart.ts's withCartTransaction: one checked-out client from
// the existing shared pool (never a new Pool), single BEGIN..COMMIT/ROLLBACK
// unit of work. `commit` lets the callback distinguish an ordinary business
// outcome (conversation_not_found, an existing open escalation) — which still
// rolls back even though nothing threw — from a genuine new row, which commits.
async function withEscalationTransaction<T>(fn: (client: PoolClient) => Promise<TxOutcome<T>>): Promise<T> {
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

// Locks the parent conversation BEFORE checking for an existing open
// escalation: that lock serializes any concurrent escalation attempt for the
// same conversation at the PostgreSQL transaction level — the only
// idempotency mechanism TASK-022 needs, since the escalations table itself
// has no unique constraint (TASK-022A).
export async function createEscalation(
  rawConversationId: unknown,
  rawReason: unknown,
  rawContextSummary: unknown,
): Promise<CreateEscalationResult> {
  const conversationId = ConversationIdInputSchema.parse(rawConversationId);
  const reason = ReasonInputSchema.parse(rawReason);
  const contextSummary = ContextSummaryInputSchema.parse(rawContextSummary);

  return withEscalationTransaction<CreateEscalationResult>(async (client) => {
    const conversationLock = await withTimeout(
      client.query("SELECT id FROM conversations WHERE id = $1 FOR UPDATE", [conversationId]),
      ESCALATION_QUERY_TIMEOUT_MS,
      "createEscalation:lockConversation",
    );
    if (conversationLock.rows.length === 0) {
      return { commit: false, value: { created: false, reason: "conversation_not_found" } };
    }

    const existing = await withTimeout(
      client.query<EscalationRow>(
        `SELECT id, conversation_id, reason, context_summary, status, created_at
         FROM escalations
         WHERE conversation_id = $1 AND status = 'open'
         ORDER BY created_at ASC
         LIMIT 1`,
        [conversationId],
      ),
      ESCALATION_QUERY_TIMEOUT_MS,
      "createEscalation:findExistingOpen",
    );
    if (existing.rows.length > 0) {
      const existingRow = existing.rows[0] as EscalationRow;
      return { commit: false, value: { created: true, replayed: true, escalation: mapRowToEscalation(existingRow) } };
    }

    const inserted = await withTimeout(
      client.query<EscalationRow>(
        `INSERT INTO escalations (conversation_id, reason, context_summary, status)
         VALUES ($1, $2, $3, 'open')
         RETURNING id, conversation_id, reason, context_summary, status, created_at`,
        [conversationId, reason, contextSummary],
      ),
      ESCALATION_QUERY_TIMEOUT_MS,
      "createEscalation:insert",
    );
    const insertedRow = inserted.rows[0] as EscalationRow;
    return { commit: true, value: { created: true, replayed: false, escalation: mapRowToEscalation(insertedRow) } };
  });
}
