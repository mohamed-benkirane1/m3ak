import { PoolClient } from "pg";
import { z } from "zod";
import { Conversation, ConversationSchema, LanguageSchema, Message, MessageSchema } from "@m3ak/shared";
import { getCart } from "../cart/cart";
import { postgresPool } from "../infrastructure/postgres";
import { withTimeout } from "../infrastructure/timeout";

const CONVERSATION_QUERY_TIMEOUT_MS = 3_000;

const ThreadIdInputSchema = z.string().trim().min(1);
const ConversationIdInputSchema = z.string().trim().uuid();
const HasOpenEscalationInputSchema = z.boolean();
// Reuses the shared MessageSchema (not a private state.ts const, which is not
// exported): current-invocation messages carry only role/content, exactly
// like apps/api/src/agent/state.ts's own StateMessageSchema derivation.
const IncomingMessageSchema = MessageSchema.pick({ role: true, content: true }).strict();
const MessagesInputSchema = z.array(IncomingMessageSchema);

export interface CartSnapshot {
  id: string;
  version: number;
  items: Array<{
    productRef: string;
    quantity: number;
    unitPrice: number;
  }>;
}

export type LoadConversationContextResult =
  | {
      found: true;
      conversation: Conversation;
      messages: Message[];
      cart: CartSnapshot | null;
      escalationId: string | null;
    }
  | { found: false };

export type PersistConversationResult =
  | { persisted: true; conversation: Conversation; newMessageCount: number }
  | { persisted: false; reason: "conversation_not_found" };

interface ConversationRow {
  id: string;
  customer_id: string;
  status: string;
  language: string;
  created_at: Date;
  updated_at: Date;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  created_at: Date;
}

function mapRowToConversation(row: ConversationRow): Conversation {
  return ConversationSchema.parse({
    id: row.id,
    customerId: row.customer_id,
    status: row.status,
    language: row.language,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

function mapRowToMessage(row: MessageRow): Message {
  return MessageSchema.parse({
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at.toISOString(),
  });
}

// Read-only: uses the shared pool directly (no checked-out client, no
// transaction) — matches the existing read-only convention already used by
// getAvailability()/getApplicablePromotion(). Nothing here writes anything.
export async function loadConversationContext(rawThreadId: unknown): Promise<LoadConversationContextResult> {
  const threadId = ThreadIdInputSchema.parse(rawThreadId);

  const conversationResult = await withTimeout(
    postgresPool.query<ConversationRow>(
      `SELECT id, customer_id, status, language, created_at, updated_at
       FROM conversations
       WHERE langgraph_thread_id = $1`,
      [threadId],
    ),
    CONVERSATION_QUERY_TIMEOUT_MS,
    "loadConversationContext:findConversation",
  );
  if (conversationResult.rows.length === 0) {
    return { found: false };
  }
  const conversation = mapRowToConversation(conversationResult.rows[0] as ConversationRow);

  const messagesResult = await withTimeout(
    postgresPool.query<MessageRow>(
      `SELECT id, conversation_id, role, content, created_at
       FROM messages
       WHERE conversation_id = $1
       ORDER BY created_at ASC, id ASC`,
      [conversation.id],
    ),
    CONVERSATION_QUERY_TIMEOUT_MS,
    "loadConversationContext:listMessages",
  );
  const messages = messagesResult.rows.map(mapRowToMessage);

  // carts.status is a free non-empty TEXT column (no CHECK enum), but
  // createCart() only ever writes the literal 'active' — a real, actually-used
  // value, not an invented one (TASK-023A §19).
  const cartLookup = await withTimeout(
    postgresPool.query<{ id: string }>(
      `SELECT id
       FROM carts
       WHERE conversation_id = $1 AND status = 'active'
       ORDER BY updated_at DESC, id ASC
       LIMIT 1`,
      [conversation.id],
    ),
    CONVERSATION_QUERY_TIMEOUT_MS,
    "loadConversationContext:findActiveCart",
  );
  let cart: CartSnapshot | null = null;
  const cartRow = cartLookup.rows[0] as { id: string } | undefined;
  if (cartRow) {
    // Reuses the existing, already-tested getCart() — never duplicates
    // cart-item/pricing mapping logic.
    const cartResult = await getCart(cartRow.id);
    if (cartResult.found) {
      cart = {
        id: cartResult.cart.id,
        version: cartResult.cart.version,
        items: cartResult.cart.items.map((item) => ({
          productRef: item.productRef,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
        })),
      };
    }
  }

  const escalationLookup = await withTimeout(
    postgresPool.query<{ id: string }>(
      `SELECT id
       FROM escalations
       WHERE conversation_id = $1 AND status = 'open'
       ORDER BY created_at ASC, id ASC
       LIMIT 1`,
      [conversation.id],
    ),
    CONVERSATION_QUERY_TIMEOUT_MS,
    "loadConversationContext:findOpenEscalation",
  );
  const escalationId = (escalationLookup.rows[0] as { id: string } | undefined)?.id ?? null;

  return { found: true, conversation, messages, cart, escalationId };
}

interface TxOutcome<T> {
  commit: boolean;
  value: T;
}

// Same pattern as escalation.ts's withEscalationTransaction: one checked-out
// client from the existing shared pool, single BEGIN..COMMIT/ROLLBACK unit of
// work.
async function withConversationTransaction<T>(fn: (client: PoolClient) => Promise<TxOutcome<T>>): Promise<T> {
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

// hasOpenEscalation is a real current business fact and always wins. Absent
// that, the current DB status is left exactly as-is: TASK-023 never
// auto-downgrades escalated/completed back to active, and never writes
// 'completed' itself (TASK-023A §25).
function resolveTargetStatus(currentStatus: string, hasOpenEscalation: boolean): string {
  return hasOpenEscalation ? "escalated" : currentStatus;
}

// Correctness here assumes loadContext's persisted-history-prefix + current-
// invocation-messages merge (state.messages) forms a true prefix-consistent
// cumulative list: this is a count-and-tail strategy, not exactly-once
// delivery — there are no per-message IDs/hashes to prove global uniqueness.
// A dbCount that exceeds the cumulative message count indicates that
// invariant broke (history was rewritten/lost) and is a data-integrity error,
// not a normal outcome — it must never silently truncate or rewrite persisted
// messages.
export async function persistConversation(
  rawConversationId: unknown,
  rawLanguage: unknown,
  rawHasOpenEscalation: unknown,
  rawMessages: unknown,
): Promise<PersistConversationResult> {
  const conversationId = ConversationIdInputSchema.parse(rawConversationId);
  const language = LanguageSchema.parse(rawLanguage);
  const hasOpenEscalation = HasOpenEscalationInputSchema.parse(rawHasOpenEscalation);
  const messages = MessagesInputSchema.parse(rawMessages);

  return withConversationTransaction<PersistConversationResult>(async (client) => {
    const lock = await withTimeout(
      client.query<{ id: string; status: string }>(
        "SELECT id, status FROM conversations WHERE id = $1 FOR UPDATE",
        [conversationId],
      ),
      CONVERSATION_QUERY_TIMEOUT_MS,
      "persistConversation:lockConversation",
    );
    if (lock.rows.length === 0) {
      return { commit: false, value: { persisted: false, reason: "conversation_not_found" } };
    }
    const currentStatus = (lock.rows[0] as { id: string; status: string }).status;
    const targetStatus = resolveTargetStatus(currentStatus, hasOpenEscalation);

    const updated = await withTimeout(
      client.query<ConversationRow>(
        `UPDATE conversations
         SET language = $2, status = $3, updated_at = now()
         WHERE id = $1
         RETURNING id, customer_id, status, language, created_at, updated_at`,
        [conversationId, language, targetStatus],
      ),
      CONVERSATION_QUERY_TIMEOUT_MS,
      "persistConversation:updateConversation",
    );
    const conversation = mapRowToConversation(updated.rows[0] as ConversationRow);

    const countResult = await withTimeout(
      client.query<{ count: string }>(
        "SELECT COUNT(*) AS count FROM messages WHERE conversation_id = $1",
        [conversationId],
      ),
      CONVERSATION_QUERY_TIMEOUT_MS,
      "persistConversation:countMessages",
    );
    // pg returns COUNT(*) as a string to avoid silent precision loss.
    const dbCount = Number((countResult.rows[0] as { count: string }).count);
    if (dbCount > messages.length) {
      throw new Error("conversation_message_history_mismatch");
    }

    const newMessages = messages.slice(dbCount);
    for (const message of newMessages) {
      await withTimeout(
        client.query("INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)", [
          conversationId,
          message.role,
          message.content,
        ]),
        CONVERSATION_QUERY_TIMEOUT_MS,
        "persistConversation:insertMessage",
      );
    }

    return { commit: true, value: { persisted: true, conversation, newMessageCount: newMessages.length } };
  });
}
