import {
  ConversationStatusSchema,
  EscalationStatusSchema,
  FollowupStatusSchema,
  IsoDateTimeSchema,
  LanguageSchema,
  OrderStatusSchema,
} from "@m3ak/shared";
import { z } from "zod";
import { postgresPool } from "../infrastructure/postgres";
import { withTimeout } from "../infrastructure/timeout";

export const DASHBOARD_LIST_LIMIT = 10;
const DASHBOARD_QUERY_TIMEOUT_MS = 3_000;
const FALLBACK_CUSTOMER_REF = "Client";

const NonNegativeSafeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .refine(Number.isSafeInteger, "Expected a safe integer");

const MetricsSchema = z
  .object({
    conversations: NonNegativeSafeIntegerSchema,
    orders: NonNegativeSafeIntegerSchema,
    convertedConversations: NonNegativeSafeIntegerSchema,
    conversionRate: z.number().finite().min(0).max(100).nullable(),
    openEscalations: NonNegativeSafeIntegerSchema,
    scheduledFollowups: NonNegativeSafeIntegerSchema,
    orderValueCents: NonNegativeSafeIntegerSchema,
    currency: z.literal("MAD"),
  })
  .strict()
  .superRefine((metrics, context) => {
    if (metrics.convertedConversations > metrics.conversations) {
      context.addIssue({ code: "custom", message: "Converted conversations exceed conversations" });
    }
    if ((metrics.conversations === 0) !== (metrics.conversionRate === null)) {
      context.addIssue({ code: "custom", message: "Conversion rate denominator invariant failed" });
    }
  });

const ConversationSummarySchema = z
  .object({
    customerRef: z.string().trim().min(1),
    language: LanguageSchema,
    status: ConversationStatusSchema,
    messageCount: NonNegativeSafeIntegerSchema,
    hasOrder: z.boolean(),
    hasOpenEscalation: z.boolean(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();

const OrderSummarySchema = z
  .object({
    customerRef: z.string().trim().min(1),
    status: OrderStatusSchema,
    totalCents: NonNegativeSafeIntegerSchema,
    createdAt: IsoDateTimeSchema,
  })
  .strict();

const EscalationSummarySchema = z
  .object({
    customerRef: z.string().trim().min(1),
    status: EscalationStatusSchema,
    reasonLabel: z.string().min(1),
    createdAt: IsoDateTimeSchema,
  })
  .strict();

const FollowupSummarySchema = z
  .object({
    customerRef: z.string().trim().min(1),
    status: FollowupStatusSchema,
    scheduledAt: IsoDateTimeSchema,
    executedAt: IsoDateTimeSchema.nullable(),
  })
  .strict();

export const DashboardResponseSchema = z
  .object({
    metrics: MetricsSchema,
    conversations: z.array(ConversationSummarySchema).max(DASHBOARD_LIST_LIMIT),
    orders: z.array(OrderSummarySchema).max(DASHBOARD_LIST_LIMIT),
    escalations: z.array(EscalationSummarySchema).max(DASHBOARD_LIST_LIMIT),
    followups: z.array(FollowupSummarySchema).max(DASHBOARD_LIST_LIMIT),
  })
  .strict();

export type DashboardResponse = z.infer<typeof DashboardResponseSchema>;

interface MetricsRow {
  conversations: unknown;
  orders: unknown;
  converted_conversations: unknown;
  open_escalations: unknown;
  scheduled_followups: unknown;
  order_value_cents: unknown;
}

interface ConversationRow {
  customer_ref: unknown;
  language: unknown;
  status: unknown;
  message_count: unknown;
  has_order: unknown;
  has_open_escalation: unknown;
  created_at: unknown;
  updated_at: unknown;
}

interface OrderRow {
  customer_ref: unknown;
  status: unknown;
  total_cents: unknown;
  created_at: unknown;
}

interface EscalationRow {
  customer_ref: unknown;
  status: unknown;
  reason: unknown;
  created_at: unknown;
}

interface FollowupRow {
  customer_ref: unknown;
  status: unknown;
  scheduled_at: unknown;
  executed_at: unknown;
}

const ESCALATION_REASON_LABELS: Readonly<Record<string, string>> = {
  unverifiable_observation: "Résultat non vérifiable",
  missing_stock_evidence: "Stock non vérifié",
  missing_promotion_evidence: "Promotion non vérifiée",
  missing_delivery_evidence: "Livraison non vérifiée",
  ambiguous_product_reference: "Produit ambigu",
  unsupported_restock_claim: "Réassort non vérifiable",
  agent_step_limit_reached: "Limite d’automatisation atteinte",
  orchestrator_requested_escalation: "Intervention humaine demandée",
};

export function getEscalationReasonLabel(reason: unknown): string {
  if (typeof reason !== "string") return "Intervention humaine requise";
  const reasons = reason.split(",").map((item) => item.trim()).filter(Boolean);
  if (reasons.length === 0) return "Intervention humaine requise";

  const labels = reasons.map((item) => ESCALATION_REASON_LABELS[item]);
  return labels.every((label): label is string => typeof label === "string")
    ? labels.join(" · ")
    : "Intervention humaine requise";
}

function normalizeNonNegativeSafeInteger(value: unknown): number {
  const normalized =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : Number.NaN;

  return NonNegativeSafeIntegerSchema.parse(normalized);
}

function normalizeCustomerRef(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) return FALLBACK_CUSTOMER_REF;
  return value.trim();
}

function normalizeBoolean(value: unknown): boolean {
  return z.boolean().parse(value);
}

function normalizeIsoDate(value: unknown): string {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  if (date === null || Number.isNaN(date.getTime())) throw new Error("Invalid dashboard timestamp");
  return IsoDateTimeSchema.parse(date.toISOString());
}

function normalizeNullableIsoDate(value: unknown): string | null {
  return value === null ? null : normalizeIsoDate(value);
}

export async function getDashboardData(): Promise<DashboardResponse> {
  const [metricsResult, conversationsResult, ordersResult, escalationsResult, followupsResult] = await Promise.all([
    withTimeout(
      postgresPool.query<MetricsRow>(`
        SELECT
          (SELECT COUNT(*) FROM conversations) AS conversations,
          (SELECT COUNT(*) FROM orders) AS orders,
          (SELECT COUNT(DISTINCT conversation_id) FROM orders) AS converted_conversations,
          (SELECT COUNT(*) FROM escalations WHERE status = 'open') AS open_escalations,
          (SELECT COUNT(*) FROM followups WHERE status = 'scheduled') AS scheduled_followups,
          COALESCE((SELECT SUM(total_cents) FROM orders), 0) AS order_value_cents
      `),
      DASHBOARD_QUERY_TIMEOUT_MS,
      "dashboard:metrics",
    ),
    withTimeout(
      postgresPool.query<ConversationRow>(
        `SELECT
           COALESCE(NULLIF(BTRIM(customer.external_ref), ''), $2) AS customer_ref,
           conversation.language,
           conversation.status,
           (SELECT COUNT(*) FROM messages WHERE conversation_id = conversation.id) AS message_count,
           EXISTS (SELECT 1 FROM orders WHERE conversation_id = conversation.id) AS has_order,
           EXISTS (
             SELECT 1 FROM escalations
             WHERE conversation_id = conversation.id AND status = 'open'
           ) AS has_open_escalation,
           conversation.created_at,
           conversation.updated_at
         FROM conversations AS conversation
         INNER JOIN customers AS customer ON customer.id = conversation.customer_id
         ORDER BY conversation.updated_at DESC, conversation.id DESC
         LIMIT $1`,
        [DASHBOARD_LIST_LIMIT, FALLBACK_CUSTOMER_REF],
      ),
      DASHBOARD_QUERY_TIMEOUT_MS,
      "dashboard:conversations",
    ),
    withTimeout(
      postgresPool.query<OrderRow>(
        `SELECT
           COALESCE(NULLIF(BTRIM(customer.external_ref), ''), $2) AS customer_ref,
           orders.status,
           orders.total_cents,
           orders.created_at
         FROM orders
         INNER JOIN customers AS customer ON customer.id = orders.customer_id
         ORDER BY orders.created_at DESC, orders.id DESC
         LIMIT $1`,
        [DASHBOARD_LIST_LIMIT, FALLBACK_CUSTOMER_REF],
      ),
      DASHBOARD_QUERY_TIMEOUT_MS,
      "dashboard:orders",
    ),
    withTimeout(
      postgresPool.query<EscalationRow>(
        `SELECT
           COALESCE(NULLIF(BTRIM(customer.external_ref), ''), $2) AS customer_ref,
           escalation.status,
           escalation.reason,
           escalation.created_at
         FROM escalations AS escalation
         INNER JOIN conversations AS conversation ON conversation.id = escalation.conversation_id
         INNER JOIN customers AS customer ON customer.id = conversation.customer_id
         ORDER BY escalation.created_at DESC, escalation.id DESC
         LIMIT $1`,
        [DASHBOARD_LIST_LIMIT, FALLBACK_CUSTOMER_REF],
      ),
      DASHBOARD_QUERY_TIMEOUT_MS,
      "dashboard:escalations",
    ),
    withTimeout(
      postgresPool.query<FollowupRow>(
        `SELECT
           COALESCE(NULLIF(BTRIM(customer.external_ref), ''), $2) AS customer_ref,
           followup.status,
           followup.scheduled_at,
           followup.executed_at
         FROM followups AS followup
         INNER JOIN conversations AS conversation ON conversation.id = followup.conversation_id
         INNER JOIN customers AS customer ON customer.id = conversation.customer_id
         ORDER BY followup.created_at DESC, followup.id DESC
         LIMIT $1`,
        [DASHBOARD_LIST_LIMIT, FALLBACK_CUSTOMER_REF],
      ),
      DASHBOARD_QUERY_TIMEOUT_MS,
      "dashboard:followups",
    ),
  ]);

  const metricsRow = metricsResult.rows[0];
  if (metricsRow === undefined) throw new Error("Dashboard metrics query returned no row");

  const conversations = normalizeNonNegativeSafeInteger(metricsRow.conversations);
  const convertedConversations = normalizeNonNegativeSafeInteger(metricsRow.converted_conversations);

  const response: DashboardResponse = {
    metrics: {
      conversations,
      orders: normalizeNonNegativeSafeInteger(metricsRow.orders),
      convertedConversations,
      conversionRate: conversations === 0 ? null : (convertedConversations / conversations) * 100,
      openEscalations: normalizeNonNegativeSafeInteger(metricsRow.open_escalations),
      scheduledFollowups: normalizeNonNegativeSafeInteger(metricsRow.scheduled_followups),
      orderValueCents: normalizeNonNegativeSafeInteger(metricsRow.order_value_cents),
      currency: "MAD",
    },
    conversations: conversationsResult.rows.map((row) => ({
      customerRef: normalizeCustomerRef(row.customer_ref),
      language: LanguageSchema.parse(row.language),
      status: ConversationStatusSchema.parse(row.status),
      messageCount: normalizeNonNegativeSafeInteger(row.message_count),
      hasOrder: normalizeBoolean(row.has_order),
      hasOpenEscalation: normalizeBoolean(row.has_open_escalation),
      createdAt: normalizeIsoDate(row.created_at),
      updatedAt: normalizeIsoDate(row.updated_at),
    })),
    orders: ordersResult.rows.map((row) => ({
      customerRef: normalizeCustomerRef(row.customer_ref),
      status: OrderStatusSchema.parse(row.status),
      totalCents: normalizeNonNegativeSafeInteger(row.total_cents),
      createdAt: normalizeIsoDate(row.created_at),
    })),
    escalations: escalationsResult.rows.map((row) => ({
      customerRef: normalizeCustomerRef(row.customer_ref),
      status: EscalationStatusSchema.parse(row.status),
      reasonLabel: getEscalationReasonLabel(row.reason),
      createdAt: normalizeIsoDate(row.created_at),
    })),
    followups: followupsResult.rows.map((row) => ({
      customerRef: normalizeCustomerRef(row.customer_ref),
      status: FollowupStatusSchema.parse(row.status),
      scheduledAt: normalizeIsoDate(row.scheduled_at),
      executedAt: normalizeNullableIsoDate(row.executed_at),
    })),
  };

  return DashboardResponseSchema.parse(response);
}
