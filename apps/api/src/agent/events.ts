import { z } from "zod";
import { postgresPool } from "../infrastructure/postgres";
import { withTimeout } from "../infrastructure/timeout";

const AGENT_EVENTS_QUERY_TIMEOUT_MS = 3_000;
export const MAX_AGENT_EVENT_BATCH_SIZE = 128;

export const AgentStatusSchema = z.enum([
  "loading_context",
  "planning",
  "escalating_to_human",
  "saving_conversation",
]);

export const PublicToolNameSchema = z.enum([
  "searchProducts",
  "getAvailability",
  "findAlternatives",
  "getApplicablePromotion",
  "getDeliveryOptions",
  "createCart",
  "addCartItem",
  "updateCartItem",
  "removeCartItem",
  "validateDiscount",
  "createOrder",
]);

export const PublicGuardrailCategorySchema = z.enum([
  "ambiguous_product",
  "stock_unverified",
  "promotion_unverified",
  "delivery_unverified",
  "unsupported_restock",
  "automation_limit",
  "unverifiable_result",
  "discount_unverified",
  "discount_limit_exceeded",
]);

export const AgentStatusEventSchema = z
  .object({ type: z.literal("agent.status"), status: AgentStatusSchema })
  .strict();

export const AgentToolEventSchema = z.discriminatedUnion("status", [
  z.object({ type: z.literal("agent.tool"), tool: PublicToolNameSchema, status: z.literal("started") }).strict(),
  z
    .object({
      type: z.literal("agent.tool"),
      tool: PublicToolNameSchema,
      status: z.literal("completed"),
      outcome: z.enum(["positive", "negative"]),
    })
    .strict(),
  z.object({ type: z.literal("agent.tool"), tool: PublicToolNameSchema, status: z.literal("failed") }).strict(),
]);

export const AgentGuardrailEventSchema = z
  .object({
    type: z.literal("agent.guardrail"),
    status: z.enum(["allowed", "blocked", "clarification_required", "escalation_required", "not_applicable"]),
    categories: z.array(PublicGuardrailCategorySchema),
  })
  .strict();

export const PublicAgentEventSchema = z.discriminatedUnion("type", [
  AgentStatusEventSchema,
  AgentToolEventSchema,
  AgentGuardrailEventSchema,
]);

export type PublicAgentEvent = z.infer<typeof PublicAgentEventSchema>;
export type PublicToolName = z.infer<typeof PublicToolNameSchema>;

const PublicActivitySchema = z.object({ kind: z.literal("public"), event: PublicAgentEventSchema }).strict();
const EscalationCreatedActivitySchema = z.object({ kind: z.literal("escalation_created") }).strict();

export const SanitizedAgentActivitySchema = z.discriminatedUnion("kind", [
  PublicActivitySchema,
  EscalationCreatedActivitySchema,
]);

export type SanitizedAgentActivity = z.infer<typeof SanitizedAgentActivitySchema>;
export type AgentActivitySink = (activity: SanitizedAgentActivity) => void;

export const NOOP_AGENT_ACTIVITY_SINK: AgentActivitySink = () => undefined;

// Activity is observational. Neither malformed instrumentation nor a failing
// delivery sink may alter graph business execution.
export function emitAgentActivity(sink: AgentActivitySink, activity: SanitizedAgentActivity): void {
  try {
    sink(SanitizedAgentActivitySchema.parse(activity));
  } catch {
    // Deliberately empty: never log state or turn a visibility failure into a
    // business failure.
  }
}

export const PUBLIC_TOOL_BY_ACTION = {
  SEARCH_PRODUCTS: "searchProducts",
  CHECK_STOCK: "getAvailability",
  FIND_ALTERNATIVES: "findAlternatives",
  CHECK_PROMOTION: "getApplicablePromotion",
  CHECK_DELIVERY: "getDeliveryOptions",
  CREATE_CART: "createCart",
  ADD_TO_CART: "addCartItem",
  UPDATE_CART_ITEM: "updateCartItem",
  REMOVE_CART_ITEM: "removeCartItem",
  VALIDATE_DISCOUNT: "validateDiscount",
  CREATE_ORDER: "createOrder",
} as const satisfies Record<string, PublicToolName>;

export type PublicToolAction = keyof typeof PUBLIC_TOOL_BY_ACTION;

const PUBLIC_GUARDRAIL_CATEGORY_BY_REASON = {
  ambiguous_product_reference: "ambiguous_product",
  missing_stock_evidence: "stock_unverified",
  missing_promotion_evidence: "promotion_unverified",
  missing_delivery_evidence: "delivery_unverified",
  unsupported_restock_claim: "unsupported_restock",
  agent_step_limit_reached: "automation_limit",
  unverifiable_observation: "unverifiable_result",
  missing_discount_evidence: "discount_unverified",
  discount_limit_exceeded: "discount_limit_exceeded",
} as const satisfies Record<string, z.infer<typeof PublicGuardrailCategorySchema>>;

export function createGuardrailEvent(decision: {
  authorized: boolean | null;
  clarificationNeeded: boolean;
  humanInterventionNeeded: boolean;
  reasons: string[];
}): z.infer<typeof AgentGuardrailEventSchema> {
  const status = decision.humanInterventionNeeded
    ? "escalation_required"
    : decision.clarificationNeeded
      ? "clarification_required"
      : decision.authorized === true
        ? "allowed"
        : decision.authorized === false
          ? "blocked"
          : "not_applicable";

  const categories = decision.reasons.flatMap((reason) => {
    const category = PUBLIC_GUARDRAIL_CATEGORY_BY_REASON[
      reason as keyof typeof PUBLIC_GUARDRAIL_CATEGORY_BY_REASON
    ];
    return category === undefined ? [] : [category];
  });

  return AgentGuardrailEventSchema.parse({ type: "agent.guardrail", status, categories });
}

export function toPublicAgentEvent(activity: SanitizedAgentActivity): PublicAgentEvent | null {
  const parsed = SanitizedAgentActivitySchema.parse(activity);
  return parsed.kind === "public" ? parsed.event : null;
}

const EmptyPayloadSchema = z.object({}).strict();
export const DurableAgentEventRecordSchema = z.discriminatedUnion("eventType", [
  z.object({
    eventType: z.literal("node_started"),
    payload: z.object({ stage: AgentStatusSchema }).strict(),
  }).strict(),
  z.object({
    eventType: z.literal("tool_called"),
    payload: z.object({ tool: PublicToolNameSchema }).strict(),
  }).strict(),
  z.object({
    eventType: z.literal("tool_succeeded"),
    payload: z.object({ tool: PublicToolNameSchema, outcome: z.enum(["positive", "negative"]) }).strict(),
  }).strict(),
  z.object({
    eventType: z.literal("tool_failed"),
    payload: z.object({ tool: PublicToolNameSchema }).strict(),
  }).strict(),
  z.object({
    eventType: z.literal("guardrail_blocked"),
    payload: z
      .object({
        status: z.enum(["blocked", "escalation_required"]),
        categories: z.array(PublicGuardrailCategorySchema),
      })
      .strict(),
  }).strict(),
  z.object({
    eventType: z.literal("clarification_requested"),
    payload: z.object({ categories: z.array(PublicGuardrailCategorySchema) }).strict(),
  }).strict(),
  z.object({ eventType: z.literal("escalation_created"), payload: EmptyPayloadSchema }).strict(),
  z.object({ eventType: z.literal("order_created"), payload: EmptyPayloadSchema }).strict(),
]);

export type DurableAgentEventRecord = z.infer<typeof DurableAgentEventRecordSchema>;

export function toDurableAgentEventRecords(activity: SanitizedAgentActivity): DurableAgentEventRecord[] {
  const parsed = SanitizedAgentActivitySchema.parse(activity);
  if (parsed.kind === "escalation_created") {
    return [{ eventType: "escalation_created", payload: {} }];
  }

  const event = parsed.event;
  if (event.type === "agent.status") {
    return [{ eventType: "node_started", payload: { stage: event.status } }];
  }
  if (event.type === "agent.tool") {
    if (event.status === "started") {
      return [{ eventType: "tool_called", payload: { tool: event.tool } }];
    }
    if (event.status === "failed") {
      return [{ eventType: "tool_failed", payload: { tool: event.tool } }];
    }
    const records: DurableAgentEventRecord[] = [
      { eventType: "tool_succeeded", payload: { tool: event.tool, outcome: event.outcome } },
    ];
    if (event.tool === "createOrder" && event.outcome === "positive") {
      records.push({ eventType: "order_created", payload: {} });
    }
    return records;
  }
  if (event.status === "clarification_required") {
    return [{ eventType: "clarification_requested", payload: { categories: event.categories } }];
  }
  if (event.status === "blocked" || event.status === "escalation_required") {
    return [{ eventType: "guardrail_blocked", payload: { status: event.status, categories: event.categories } }];
  }
  return [];
}

const ConversationIdSchema = z.string().uuid();
const DurableAgentEventBatchSchema = z.array(DurableAgentEventRecordSchema).max(MAX_AGENT_EVENT_BATCH_SIZE);

export async function persistAgentEvents(
  rawConversationId: unknown,
  rawRecords: unknown,
): Promise<void> {
  const conversationId = ConversationIdSchema.parse(rawConversationId);
  const records = DurableAgentEventBatchSchema.parse(rawRecords);
  if (records.length === 0) return;

  const values: unknown[] = [conversationId];
  const tuples = records.map((record, index) => {
    const eventTypeParameter = index * 2 + 2;
    const payloadParameter = eventTypeParameter + 1;
    values.push(record.eventType, JSON.stringify(record.payload));
    return `($1, $${eventTypeParameter}, $${payloadParameter}::jsonb, NULL)`;
  });

  await withTimeout(
    postgresPool.query(
      `INSERT INTO agent_events (conversation_id, event_type, payload, duration_ms)
       VALUES ${tuples.join(", ")}`,
      values,
    ),
    AGENT_EVENTS_QUERY_TIMEOUT_MS,
    "persistAgentEvents:batchInsert",
  );
}
