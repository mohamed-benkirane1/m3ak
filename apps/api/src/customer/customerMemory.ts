import { z } from "zod";
import { IsoDateTimeSchema, LanguageSchema } from "@m3ak/shared";
import { postgresPool } from "../infrastructure/postgres";
import { withTimeout } from "../infrastructure/timeout";

const CUSTOMER_MEMORY_QUERY_TIMEOUT_MS = 3_000;

const RECENT_PRODUCTS_LIMIT = 3;

const CustomerIdInputSchema = z.string().trim().uuid();

// TASK-025: a deterministic READ MODEL over already-persisted, already-
// validated business data — never a new memory store. No `name`/`phone`/
// `segment`/`address`, no raw order/item rows, no raw messages, nothing
// inferred by an LLM (TASK-025B §2).
export const CustomerMemorySchema = z
  .object({
    city: z.string().min(1).nullable(),
    preferredLanguage: LanguageSchema.nullable(),
    totalKnownOrders: z.number().int().nonnegative(),
    latestOrderDate: IsoDateTimeSchema.nullable(),
    recentProducts: z.array(z.string().min(1)).max(RECENT_PRODUCTS_LIMIT),
  })
  .strict();

export type CustomerMemory = z.infer<typeof CustomerMemorySchema>;

export type GetCustomerMemoryResult = { found: false } | { found: true; memory: CustomerMemory };

interface CustomerRow {
  city: string | null;
  preferred_language: string | null;
}

interface LatestLiveOrderRow {
  city: string;
  created_at: Date;
}

interface LatestHistoricalOrderRow {
  city: string;
  order_date: Date;
}

interface CountRow {
  count: string;
}

interface RecentProductRow {
  product_ref: string;
  latest_order_date: Date;
}

// Read-only: direct postgresPool queries (no checked-out client, no
// transaction) — matches loadConversationContext()'s own read-only
// convention (TASK-023). Never mutates the database.
export async function getCustomerMemory(rawCustomerId: unknown): Promise<GetCustomerMemoryResult> {
  const customerId = CustomerIdInputSchema.parse(rawCustomerId);

  const customerLookup = await withTimeout(
    postgresPool.query<CustomerRow>(`SELECT city, preferred_language FROM customers WHERE id = $1`, [customerId]),
    CUSTOMER_MEMORY_QUERY_TIMEOUT_MS,
    "getCustomerMemory:findCustomer",
  );
  if (customerLookup.rows.length === 0) {
    return { found: false };
  }
  const customerRow = customerLookup.rows[0] as CustomerRow;

  const latestLiveOrder = await withTimeout(
    postgresPool.query<LatestLiveOrderRow>(
      `SELECT city, created_at FROM orders WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [customerId],
    ),
    CUSTOMER_MEMORY_QUERY_TIMEOUT_MS,
    "getCustomerMemory:latestLiveOrder",
  );

  const latestHistoricalOrder = await withTimeout(
    postgresPool.query<LatestHistoricalOrderRow>(
      `SELECT city, order_date FROM historical_orders WHERE customer_id = $1 ORDER BY order_date DESC LIMIT 1`,
      [customerId],
    ),
    CUSTOMER_MEMORY_QUERY_TIMEOUT_MS,
    "getCustomerMemory:latestHistoricalOrder",
  );

  const liveOrderCount = await withTimeout(
    postgresPool.query<CountRow>(`SELECT COUNT(*) AS count FROM orders WHERE customer_id = $1`, [customerId]),
    CUSTOMER_MEMORY_QUERY_TIMEOUT_MS,
    "getCustomerMemory:countLiveOrders",
  );

  const historicalOrderCount = await withTimeout(
    postgresPool.query<CountRow>(`SELECT COUNT(*) AS count FROM historical_orders WHERE customer_id = $1`, [customerId]),
    CUSTOMER_MEMORY_QUERY_TIMEOUT_MS,
    "getCustomerMemory:countHistoricalOrders",
  );

  // Deduplicates by product_ref (GROUP BY) BEFORE the final LIMIT, so the
  // limit can never truncate a still-relevant distinct ref behind a run of
  // repeated occurrences of another ref (TASK-025C). latest_order_date is
  // each product's own most recent occurrence across live + historical
  // orders; product_ref ASC is a deterministic tiebreaker for same-instant
  // occurrences.
  const recentProductRows = await withTimeout(
    postgresPool.query<RecentProductRow>(
      `SELECT product_ref, MAX(order_date) AS latest_order_date
       FROM (
         SELECT oi.product_ref AS product_ref, o.created_at AS order_date
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         WHERE o.customer_id = $1
         UNION ALL
         SELECT hoi.product_ref AS product_ref, ho.order_date::timestamptz AS order_date
         FROM historical_order_items hoi
         JOIN historical_orders ho ON ho.commande_id = hoi.commande_id
         WHERE ho.customer_id = $1
       ) combined
       GROUP BY product_ref
       ORDER BY latest_order_date DESC, product_ref ASC
       LIMIT $2`,
      [customerId, RECENT_PRODUCTS_LIMIT],
    ),
    CUSTOMER_MEMORY_QUERY_TIMEOUT_MS,
    "getCustomerMemory:recentProducts",
  );

  // City precedence (TASK-025B §4): latest live order city, then latest
  // historical order city, then customers.city — customers.city is never
  // assumed to already be up to date.
  const liveOrderRow = latestLiveOrder.rows[0] as LatestLiveOrderRow | undefined;
  const historicalOrderRow = latestHistoricalOrder.rows[0] as LatestHistoricalOrderRow | undefined;
  const city = liveOrderRow?.city ?? historicalOrderRow?.city ?? customerRow.city ?? null;

  // customers.preferred_language is the only source for this field; "unknown"
  // is a real, schema-valid value here — the caller (graph.ts) decides
  // whether "unknown" is usable as a fallback, not this read model.
  const preferredLanguage = LanguageSchema.nullable().parse(customerRow.preferred_language);

  const liveCount = Number((liveOrderCount.rows[0] as CountRow).count);
  const historicalCount = Number((historicalOrderCount.rows[0] as CountRow).count);
  const totalKnownOrders = liveCount + historicalCount;

  const liveLatestDate = liveOrderRow?.created_at ?? null;
  const historicalLatestDate = historicalOrderRow?.order_date ?? null;
  let latestOrderDate: string | null = null;
  if (liveLatestDate && historicalLatestDate) {
    latestOrderDate =
      (liveLatestDate.getTime() >= historicalLatestDate.getTime() ? liveLatestDate : historicalLatestDate).toISOString();
  } else if (liveLatestDate) {
    latestOrderDate = liveLatestDate.toISOString();
  } else if (historicalLatestDate) {
    latestOrderDate = historicalLatestDate.toISOString();
  }

  // Already distinct, already most-recent-first, already capped at exactly
  // RECENT_PRODUCTS_LIMIT by the SQL itself — no further JS dedup/limit.
  const recentProducts = (recentProductRows.rows as RecentProductRow[]).map((row) => row.product_ref);

  const memory = CustomerMemorySchema.parse({
    city,
    preferredLanguage,
    totalKnownOrders,
    latestOrderDate,
    recentProducts,
  });

  return { found: true, memory };
}
