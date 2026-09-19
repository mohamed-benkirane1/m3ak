import { randomUUID } from "node:crypto";
import { z } from "zod";
import { postgresPool } from "../infrastructure/postgres";
import { withTimeout } from "../infrastructure/timeout";

const CHAT_SESSION_QUERY_TIMEOUT_MS = 3_000;

// No database constraint limits customers.external_ref. This is a transport
// safety limit for the simulator selector, not a business rule.
export const CustomerRefSchema = z.string().trim().min(1).max(128);

export type CreateChatSessionResult =
  | {
      created: true;
      conversationId: string;
      customerId: string;
      threadId: string;
    }
  | { created: false; reason: "customer_not_found" };

interface CustomerRow {
  id: string;
}

interface ConversationRow {
  id: string;
}

export async function createChatSession(rawCustomerRef: unknown): Promise<CreateChatSessionResult> {
  const customerRef = CustomerRefSchema.parse(rawCustomerRef);

  const customerResult = await withTimeout(
    postgresPool.query<CustomerRow>("SELECT id FROM customers WHERE external_ref = $1", [customerRef]),
    CHAT_SESSION_QUERY_TIMEOUT_MS,
    "createChatSession:findCustomer",
  );
  const customer = customerResult.rows[0] as CustomerRow | undefined;
  if (!customer) {
    return { created: false, reason: "customer_not_found" };
  }

  const threadId = randomUUID();
  const conversationResult = await withTimeout(
    postgresPool.query<ConversationRow>(
      `INSERT INTO conversations (customer_id, status, language, langgraph_thread_id)
       VALUES ($1, 'active', 'unknown', $2)
       RETURNING id`,
      [customer.id, threadId],
    ),
    CHAT_SESSION_QUERY_TIMEOUT_MS,
    "createChatSession:insertConversation",
  );

  return {
    created: true,
    conversationId: (conversationResult.rows[0] as ConversationRow).id,
    customerId: customer.id,
    threadId,
  };
}
