import { PoolClient } from "pg";
import { z } from "zod";
import { IsoDateSchema, Order, OrderSchema, PaymentMethod, PaymentMethodSchema } from "@m3ak/shared";
import { centimesToMad } from "../infrastructure/money";
import { postgresPool } from "../infrastructure/postgres";
import { getProductPricingContext } from "../catalogue/promotions";
import { DeliveryCityInputSchema, getDeliveryOptions } from "../delivery/delivery";

const CartIdInputSchema = z.string().trim().uuid();
const ConfirmedInputSchema = z.boolean();

const POSTGRES_INTEGER_MAX = 2_147_483_647;

// products_total_cents / delivery_fee_cents / total_cents / unit_price_cents /
// quantity are all PostgreSQL `integer` columns (max 2_147_483_647), a much
// lower ceiling than Number.MAX_SAFE_INTEGER — a JS-safe value can still
// overflow this column and would otherwise surface as a raw, unanticipated
// "integer out of range" error from Postgres instead of a clean guard here.
function assertPostgresIntegerRange(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > POSTGRES_INTEGER_MAX) {
    throw new Error(`Integrity error: ${label} (${value}) is outside PostgreSQL INTEGER range [0, ${POSTGRES_INTEGER_MAX}]`);
  }
}

export type PriceChange = {
  productRef: string;
  quantity: number;
  cartUnitPriceCents: number;
  currentUnitPriceCents: number;
};

export type CreateOrderResult =
  | { created: true; replayed: boolean; order: Order }
  | { created: false; reason: "confirmation_required" }
  | { created: false; reason: "cart_not_found" }
  | { created: false; reason: "empty_cart" }
  | { created: false; reason: "product_not_found"; productRef: string }
  | {
      created: false;
      reason: "insufficient_stock";
      productRef: string;
      requestedQuantity: number;
      availableStock: number;
    }
  | { created: false; reason: "price_changed"; changes: PriceChange[] }
  | { created: false; reason: "delivery_not_found"; city: string }
  | { created: false; reason: "payment_not_allowed_for_delivery_zone"; city: string; paymentMethod: PaymentMethod }
  | { created: false; reason: "idempotency_conflict" };

interface CartLockRow {
  id: string;
  conversation_id: string;
  customer_id: string;
  version: number;
}

interface ExistingOrderRow {
  id: string;
  customer_id: string;
  conversation_id: string;
  status: string;
  products_total_cents: number;
  delivery_fee_cents: number;
  total_cents: number;
  city: string;
  payment_method: string;
  created_at: Date;
  city_matches: boolean;
}

interface ExistingOrderItemRow {
  id: string;
  product_ref: string;
  quantity: number;
  unit_price_cents: number;
}

type ExistingOrderReplayResult =
  | { found: false }
  | { found: true; conflict: true }
  | { found: true; conflict: false; order: Order };

interface CartItemRow {
  product_ref: string;
  quantity: number;
  unit_price_cents: number;
}

interface ProductLockRow {
  ref: string;
  stock: number;
}

interface CreatedOrderRow {
  id: string;
  customer_id: string;
  conversation_id: string;
  status: string;
  products_total_cents: number;
  delivery_fee_cents: number;
  total_cents: number;
  city: string;
  payment_method: string;
  created_at: Date;
}

interface ResolvedOrderItem {
  productRef: string;
  quantity: number;
  effectivePriceCents: number;
}

interface TxOutcome<T> {
  commit: boolean;
  value: T;
}

// createOrder's own BEGIN..COMMIT/ROLLBACK unit of work, on a single checked-out
// client from the existing shared pool (never a new Pool) — same commit/no-commit
// distinction established by cart.ts's withCartTransaction. Server-side
// lock_timeout/statement_timeout (not the client-side withTimeout helper) are
// this transaction's only timeout mechanism: withTimeout races a timer against
// a query it cannot cancel, which is exactly the ambiguous-write hazard
// TASK-011C already removed from createCart — here, with real writes (stock,
// orders, order_items) at stake, that hazard is worse, not better. A statement
// Postgres itself cancels leaves the transaction genuinely aborted (only
// ROLLBACK is subsequently accepted), so server-side timeouts carry none of
// that ambiguity. Both timeouts are reset to 0 before COMMIT specifically so
// the one step that already carries an unavoidable, fundamental ambiguity
// (network loss after COMMIT is sent, before its acknowledgement arrives —
// TASK-013's problem to close, not this helper's) is never made *more* likely
// by an artificial ceiling.
async function withOrderTransaction<T>(fn: (client: PoolClient) => Promise<TxOutcome<T>>): Promise<T> {
  const client = await postgresPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '2000ms'");
    await client.query("SET LOCAL statement_timeout = '5000ms'");
    const { commit, value } = await fn(client);
    if (commit) {
      await client.query("SET LOCAL statement_timeout = 0");
      await client.query("SET LOCAL lock_timeout = 0");
    }
    await client.query(commit ? "COMMIT" : "ROLLBACK");
    return value;
  } catch (error) {
    // Best-effort: never let a rollback failure mask the original error. If
    // Postgres itself cancelled a statement (server-side timeout), the
    // transaction is already aborted — ROLLBACK is the only accepted command.
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// Deterministic, purely textual — no hashing, no randomness, no city/payment/
// date. Same cart id + same cart version = same logical confirmation attempt
// (TASK-013 architecture decision): a real cart mutation always changes
// version (proven: every content-changing cart.ts mutation increments it,
// every true no-op does not), so a genuinely new order from otherwise
// identical articles requires a new cart or at least one cart mutation —
// never a second call against an unchanged cart, which is treated as the same
// confirmation, consistent with CLAUDE.md §20's enumerated failure modes
// (double-click, repeated message, network retry, graph retry) — none of
// which describe an intentionally repeated purchase.
function buildOrderIdempotencyKey(cartId: string, cartVersion: number): string {
  return `cart:${cartId}:v${cartVersion}`;
}

// Single source of truth for replay detection, reused by both the early check
// (before any business validation) and the ON CONFLICT fallback (after a
// same-key race on the final INSERT) — both call sites must apply IDENTICAL
// integrity/binding rules. Never consults delivery_zones/products/promotions:
// a replay returns only what was already durably committed.
async function loadExistingOrderReplay(
  client: PoolClient,
  idempotencyKey: string,
  city: string,
  paymentMethod: PaymentMethod,
  expectedConversationId: string,
  expectedCustomerId: string,
): Promise<ExistingOrderReplayResult> {
  const orderResult = await client.query<ExistingOrderRow>(
    `SELECT id, customer_id, conversation_id, status, products_total_cents, delivery_fee_cents, total_cents,
            city, payment_method, created_at,
            (lower(city) = lower($2)) AS city_matches
     FROM orders
     WHERE idempotency_key = $1`,
    [idempotencyKey, city],
  );
  if (orderResult.rows.length === 0) {
    return { found: false };
  }
  const row = orderResult.rows[0] as ExistingOrderRow;

  // Structurally impossible in normal operation: the key embeds the exact
  // cart id, and carts.conversation_id never changes after createCart. A
  // mismatch here is database integrity corruption, never ordinary caller
  // misuse — thrown, never modeled as idempotency_conflict.
  if (row.customer_id !== expectedCustomerId) {
    throw new Error("Integrity error: idempotent order customer does not match locked cart customer");
  }
  if (row.conversation_id !== expectedConversationId) {
    throw new Error("Integrity error: idempotent order conversation does not match locked cart conversation");
  }

  // Legitimate same-key, materially-different request: city compared via the
  // same lower(...) semantics as getDeliveryOptions (accents stay significant,
  // no unaccent, no JS locale case-folding) without ever consulting
  // delivery_zones again; paymentMethod via exact match (already
  // enum-canonicalized by PaymentMethodSchema, no case folding applicable).
  if (!row.city_matches || row.payment_method !== paymentMethod) {
    return { found: true, conflict: true };
  }

  const itemsResult = await client.query<ExistingOrderItemRow>(
    // product_ref, id: order_items deliberately has no UNIQUE(order_id,
    // product_ref) (design.md/migration comment), so id is the deterministic
    // tie-breaker even if duplicate refs somehow exist.
    `SELECT id, product_ref, quantity, unit_price_cents FROM order_items WHERE order_id = $1 ORDER BY product_ref, id`,
    [row.id],
  );

  // Stored facts only — never re-derived from current stock/pricing/delivery.
  // Throws (never silently repaired) if the stored data is malformed, e.g. no
  // items, out-of-schema money, or an unparsable created_at.
  const order = OrderSchema.parse({
    id: row.id,
    customerId: row.customer_id,
    conversationId: row.conversation_id,
    status: row.status,
    productsTotal: centimesToMad(row.products_total_cents),
    deliveryFee: centimesToMad(row.delivery_fee_cents),
    total: centimesToMad(row.total_cents),
    city: row.city,
    paymentMethod: row.payment_method,
    items: itemsResult.rows.map((item) => ({
      productRef: item.product_ref,
      quantity: item.quantity,
      unitPrice: centimesToMad(item.unit_price_cents),
    })),
    createdAt: row.created_at.toISOString(),
  });

  return { found: true, conflict: false, order };
}

export async function createOrder(
  rawCartId: unknown,
  rawConfirmed: unknown,
  rawCity: unknown,
  rawPaymentMethod: unknown,
  rawAsOfDate: unknown,
): Promise<CreateOrderResult> {
  const cartId = CartIdInputSchema.parse(rawCartId);
  const confirmed = ConfirmedInputSchema.parse(rawConfirmed);
  const city = DeliveryCityInputSchema.parse(rawCity);
  const paymentMethod = PaymentMethodSchema.parse(rawPaymentMethod);
  const asOfDate = IsoDateSchema.parse(rawAsOfDate);

  // A legitimate guardrail outcome, not input corruption: modeled as a
  // business result, before any DB connection, per HACK-CTRL (TASK-012B).
  if (!confirmed) {
    return { created: false, reason: "confirmation_required" };
  }

  return withOrderTransaction<CreateOrderResult>(async (client) => {
    // 1. Lock the cart row only (never the joined conversation row) and derive
    // customer/conversation/version from the DB relation — never accepted
    // from the caller. version drives the idempotency identity below.
    const cartLock = await client.query<CartLockRow>(
      `SELECT c.id, c.conversation_id, co.customer_id, c.version
       FROM carts c
       JOIN conversations co ON co.id = c.conversation_id
       WHERE c.id = $1
       FOR UPDATE OF c`,
      [cartId],
    );
    if (cartLock.rows.length === 0) {
      return { commit: false, value: { created: false, reason: "cart_not_found" } };
    }
    const {
      conversation_id: conversationId,
      customer_id: customerId,
      version: cartVersion,
    } = cartLock.rows[0] as CartLockRow;
    if (!Number.isInteger(cartVersion) || cartVersion < 0) {
      throw new Error(`Integrity error: locked cart "${cartId}" has an invalid version (${cartVersion})`);
    }

    // 1b. Idempotency replay check — BEFORE any business validation. A valid
    // replay or a binding conflict must never touch cart_items/products/
    // promotions/delivery_zones, never lock product rows, never decrement
    // stock: it only reports what a PRIOR transaction already committed.
    const idempotencyKey = buildOrderIdempotencyKey(cartId, cartVersion);
    const replay = await loadExistingOrderReplay(client, idempotencyKey, city, paymentMethod, conversationId, customerId);
    if (replay.found) {
      if (replay.conflict) {
        return { commit: false, value: { created: false, reason: "idempotency_conflict" } };
      }
      // No write occurred this transaction: ROLLBACK (not COMMIT) releases
      // the cart lock immediately and never exposes this read-only replay to
      // COMMIT-acknowledgement ambiguity.
      return { commit: false, value: { created: true, replayed: true, order: replay.order } };
    }

    // 2. Cart items, deterministic order. No status/version check or mutation:
    // no authoritative cart-status vocabulary exists (TASK-011A).
    const itemsResult = await client.query<CartItemRow>(
      `SELECT product_ref, quantity, unit_price_cents FROM cart_items WHERE cart_id = $1 ORDER BY product_ref`,
      [cartId],
    );
    if (itemsResult.rows.length === 0) {
      return { commit: false, value: { created: false, reason: "empty_cart" } };
    }
    const cartItems = itemsResult.rows;

    // 3. Lock every distinct product row in one deterministic-order statement
    // (defends against deadlocks with any other concurrent multi-item order).
    // Deduplicated defensively even though UNIQUE(cart_id, product_ref)
    // already makes duplicates within one cart impossible today.
    const distinctRefs = [...new Set(cartItems.map((item) => item.product_ref))].sort();
    const productLock = await client.query<ProductLockRow>(
      `SELECT ref, stock FROM products WHERE ref = ANY($1::text[]) ORDER BY ref FOR UPDATE`,
      [distinctRefs],
    );
    const stockByRef = new Map(productLock.rows.map((row) => [row.ref, row.stock]));
    const missingRef = distinctRefs.find((ref) => !stockByRef.has(ref));
    if (missingRef !== undefined) {
      return { commit: false, value: { created: false, reason: "product_not_found", productRef: missingRef } };
    }

    // 4. Authoritative price/stock revalidation — same client, no client-side
    // timeout (server-side statement_timeout already governs this transaction).
    // The cart's unit_price_cents is comparison-only here, never final authority.
    const priceChanges: PriceChange[] = [];
    const resolvedItems: ResolvedOrderItem[] = [];
    for (const item of cartItems) {
      const pricing = await getProductPricingContext(item.product_ref, asOfDate, {
        executor: client,
        useClientTimeout: false,
      });
      if (!pricing.found) {
        // Structurally unreachable given the product lock above already
        // proved this ref exists; kept as a defense-in-depth integrity guard.
        return { commit: false, value: { created: false, reason: "product_not_found", productRef: item.product_ref } };
      }
      const lockedStock = stockByRef.get(item.product_ref) as number;
      if (pricing.stock !== lockedStock) {
        throw new Error(
          `Integrity error: locked stock (${lockedStock}) for "${item.product_ref}" does not match pricing context stock (${pricing.stock})`,
        );
      }
      if (item.quantity > pricing.stock) {
        return {
          commit: false,
          value: {
            created: false,
            reason: "insufficient_stock",
            productRef: item.product_ref,
            requestedQuantity: item.quantity,
            availableStock: pricing.stock,
          },
        };
      }
      if (item.unit_price_cents !== pricing.effectivePriceCents) {
        priceChanges.push({
          productRef: item.product_ref,
          quantity: item.quantity,
          cartUnitPriceCents: item.unit_price_cents,
          currentUnitPriceCents: pricing.effectivePriceCents,
        });
      }
      resolvedItems.push({
        productRef: item.product_ref,
        quantity: item.quantity,
        effectivePriceCents: pricing.effectivePriceCents,
      });
    }
    if (priceChanges.length > 0) {
      // Explicit, guaranteed sort by raw productRef ascending (plain string
      // comparison, never localeCompare) — a deterministic output property in
      // its own right, not merely an incidental consequence of cartItems'
      // ORDER BY product_ref.
      priceChanges.sort((a, b) => (a.productRef < b.productRef ? -1 : a.productRef > b.productRef ? 1 : 0));
      // No cart write here: recovery is removeCartItem + addCartItem against
      // the CURRENT authoritative price, performed by the caller/orchestrator
      // between confirmations (TASK-012B §4-6) — never inside createOrder.
      return { commit: false, value: { created: false, reason: "price_changed", changes: priceChanges } };
    }

    // 5. Delivery revalidation — same client, no client-side timeout. Fee/COD/
    // delay/pickup always come from this result, never from the caller.
    const delivery = await getDeliveryOptions(city, { executor: client, useClientTimeout: false });
    if (!delivery.found) {
      return { commit: false, value: { created: false, reason: "delivery_not_found", city } };
    }

    // 6. Payment / COD interaction — the only sourced restriction; no rule
    // invented for bank_transfer/card.
    if (paymentMethod === "cash_on_delivery" && !delivery.zone.cashOnDelivery) {
      return {
        commit: false,
        value: { created: false, reason: "payment_not_allowed_for_delivery_zone", city, paymentMethod },
      };
    }

    // 7. Totals — integer cents only, PostgreSQL INTEGER-bounded.
    let productsTotalCents = 0;
    for (const item of resolvedItems) {
      assertPostgresIntegerRange(item.quantity, `quantity for "${item.productRef}"`);
      assertPostgresIntegerRange(item.effectivePriceCents, `effectivePriceCents for "${item.productRef}"`);
      const lineTotalCents = item.quantity * item.effectivePriceCents;
      assertPostgresIntegerRange(lineTotalCents, `lineTotalCents for "${item.productRef}"`);
      productsTotalCents += lineTotalCents;
    }
    assertPostgresIntegerRange(productsTotalCents, "productsTotalCents");
    const deliveryFeeCents = delivery.feeCents;
    assertPostgresIntegerRange(deliveryFeeCents, "deliveryFeeCents");
    const totalCents = productsTotalCents + deliveryFeeCents;
    assertPostgresIntegerRange(totalCents, "totalCents");

    // 8. Insert the order using the SAME deterministic key derived in step 1b.
    // ON CONFLICT (idempotency_key) DO NOTHING is defense-in-depth for a
    // same-cart/same-version race: the cart FOR UPDATE lock already serializes
    // any two calls that could ever derive this exact key (it embeds cartId),
    // so this branch is expected to be unreachable in practice — see fallback
    // below for the (structurally near-impossible) case where it still fires.
    // No second SELECT on the success path — RETURNING supplies everything
    // needed to build the final Order.
    const orderInsert = await client.query<CreatedOrderRow>(
      `INSERT INTO orders (customer_id, conversation_id, status, products_total_cents, delivery_fee_cents, total_cents, city, payment_method, idempotency_key)
       VALUES ($1, $2, 'confirmed', $3, $4, $5, $6, $7, $8)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id, customer_id, conversation_id, status, products_total_cents, delivery_fee_cents, total_cents, city, payment_method, created_at`,
      [
        customerId,
        conversationId,
        productsTotalCents,
        deliveryFeeCents,
        totalCents,
        delivery.zone.city,
        paymentMethod,
        idempotencyKey,
      ],
    );
    if (orderInsert.rows.length === 0) {
      // Lost a same-key race: no order/order-item/stock write has happened
      // yet in THIS transaction (this INSERT was the first write attempted),
      // so falling back to a read-only replay here is exactly as safe as the
      // early check — same helper, identical binding/integrity semantics.
      const fallback = await loadExistingOrderReplay(client, idempotencyKey, city, paymentMethod, conversationId, customerId);
      if (!fallback.found) {
        throw new Error(
          `Integrity error: order INSERT reported a conflict for idempotency key "${idempotencyKey}" but no matching order could be loaded`,
        );
      }
      if (fallback.conflict) {
        return { commit: false, value: { created: false, reason: "idempotency_conflict" } };
      }
      return { commit: false, value: { created: true, replayed: true, order: fallback.order } };
    }
    const orderRow = orderInsert.rows[0] as CreatedOrderRow;

    // 9. Order items, sequentially — item count is small; correctness and
    // readability outweigh the negligible round-trip cost of a loop here.
    // unit_price_cents is always the CURRENT authoritative price, never the
    // stale cart snapshot (guaranteed equal at this point, since any mismatch
    // already returned price_changed above).
    for (const item of resolvedItems) {
      await client.query(
        `INSERT INTO order_items (order_id, product_ref, quantity, unit_price_cents) VALUES ($1, $2, $3, $4)`,
        [orderRow.id, item.productRef, item.quantity, item.effectivePriceCents],
      );
    }

    // 10. Stock decrement last — reads as a consequence of the order now
    // existing. `stock >= $2` is structurally redundant given the lock and
    // prior validation, kept as defense-in-depth; 0 rows affected is an
    // integrity error, never remapped to insufficient_stock.
    for (const item of resolvedItems) {
      const decremented = await client.query<{ stock: number }>(
        `UPDATE products SET stock = stock - $2 WHERE ref = $1 AND stock >= $2 RETURNING stock`,
        [item.productRef, item.quantity],
      );
      if (decremented.rows.length === 0) {
        throw new Error(
          `Integrity error: stock decrement for "${item.productRef}" affected 0 rows despite prior lock and validation`,
        );
      }
    }

    // 11. Build and validate the final Order BEFORE COMMIT (HACK-CTRL,
    // TASK-012B §25): if mapping/schema validation fails, it fails inside this
    // callback, the transaction rolls back, and no order survives. Nothing
    // after this point (back in withOrderTransaction) can throw before
    // returning the already-validated object.
    const validatedOrder = OrderSchema.parse({
      id: orderRow.id,
      customerId: orderRow.customer_id,
      conversationId: orderRow.conversation_id,
      status: orderRow.status,
      productsTotal: centimesToMad(orderRow.products_total_cents),
      deliveryFee: centimesToMad(orderRow.delivery_fee_cents),
      total: centimesToMad(orderRow.total_cents),
      city: orderRow.city,
      paymentMethod: orderRow.payment_method,
      items: resolvedItems.map((item) => ({
        productRef: item.productRef,
        quantity: item.quantity,
        unitPrice: centimesToMad(item.effectivePriceCents),
      })),
      createdAt: orderRow.created_at.toISOString(),
    });

    return { commit: true, value: { created: true, replayed: false, order: validatedOrder } };
  });
}
