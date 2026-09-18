import { Pool, PoolClient } from "pg";
import { z } from "zod";
import { Cart, CartSchema, IsoDateSchema } from "@m3ak/shared";
import { centimesToMad } from "../infrastructure/money";
import { postgresPool } from "../infrastructure/postgres";
import { withTimeout } from "../infrastructure/timeout";
import { getProductPricingContext } from "../catalogue/promotions";
import { ProductRefInputSchema } from "../catalogue/schemas";

const CART_QUERY_TIMEOUT_MS = 3_000;

const CartIdInputSchema = z.string().trim().uuid();
const ConversationIdInputSchema = z.string().trim().uuid();
const QuantityInputSchema = z.number().int().positive();

// Accepts either the shared pool or a single checked-out transaction client:
// read-only getCart/calculateCartTotal use the pool directly, mutating
// functions load the final Cart through the same client that ran their
// transaction, before COMMIT (Pool and PoolClient expose the same query shape).
type Queryable = Pool | PoolClient;

interface CartRow {
  cart_id: string;
  conversation_id: string;
  status: string;
  version: number;
  product_ref: string | null;
  quantity: number | null;
  unit_price_cents: number | null;
}

function mapRowsToCart(rows: CartRow[]): Cart {
  const [first] = rows;
  if (!first) {
    throw new Error("mapRowsToCart: expected at least one row");
  }
  const items = rows
    .filter((row): row is CartRow & { product_ref: string; quantity: number; unit_price_cents: number } =>
      row.product_ref !== null,
    )
    .map((row) => ({
      productRef: row.product_ref,
      quantity: row.quantity,
      unitPrice: centimesToMad(row.unit_price_cents),
    }));

  return CartSchema.parse({
    id: first.cart_id,
    conversationId: first.conversation_id,
    status: first.status,
    version: first.version,
    items,
  });
}

// One statement, one snapshot: cart metadata and its items (via LEFT JOIN) are
// read together so they can never observe two different points in time. An
// empty cart still yields exactly one row with every ci.* column NULL.
async function loadCart(executor: Queryable, cartId: string): Promise<Cart | null> {
  const { rows } = await withTimeout(
    executor.query<CartRow>(
      `SELECT c.id AS cart_id, c.conversation_id, c.status, c.version,
              ci.product_ref, ci.quantity, ci.unit_price_cents
       FROM carts c
       LEFT JOIN cart_items ci ON ci.cart_id = c.id
       WHERE c.id = $1
       ORDER BY ci.created_at, ci.id`,
      [cartId],
    ),
    CART_QUERY_TIMEOUT_MS,
    "loadCart",
  );
  if (rows.length === 0) {
    return null;
  }
  return mapRowsToCart(rows);
}

interface TxOutcome<T> {
  commit: boolean;
  value: T;
}

// Every cart mutation is one BEGIN..COMMIT/ROLLBACK unit of work on a single
// checked-out client from the existing shared pool (never a new Pool). `commit`
// lets the callback distinguish an ordinary business outcome (cart_not_found,
// insufficient_stock, ...) — which still rolls back even though nothing threw —
// from a genuine successful mutation, which commits.
async function withCartTransaction<T>(fn: (client: PoolClient) => Promise<TxOutcome<T>>): Promise<T> {
  const client = await postgresPool.connect();
  try {
    await client.query("BEGIN");
    const { commit, value } = await fn(client);
    await client.query(commit ? "COMMIT" : "ROLLBACK");
    return value;
  } catch (error) {
    // Best-effort: never let a rollback failure mask the original mutation error.
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export type CreateCartResult =
  | { created: true; cart: Cart }
  | { created: false; conversationId: string; reason: "conversation_not_found" };

interface CreatedCartRow {
  id: string;
  conversation_id: string;
  status: string;
  version: number;
}

export async function createCart(rawConversationId: unknown): Promise<CreateCartResult> {
  const conversationId = ConversationIdInputSchema.parse(rawConversationId);

  // Single atomic statement, no follow-up query: the SELECT ... WHERE id = $1
  // both is the existence check and supplies the FK value (zero inserted rows
  // rather than a raw FK-violation error for an unknown conversation), and
  // RETURNING supplies everything needed to build the Cart directly. A prior
  // version called loadCart() after this INSERT — if that second query failed,
  // createCart rejected even though the cart had already been durably
  // committed, and since the schema permits multiple carts per conversation, a
  // caller retry after such a failure could silently accumulate extra carts.
  //
  // Deliberately NOT wrapped in withTimeout: that helper races a timer against
  // the query but never cancels the underlying PostgreSQL statement, so on a
  // client-side timeout this INSERT could still commit after createCart had
  // already rejected — the exact same ambiguous-write hazard as the two-query
  // version above, just moved into the timeout path instead of the follow-up
  // query. Awaiting the write directly means createCart's outcome always
  // matches whether this INSERT actually committed.
  const { rows } = await postgresPool.query<CreatedCartRow>(
    `INSERT INTO carts (conversation_id, status)
     SELECT id, 'active' FROM conversations WHERE id = $1
     RETURNING id, conversation_id, status, version`,
    [conversationId],
  );

  if (rows.length === 0) {
    return { created: false, conversationId, reason: "conversation_not_found" };
  }
  if (rows.length > 1) {
    // conversations.id is the INSERT's own SELECT source and is a primary key,
    // so this cannot happen in practice — fail loudly rather than silently
    // picking one, matching the integrity-guard convention used elsewhere.
    throw new Error(
      `Integrity error: INSERT INTO carts returned ${rows.length} rows for conversation "${conversationId}" (expected exactly 1)`,
    );
  }

  const row = rows[0] as CreatedCartRow;
  const cart = CartSchema.parse({
    id: row.id,
    conversationId: row.conversation_id,
    status: row.status,
    version: row.version,
    items: [],
  });
  return { created: true, cart };
}

export type GetCartResult = { found: true; cart: Cart } | { found: false; cartId: string; reason: "cart_not_found" };

export async function getCart(rawCartId: unknown): Promise<GetCartResult> {
  const cartId = CartIdInputSchema.parse(rawCartId);
  const cart = await loadCart(postgresPool, cartId);
  if (!cart) {
    return { found: false, cartId, reason: "cart_not_found" };
  }
  return { found: true, cart };
}

export type AddCartItemResult =
  | { ok: true; cart: Cart }
  | { ok: false; reason: "cart_not_found" }
  | { ok: false; reason: "product_not_found" }
  | { ok: false; reason: "insufficient_stock"; requestedQuantity: number; availableStock: number };

export async function addCartItem(
  rawCartId: unknown,
  rawProductRef: unknown,
  rawQuantity: unknown,
  rawAsOfDate: unknown,
): Promise<AddCartItemResult> {
  const cartId = CartIdInputSchema.parse(rawCartId);
  const productRef = ProductRefInputSchema.parse(rawProductRef);
  const requestedAdditionalQuantity = QuantityInputSchema.parse(rawQuantity);
  const asOfDate = IsoDateSchema.parse(rawAsOfDate);

  return withCartTransaction<AddCartItemResult>(async (client) => {
    const cartLock = await withTimeout(
      client.query("SELECT id FROM carts WHERE id = $1 FOR UPDATE", [cartId]),
      CART_QUERY_TIMEOUT_MS,
      "addCartItem:lockCart",
    );
    if (cartLock.rows.length === 0) {
      return { commit: false, value: { ok: false, reason: "cart_not_found" } };
    }

    // Never caller-supplied: the only source of truth for price and stock.
    const pricing = await getProductPricingContext(productRef, asOfDate);
    if (!pricing.found) {
      return { commit: false, value: { ok: false, reason: "product_not_found" } };
    }

    // No FOR UPDATE needed here: the carts row lock above already serializes
    // every concurrent mutation targeting this same cart_id.
    const existingItem = await withTimeout(
      client.query<{ quantity: number }>("SELECT quantity FROM cart_items WHERE cart_id = $1 AND product_ref = $2", [
        cartId,
        productRef,
      ]),
      CART_QUERY_TIMEOUT_MS,
      "addCartItem:selectItem",
    );
    const existingQuantity = existingItem.rows[0]?.quantity ?? 0;
    const newQuantity = existingQuantity + requestedAdditionalQuantity;

    if (newQuantity > pricing.stock) {
      return {
        commit: false,
        value: { ok: false, reason: "insufficient_stock", requestedQuantity: newQuantity, availableStock: pricing.stock },
      };
    }

    // newQuantity is the final, already-accumulated total: both branches of
    // the upsert assign it directly (never `quantity + EXCLUDED.quantity`,
    // which would double-count on top of this precomputed sum).
    await withTimeout(
      client.query(
        `INSERT INTO cart_items (cart_id, product_ref, quantity, unit_price_cents)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (cart_id, product_ref)
         DO UPDATE SET quantity = $3, unit_price_cents = $4, updated_at = now()`,
        [cartId, productRef, newQuantity, pricing.effectivePriceCents],
      ),
      CART_QUERY_TIMEOUT_MS,
      "addCartItem:upsertItem",
    );
    await withTimeout(
      client.query("UPDATE carts SET version = version + 1, updated_at = now() WHERE id = $1", [cartId]),
      CART_QUERY_TIMEOUT_MS,
      "addCartItem:bumpVersion",
    );

    const cart = await loadCart(client, cartId);
    if (!cart) {
      throw new Error(`Integrity error: cart "${cartId}" disappeared mid-transaction`);
    }
    return { commit: true, value: { ok: true, cart } };
  });
}

export type UpdateCartItemResult =
  | { ok: true; cart: Cart }
  | { ok: false; reason: "cart_not_found" }
  | { ok: false; reason: "item_not_in_cart" }
  | { ok: false; reason: "insufficient_stock"; requestedQuantity: number; availableStock: number };

export async function updateCartItem(
  rawCartId: unknown,
  rawProductRef: unknown,
  rawQuantity: unknown,
): Promise<UpdateCartItemResult> {
  const cartId = CartIdInputSchema.parse(rawCartId);
  const productRef = ProductRefInputSchema.parse(rawProductRef);
  const requestedQuantity = QuantityInputSchema.parse(rawQuantity);

  return withCartTransaction<UpdateCartItemResult>(async (client) => {
    const cartLock = await withTimeout(
      client.query("SELECT id FROM carts WHERE id = $1 FOR UPDATE", [cartId]),
      CART_QUERY_TIMEOUT_MS,
      "updateCartItem:lockCart",
    );
    if (cartLock.rows.length === 0) {
      return { commit: false, value: { ok: false, reason: "cart_not_found" } };
    }

    const existingItem = await withTimeout(
      client.query<{ quantity: number }>("SELECT quantity FROM cart_items WHERE cart_id = $1 AND product_ref = $2", [
        cartId,
        productRef,
      ]),
      CART_QUERY_TIMEOUT_MS,
      "updateCartItem:selectItem",
    );
    if (existingItem.rows.length === 0) {
      return { commit: false, value: { ok: false, reason: "item_not_in_cart" } };
    }
    const existingQuantity = (existingItem.rows[0] as { quantity: number }).quantity;

    // Stock-only re-check, no repricing (TASK-011A §15): the existing
    // unit_price_cents snapshot is preserved untouched by this function.
    const availability = await withTimeout(
      client.query<{ stock: number }>("SELECT stock FROM products WHERE ref = $1", [productRef]),
      CART_QUERY_TIMEOUT_MS,
      "updateCartItem:stock",
    );
    const stock = (availability.rows[0] as { stock: number } | undefined)?.stock ?? 0;

    if (requestedQuantity > stock) {
      return {
        commit: false,
        value: { ok: false, reason: "insufficient_stock", requestedQuantity, availableStock: stock },
      };
    }

    if (requestedQuantity === existingQuantity) {
      const cart = await loadCart(client, cartId);
      if (!cart) {
        throw new Error(`Integrity error: cart "${cartId}" disappeared mid-transaction`);
      }
      return { commit: true, value: { ok: true, cart } };
    }

    await withTimeout(
      client.query("UPDATE cart_items SET quantity = $3, updated_at = now() WHERE cart_id = $1 AND product_ref = $2", [
        cartId,
        productRef,
        requestedQuantity,
      ]),
      CART_QUERY_TIMEOUT_MS,
      "updateCartItem:update",
    );
    await withTimeout(
      client.query("UPDATE carts SET version = version + 1, updated_at = now() WHERE id = $1", [cartId]),
      CART_QUERY_TIMEOUT_MS,
      "updateCartItem:bumpVersion",
    );

    const cart = await loadCart(client, cartId);
    if (!cart) {
      throw new Error(`Integrity error: cart "${cartId}" disappeared mid-transaction`);
    }
    return { commit: true, value: { ok: true, cart } };
  });
}

export type RemoveCartItemResult =
  | { removed: true; cart: Cart }
  | { removed: false; reason: "cart_not_found" }
  | { removed: false; reason: "item_not_in_cart" };

export async function removeCartItem(rawCartId: unknown, rawProductRef: unknown): Promise<RemoveCartItemResult> {
  const cartId = CartIdInputSchema.parse(rawCartId);
  const productRef = ProductRefInputSchema.parse(rawProductRef);

  return withCartTransaction<RemoveCartItemResult>(async (client) => {
    const cartLock = await withTimeout(
      client.query("SELECT id FROM carts WHERE id = $1 FOR UPDATE", [cartId]),
      CART_QUERY_TIMEOUT_MS,
      "removeCartItem:lockCart",
    );
    if (cartLock.rows.length === 0) {
      return { commit: false, value: { removed: false, reason: "cart_not_found" } };
    }

    const deleted = await withTimeout(
      client.query("DELETE FROM cart_items WHERE cart_id = $1 AND product_ref = $2 RETURNING id", [
        cartId,
        productRef,
      ]),
      CART_QUERY_TIMEOUT_MS,
      "removeCartItem:delete",
    );
    if (deleted.rows.length === 0) {
      return { commit: false, value: { removed: false, reason: "item_not_in_cart" } };
    }

    await withTimeout(
      client.query("UPDATE carts SET version = version + 1, updated_at = now() WHERE id = $1", [cartId]),
      CART_QUERY_TIMEOUT_MS,
      "removeCartItem:bumpVersion",
    );

    const cart = await loadCart(client, cartId);
    if (!cart) {
      throw new Error(`Integrity error: cart "${cartId}" disappeared mid-transaction`);
    }
    return { commit: true, value: { removed: true, cart } };
  });
}

export type CalculateCartTotalResult =
  | { found: true; totalCents: number; total: number }
  | { found: false; cartId: string; reason: "cart_not_found" };

export async function calculateCartTotal(rawCartId: unknown): Promise<CalculateCartTotalResult> {
  const cartId = CartIdInputSchema.parse(rawCartId);

  const { rows } = await withTimeout(
    postgresPool.query<{ id: string; total_cents: string }>(
      `SELECT c.id,
              COALESCE(SUM(ci.quantity::bigint * ci.unit_price_cents::bigint), 0)::text AS total_cents
       FROM carts c
       LEFT JOIN cart_items ci ON ci.cart_id = c.id
       WHERE c.id = $1
       GROUP BY c.id`,
      [cartId],
    ),
    CART_QUERY_TIMEOUT_MS,
    "calculateCartTotal",
  );

  if (rows.length === 0) {
    return { found: false, cartId, reason: "cart_not_found" };
  }

  // pg returns bigint/numeric aggregates as strings specifically to avoid
  // silent precision loss; BigInt(...) here, never Number(...) directly.
  const totalCentsBigInt = BigInt((rows[0] as { total_cents: string }).total_cents);
  if (totalCentsBigInt < 0n || totalCentsBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(
      `Integrity error: cart "${cartId}" total_cents (${totalCentsBigInt.toString()}) is outside the safe integer range`,
    );
  }
  const totalCents = Number(totalCentsBigInt);

  return { found: true, totalCents, total: centimesToMad(totalCents) };
}
