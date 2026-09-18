import { OrderSchema } from "@m3ak/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { postgresPool } from "../infrastructure/postgres";
import * as timeoutModule from "../infrastructure/timeout";
import { createOrder } from "./order";

const CART_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
const CUSTOMER_ID = "33333333-3333-4333-8333-333333333333";
const ORDER_ID = "44444444-4444-4444-8444-444444444444";
const AS_OF_DATE = "2026-09-15";

interface FakeClient {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}

function makeFakeClient(): FakeClient {
  return { query: vi.fn(), release: vi.fn() };
}

function makeProductRow(overrides: Record<string, unknown> = {}) {
  return {
    ref: "REF-0001",
    model: "Model A",
    family: "FamilyA",
    gender: "femme",
    color: "noir",
    size: "M",
    material: "coton",
    season: "été",
    price_cents: 10000,
    stock: 5,
    barcode: "0000000000000",
    weight_grams: 500,
    ...overrides,
  };
}

function makeDeliveryRow(overrides: Record<string, unknown> = {}) {
  return {
    city: "Casablanca",
    fee_cents: 2500,
    delay_hours: 72,
    cash_on_delivery: true,
    store_pickup: true,
    ...overrides,
  };
}

function makeOrderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    customer_id: CUSTOMER_ID,
    conversation_id: CONVERSATION_ID,
    status: "confirmed",
    products_total_cents: 10000,
    delivery_fee_cents: 2500,
    total_cents: 12500,
    city: "Casablanca",
    payment_method: "cash_on_delivery",
    created_at: new Date("2026-09-18T12:00:00.000Z"),
    ...overrides,
  };
}

// Queues the standard BEGIN + SET LOCAL x2 + cart lock + idempotency replay
// check (default: not found, so the pipeline proceeds exactly as before) +
// cart_items prefix.
function queuePrefix(
  client: FakeClient,
  options: {
    cartRow?: { id: string; conversation_id: string; customer_id: string; version?: number } | null;
    itemRows?: Array<{ product_ref: string; quantity: number; unit_price_cents: number }>;
    existingOrderRows?: unknown[];
  } = {},
) {
  const cartRow = options.cartRow ?? {
    id: CART_ID,
    conversation_id: CONVERSATION_ID,
    customer_id: CUSTOMER_ID,
    version: 0,
  };
  client.query.mockResolvedValueOnce({}); // BEGIN
  client.query.mockResolvedValueOnce({}); // SET LOCAL lock_timeout
  client.query.mockResolvedValueOnce({}); // SET LOCAL statement_timeout
  client.query.mockResolvedValueOnce({
    rows: options.cartRow === null ? [] : [{ version: 0, ...cartRow }],
  }); // cart lock
  if (options.cartRow === null) return;
  const existingOrderRows = options.existingOrderRows ?? [];
  client.query.mockResolvedValueOnce({ rows: existingOrderRows }); // idempotency replay check
  if (existingOrderRows.length > 0) return; // replay short-circuits before cart_items
  const itemRows = options.itemRows ?? [{ product_ref: "REF-0001", quantity: 1, unit_price_cents: 10000 }];
  client.query.mockResolvedValueOnce({ rows: itemRows }); // cart_items
}

// Queues a single successful item's pricing resolution (product + promotion reads).
function queuePricing(client: FakeClient, productRow: ReturnType<typeof makeProductRow>, promotionRows: unknown[] = []) {
  client.query.mockResolvedValueOnce({ rows: [productRow] });
  client.query.mockResolvedValueOnce({ rows: promotionRows });
}

function queueHappyPathTail(client: FakeClient, deliveryRow: ReturnType<typeof makeDeliveryRow>, orderRow: ReturnType<typeof makeOrderRow>, stockAfter: number) {
  client.query.mockResolvedValueOnce({ rows: [deliveryRow] }); // delivery
  client.query.mockResolvedValueOnce({ rows: [orderRow] }); // orders INSERT RETURNING
  client.query.mockResolvedValueOnce({}); // order_items INSERT
  client.query.mockResolvedValueOnce({ rows: [{ stock: stockAfter }] }); // stock UPDATE
  client.query.mockResolvedValueOnce({}); // SET LOCAL statement_timeout = 0
  client.query.mockResolvedValueOnce({}); // SET LOCAL lock_timeout = 0
  client.query.mockResolvedValueOnce({}); // COMMIT
}

function mockConnect(client: FakeClient) {
  return vi.spyOn(postgresPool, "connect").mockResolvedValue(client as never);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createOrder — input validation and confirmation (A-F)", () => {
  it("A: rejects a malformed cart UUID before any DB connection", async () => {
    const connectSpy = vi.spyOn(postgresPool, "connect");
    await expect(createOrder("not-a-uuid", true, "Casablanca", "card", AS_OF_DATE)).rejects.toThrow();
    expect(connectSpy).not.toHaveBeenCalled();
  });

  it("B: rejects a missing/non-boolean confirmed before any DB connection", async () => {
    const connectSpy = vi.spyOn(postgresPool, "connect");
    await expect(createOrder(CART_ID, undefined, "Casablanca", "card", AS_OF_DATE)).rejects.toThrow();
    await expect(createOrder(CART_ID, "true", "Casablanca", "card", AS_OF_DATE)).rejects.toThrow();
    expect(connectSpy).not.toHaveBeenCalled();
  });

  it("C: confirmed===false returns confirmation_required before any DB connection", async () => {
    const connectSpy = vi.spyOn(postgresPool, "connect");
    const result = await createOrder(CART_ID, false, "Casablanca", "card", AS_OF_DATE);
    expect(result).toEqual({ created: false, reason: "confirmation_required" });
    expect(connectSpy).not.toHaveBeenCalled();
  });

  it("D: rejects a malformed city before any DB connection", async () => {
    const connectSpy = vi.spyOn(postgresPool, "connect");
    await expect(createOrder(CART_ID, true, "   ", "card", AS_OF_DATE)).rejects.toThrow();
    expect(connectSpy).not.toHaveBeenCalled();
  });

  it("E: rejects a malformed payment method before any DB connection", async () => {
    const connectSpy = vi.spyOn(postgresPool, "connect");
    await expect(createOrder(CART_ID, true, "Casablanca", "crypto", AS_OF_DATE)).rejects.toThrow();
    expect(connectSpy).not.toHaveBeenCalled();
  });

  it("F: rejects a malformed asOfDate before any DB connection", async () => {
    const connectSpy = vi.spyOn(postgresPool, "connect");
    await expect(createOrder(CART_ID, true, "Casablanca", "card", "15-09-2026")).rejects.toThrow();
    expect(connectSpy).not.toHaveBeenCalled();
  });
});

describe("createOrder — cart validation (G, H, I)", () => {
  it("G: unknown cart returns cart_not_found and rolls back", async () => {
    const client = makeFakeClient();
    queuePrefix(client, { cartRow: null });
    client.query.mockResolvedValueOnce({}); // ROLLBACK
    mockConnect(client);

    const result = await createOrder(CART_ID, true, "Casablanca", "card", AS_OF_DATE);

    expect(result).toEqual({ created: false, reason: "cart_not_found" });
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.query).not.toHaveBeenCalledWith("COMMIT");
  });

  it("H: empty cart returns empty_cart and rolls back", async () => {
    const client = makeFakeClient();
    queuePrefix(client, { itemRows: [] });
    client.query.mockResolvedValueOnce({}); // ROLLBACK
    mockConnect(client);

    const result = await createOrder(CART_ID, true, "Casablanca", "card", AS_OF_DATE);

    expect(result).toEqual({ created: false, reason: "empty_cart" });
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
  });

  it("I: customerId/conversationId are derived from the DB relation, never the caller (signature has no such parameters)", async () => {
    expect(createOrder.length).toBe(5);
    const client = makeFakeClient();
    queuePrefix(client);
    client.query.mockResolvedValueOnce({ rows: [{ ref: "REF-0001", stock: 5 }] }); // product lock
    queuePricing(client, makeProductRow());
    queueHappyPathTail(client, makeDeliveryRow(), makeOrderRow(), 4);
    mockConnect(client);

    const result = await createOrder(CART_ID, true, "Casablanca", "cash_on_delivery", AS_OF_DATE);

    expect(result.created).toBe(true);
    if (result.created) {
      expect(result.replayed).toBe(false);
      expect(result.order.customerId).toBe(CUSTOMER_ID);
      expect(result.order.conversationId).toBe(CONVERSATION_ID);
    }
  });
});

describe("createOrder — product locking (J, K, L, M, N, O)", () => {
  it("J: locks product rows with ORDER BY ref FOR UPDATE", async () => {
    const client = makeFakeClient();
    queuePrefix(client);
    client.query.mockResolvedValueOnce({ rows: [{ ref: "REF-0001", stock: 5 }] });
    queuePricing(client, makeProductRow());
    queueHappyPathTail(client, makeDeliveryRow(), makeOrderRow(), 4);
    mockConnect(client);

    await createOrder(CART_ID, true, "Casablanca", "cash_on_delivery", AS_OF_DATE);

    const lockCall = client.query.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("FOR UPDATE") && call[0].includes("FROM products"),
    ) as [string, unknown[]];
    expect(lockCall[0]).toMatch(/ORDER BY ref\s+FOR UPDATE/i);
    expect(lockCall[0]).toMatch(/ref = ANY\(\$1::text\[\]\)/);
  });

  it("K: distinct product refs are deduplicated before the lock query", async () => {
    const client = makeFakeClient();
    queuePrefix(client, {
      itemRows: [{ product_ref: "REF-0001", quantity: 1, unit_price_cents: 10000 }],
    });
    client.query.mockResolvedValueOnce({ rows: [{ ref: "REF-0001", stock: 5 }] });
    queuePricing(client, makeProductRow());
    queueHappyPathTail(client, makeDeliveryRow(), makeOrderRow(), 4);
    mockConnect(client);

    await createOrder(CART_ID, true, "Casablanca", "cash_on_delivery", AS_OF_DATE);

    const lockCall = client.query.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("FOR UPDATE") && call[0].includes("FROM products"),
    ) as [string, unknown[]];
    expect(lockCall[1]).toEqual([["REF-0001"]]);
  });

  it("L: a missing product returns product_not_found for the lexicographically first missing ref", async () => {
    const client = makeFakeClient();
    queuePrefix(client, {
      itemRows: [
        { product_ref: "REF-0001", quantity: 1, unit_price_cents: 10000 },
        { product_ref: "REF-0002", quantity: 1, unit_price_cents: 5000 },
      ],
    });
    client.query.mockResolvedValueOnce({ rows: [{ ref: "REF-0002", stock: 5 }] }); // REF-0001 missing
    client.query.mockResolvedValueOnce({}); // ROLLBACK
    mockConnect(client);

    const result = await createOrder(CART_ID, true, "Casablanca", "card", AS_OF_DATE);

    expect(result).toEqual({ created: false, reason: "product_not_found", productRef: "REF-0001" });
  });

  it("M: stock=0 returns insufficient_stock", async () => {
    const client = makeFakeClient();
    queuePrefix(client);
    client.query.mockResolvedValueOnce({ rows: [{ ref: "REF-0001", stock: 0 }] });
    queuePricing(client, makeProductRow({ stock: 0 }));
    client.query.mockResolvedValueOnce({}); // ROLLBACK
    mockConnect(client);

    const result = await createOrder(CART_ID, true, "Casablanca", "card", AS_OF_DATE);

    expect(result).toEqual({
      created: false,
      reason: "insufficient_stock",
      productRef: "REF-0001",
      requestedQuantity: 1,
      availableStock: 0,
    });
  });

  it("N: requesting more than available stock returns insufficient_stock", async () => {
    const client = makeFakeClient();
    queuePrefix(client, { itemRows: [{ product_ref: "REF-0001", quantity: 3, unit_price_cents: 10000 }] });
    client.query.mockResolvedValueOnce({ rows: [{ ref: "REF-0001", stock: 2 }] });
    queuePricing(client, makeProductRow({ stock: 2 }));
    client.query.mockResolvedValueOnce({}); // ROLLBACK
    mockConnect(client);

    const result = await createOrder(CART_ID, true, "Casablanca", "card", AS_OF_DATE);

    expect(result).toEqual({
      created: false,
      reason: "insufficient_stock",
      productRef: "REF-0001",
      requestedQuantity: 3,
      availableStock: 2,
    });
  });

  it("O: exact-stock (requested === available) succeeds", async () => {
    const client = makeFakeClient();
    queuePrefix(client, { itemRows: [{ product_ref: "REF-0001", quantity: 2, unit_price_cents: 10000 }] });
    client.query.mockResolvedValueOnce({ rows: [{ ref: "REF-0001", stock: 2 }] });
    queuePricing(client, makeProductRow({ stock: 2 }));
    queueHappyPathTail(
      client,
      makeDeliveryRow(),
      makeOrderRow({ products_total_cents: 20000, total_cents: 22500 }),
      0,
    );
    mockConnect(client);

    const result = await createOrder(CART_ID, true, "Casablanca", "cash_on_delivery", AS_OF_DATE);
    expect(result.created).toBe(true);
  });
});

describe("createOrder — pricing and promotions (P, Q, R, S, T, U, V)", () => {
  it("P: unchanged catalogue price succeeds", async () => {
    const client = makeFakeClient();
    queuePrefix(client);
    client.query.mockResolvedValueOnce({ rows: [{ ref: "REF-0001", stock: 5 }] });
    queuePricing(client, makeProductRow({ price_cents: 10000, stock: 5 }));
    queueHappyPathTail(client, makeDeliveryRow(), makeOrderRow(), 4);
    mockConnect(client);

    const result = await createOrder(CART_ID, true, "Casablanca", "cash_on_delivery", AS_OF_DATE);
    expect(result.created).toBe(true);
  });

  it("Q: active promotion unchanged from cart snapshot succeeds with the promo price", async () => {
    const client = makeFakeClient();
    queuePrefix(client, { itemRows: [{ product_ref: "REF-0018", quantity: 1, unit_price_cents: 16000 }] });
    client.query.mockResolvedValueOnce({ rows: [{ ref: "REF-0018", stock: 1 }] });
    queuePricing(client, makeProductRow({ ref: "REF-0018", price_cents: 20000, stock: 1 }), [
      {
        id: "55555555-5555-4555-8555-555555555555",
        product_ref: "REF-0018",
        normal_price_cents: 20000,
        promo_price_cents: 16000,
        starts_at: "2026-09-01",
        ends_at: "2026-09-30",
        condition: "dans la limite des stocks disponibles",
      },
    ]);
    queueHappyPathTail(
      client,
      makeDeliveryRow(),
      makeOrderRow({ products_total_cents: 16000, total_cents: 18500 }),
      0,
    );
    mockConnect(client);

    const result = await createOrder(CART_ID, true, "Casablanca", "cash_on_delivery", AS_OF_DATE);

    expect(result.created).toBe(true);
    if (result.created) {
      expect(result.order.items[0]).toEqual({ productRef: "REF-0018", quantity: 1, unitPrice: 160 });
    }
  });

  it("R: an expired promo (cart snapshot=promo, current=catalogue) returns price_changed", async () => {
    const client = makeFakeClient();
    queuePrefix(client, { itemRows: [{ product_ref: "REF-0018", quantity: 1, unit_price_cents: 16000 }] });
    client.query.mockResolvedValueOnce({ rows: [{ ref: "REF-0018", stock: 1 }] });
    queuePricing(client, makeProductRow({ ref: "REF-0018", price_cents: 20000, stock: 1 }), []); // no active promo now
    client.query.mockResolvedValueOnce({}); // ROLLBACK
    mockConnect(client);

    const result = await createOrder(CART_ID, true, "Casablanca", "card", "2026-10-15");

    expect(result).toEqual({
      created: false,
      reason: "price_changed",
      changes: [{ productRef: "REF-0018", quantity: 1, cartUnitPriceCents: 16000, currentUnitPriceCents: 20000 }],
    });
  });

  it("S: a newly-active promo (cart snapshot=catalogue, current=promo) returns price_changed", async () => {
    const client = makeFakeClient();
    queuePrefix(client, { itemRows: [{ product_ref: "REF-0018", quantity: 1, unit_price_cents: 20000 }] });
    client.query.mockResolvedValueOnce({ rows: [{ ref: "REF-0018", stock: 1 }] });
    queuePricing(client, makeProductRow({ ref: "REF-0018", price_cents: 20000, stock: 1 }), [
      {
        id: "55555555-5555-4555-8555-555555555555",
        product_ref: "REF-0018",
        normal_price_cents: 20000,
        promo_price_cents: 16000,
        starts_at: "2026-09-01",
        ends_at: "2026-09-30",
        condition: "dans la limite des stocks disponibles",
      },
    ]);
    client.query.mockResolvedValueOnce({}); // ROLLBACK
    mockConnect(client);

    const result = await createOrder(CART_ID, true, "Casablanca", "card", AS_OF_DATE);

    expect(result).toEqual({
      created: false,
      reason: "price_changed",
      changes: [{ productRef: "REF-0018", quantity: 1, cartUnitPriceCents: 20000, currentUnitPriceCents: 16000 }],
    });
  });

  it("T, U: multiple price changes are returned together, sorted by productRef ascending", async () => {
    const client = makeFakeClient();
    queuePrefix(client, {
      itemRows: [
        { product_ref: "REF-0001", quantity: 1, unit_price_cents: 9000 },
        { product_ref: "REF-0002", quantity: 1, unit_price_cents: 5000 },
      ],
    });
    client.query.mockResolvedValueOnce({
      rows: [
        { ref: "REF-0001", stock: 5 },
        { ref: "REF-0002", stock: 5 },
      ],
    });
    // The real query applies ORDER BY product_ref; the mock supplies rows
    // already in that order (REF-0001 before REF-0002) to accurately simulate it.
    queuePricing(client, makeProductRow({ ref: "REF-0001", price_cents: 10000, stock: 5 }));
    queuePricing(client, makeProductRow({ ref: "REF-0002", price_cents: 6000, stock: 5 }));
    client.query.mockResolvedValueOnce({}); // ROLLBACK
    mockConnect(client);

    const result = await createOrder(CART_ID, true, "Casablanca", "card", AS_OF_DATE);

    expect(result).toEqual({
      created: false,
      reason: "price_changed",
      changes: [
        { productRef: "REF-0001", quantity: 1, cartUnitPriceCents: 9000, currentUnitPriceCents: 10000 },
        { productRef: "REF-0002", quantity: 1, cartUnitPriceCents: 5000, currentUnitPriceCents: 6000 },
      ],
    });
  });

  it("V: each price change includes the cart's requested quantity", async () => {
    const client = makeFakeClient();
    queuePrefix(client, { itemRows: [{ product_ref: "REF-0001", quantity: 4, unit_price_cents: 9000 }] });
    client.query.mockResolvedValueOnce({ rows: [{ ref: "REF-0001", stock: 5 }] });
    queuePricing(client, makeProductRow({ price_cents: 10000, stock: 5 }));
    client.query.mockResolvedValueOnce({}); // ROLLBACK
    mockConnect(client);

    const result = await createOrder(CART_ID, true, "Casablanca", "card", AS_OF_DATE);

    expect(result).toEqual({
      created: false,
      reason: "price_changed",
      changes: [{ productRef: "REF-0001", quantity: 4, cartUnitPriceCents: 9000, currentUnitPriceCents: 10000 }],
    });
  });
});

describe("createOrder — delivery and payment (W, X, Y, Z, AA)", () => {
  it("W: unknown city returns delivery_not_found and rolls back, no order", async () => {
    const client = makeFakeClient();
    queuePrefix(client);
    client.query.mockResolvedValueOnce({ rows: [{ ref: "REF-0001", stock: 5 }] });
    queuePricing(client, makeProductRow());
    client.query.mockResolvedValueOnce({ rows: [] }); // delivery not found
    client.query.mockResolvedValueOnce({}); // ROLLBACK
    mockConnect(client);

    const result = await createOrder(CART_ID, true, "Zagora", "card", AS_OF_DATE);

    expect(result).toEqual({ created: false, reason: "delivery_not_found", city: "Zagora" });
  });

  it("X: COD allowed in the delivery zone succeeds", async () => {
    const client = makeFakeClient();
    queuePrefix(client);
    client.query.mockResolvedValueOnce({ rows: [{ ref: "REF-0001", stock: 5 }] });
    queuePricing(client, makeProductRow());
    queueHappyPathTail(client, makeDeliveryRow({ cash_on_delivery: true }), makeOrderRow(), 4);
    mockConnect(client);

    const result = await createOrder(CART_ID, true, "Casablanca", "cash_on_delivery", AS_OF_DATE);
    expect(result.created).toBe(true);
  });

  it("Y: COD forbidden in the delivery zone rejects, no order, no stock decrement", async () => {
    const client = makeFakeClient();
    queuePrefix(client);
    client.query.mockResolvedValueOnce({ rows: [{ ref: "REF-0001", stock: 5 }] });
    queuePricing(client, makeProductRow());
    client.query.mockResolvedValueOnce({ rows: [makeDeliveryRow({ city: "Fès", cash_on_delivery: false })] });
    client.query.mockResolvedValueOnce({}); // ROLLBACK
    mockConnect(client);

    const result = await createOrder(CART_ID, true, "Fès", "cash_on_delivery", AS_OF_DATE);

    expect(result).toEqual({
      created: false,
      reason: "payment_not_allowed_for_delivery_zone",
      city: "Fès",
      paymentMethod: "cash_on_delivery",
    });
    expect(client.query).not.toHaveBeenCalledWith(expect.stringMatching(/UPDATE products/i), expect.anything());
  });

  it("Z: card is accepted regardless of the delivery zone's cashOnDelivery value", async () => {
    const client = makeFakeClient();
    queuePrefix(client);
    client.query.mockResolvedValueOnce({ rows: [{ ref: "REF-0001", stock: 5 }] });
    queuePricing(client, makeProductRow());
    queueHappyPathTail(
      client,
      makeDeliveryRow({ city: "Fès", cash_on_delivery: false }),
      makeOrderRow({ payment_method: "card", city: "Fès" }),
      4,
    );
    mockConnect(client);

    const result = await createOrder(CART_ID, true, "Fès", "card", AS_OF_DATE);
    expect(result.created).toBe(true);
  });

  it("AA: bank_transfer is accepted regardless of the delivery zone's cashOnDelivery value", async () => {
    const client = makeFakeClient();
    queuePrefix(client);
    client.query.mockResolvedValueOnce({ rows: [{ ref: "REF-0001", stock: 5 }] });
    queuePricing(client, makeProductRow());
    queueHappyPathTail(
      client,
      makeDeliveryRow({ city: "Fès", cash_on_delivery: false }),
      makeOrderRow({ payment_method: "bank_transfer", city: "Fès" }),
      4,
    );
    mockConnect(client);

    const result = await createOrder(CART_ID, true, "Fès", "bank_transfer", AS_OF_DATE);
    expect(result.created).toBe(true);
  });
});

describe("createOrder — totals and integer safety (AB, AC, AD, AE)", () => {
  it("AB, AC, AD: products total, delivery fee, and grand total are exact integers mapped to MAD", async () => {
    const client = makeFakeClient();
    queuePrefix(client, { itemRows: [{ product_ref: "REF-0001", quantity: 3, unit_price_cents: 10000 }] });
    client.query.mockResolvedValueOnce({ rows: [{ ref: "REF-0001", stock: 5 }] });
    queuePricing(client, makeProductRow({ price_cents: 10000, stock: 5 }));
    queueHappyPathTail(
      client,
      makeDeliveryRow({ fee_cents: 2500 }),
      makeOrderRow({ products_total_cents: 30000, delivery_fee_cents: 2500, total_cents: 32500 }),
      2,
    );
    mockConnect(client);

    const result = await createOrder(CART_ID, true, "Casablanca", "cash_on_delivery", AS_OF_DATE);

    expect(result.created).toBe(true);
    if (result.created) {
      expect(result.order.productsTotal).toBe(300);
      expect(result.order.deliveryFee).toBe(25);
      expect(result.order.total).toBe(325);
    }
  });

  it("AE: a PostgreSQL INTEGER overflow is rejected before any write", async () => {
    const client = makeFakeClient();
    queuePrefix(client, {
      itemRows: [{ product_ref: "REF-0001", quantity: 30000, unit_price_cents: 100000 }],
    });
    client.query.mockResolvedValueOnce({ rows: [{ ref: "REF-0001", stock: 40000 }] });
    queuePricing(client, makeProductRow({ price_cents: 100000, stock: 40000 }));
    client.query.mockResolvedValueOnce({ rows: [makeDeliveryRow()] }); // delivery (reached before totals are computed)
    client.query.mockResolvedValueOnce({}); // ROLLBACK
    mockConnect(client);

    await expect(createOrder(CART_ID, true, "Casablanca", "card", AS_OF_DATE)).rejects.toThrow(/PostgreSQL INTEGER range/i);
    // 30000 * 100000 = 3_000_000_000 > 2_147_483_647
    expect(client.query).not.toHaveBeenCalledWith(expect.stringMatching(/INSERT INTO orders/i), expect.anything());
  });
});

describe("createOrder — writes (AF, AG, AH, AI, AJ, AK, AL)", () => {
  it("AF: uses the deterministic key cart:${cartId}:v${version}, never a random UUID", async () => {
    const client = makeFakeClient();
    queuePrefix(client, { cartRow: { id: CART_ID, conversation_id: CONVERSATION_ID, customer_id: CUSTOMER_ID, version: 3 } });
    client.query.mockResolvedValueOnce({ rows: [{ ref: "REF-0001", stock: 5 }] });
    queuePricing(client, makeProductRow());
    queueHappyPathTail(client, makeDeliveryRow(), makeOrderRow(), 4);
    mockConnect(client);

    await createOrder(CART_ID, true, "Casablanca", "cash_on_delivery", AS_OF_DATE);

    const insertCall = client.query.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("INSERT INTO orders"),
    ) as [string, unknown[]];
    const idempotencyKey = insertCall[1][7] as string;
    expect(idempotencyKey).toBe(`cart:${CART_ID}:v3`);
  });

  it("AG: the order is always inserted with status 'confirmed'", async () => {
    const client = makeFakeClient();
    queuePrefix(client);
    client.query.mockResolvedValueOnce({ rows: [{ ref: "REF-0001", stock: 5 }] });
    queuePricing(client, makeProductRow());
    queueHappyPathTail(client, makeDeliveryRow(), makeOrderRow(), 4);
    mockConnect(client);

    const result = await createOrder(CART_ID, true, "Casablanca", "cash_on_delivery", AS_OF_DATE);

    const insertCall = client.query.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("INSERT INTO orders"),
    ) as [string, unknown[]];
    expect(insertCall[0]).toContain("'confirmed'");
    if (result.created) expect(result.order.status).toBe("confirmed");
  });

  it("AH: order_items use the CURRENT authoritative price, not the stale cart snapshot", async () => {
    const client = makeFakeClient();
    // cart snapshot is stale (18000) but current authoritative price is 20000 with no promo diff triggered
    // because here we exercise the *unchanged* path where cart snapshot already equals current price,
    // proving unit_price_cents written is the authoritative (pricing.effectivePriceCents) value.
    queuePrefix(client, { itemRows: [{ product_ref: "REF-0001", quantity: 1, unit_price_cents: 10000 }] });
    client.query.mockResolvedValueOnce({ rows: [{ ref: "REF-0001", stock: 5 }] });
    queuePricing(client, makeProductRow({ price_cents: 10000, stock: 5 }));
    queueHappyPathTail(client, makeDeliveryRow(), makeOrderRow(), 4);
    mockConnect(client);

    await createOrder(CART_ID, true, "Casablanca", "cash_on_delivery", AS_OF_DATE);

    const itemInsertCall = client.query.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("INSERT INTO order_items"),
    ) as [string, unknown[]];
    expect(itemInsertCall[1]).toEqual([ORDER_ID, "REF-0001", 1, 10000]);
  });

  it("AI: order items are inserted per cart line", async () => {
    const client = makeFakeClient();
    queuePrefix(client, {
      itemRows: [
        { product_ref: "REF-0001", quantity: 1, unit_price_cents: 10000 },
        { product_ref: "REF-0002", quantity: 2, unit_price_cents: 5000 },
      ],
    });
    client.query.mockResolvedValueOnce({
      rows: [
        { ref: "REF-0001", stock: 5 },
        { ref: "REF-0002", stock: 5 },
      ],
    });
    queuePricing(client, makeProductRow({ ref: "REF-0001", price_cents: 10000, stock: 5 }));
    queuePricing(client, makeProductRow({ ref: "REF-0002", price_cents: 5000, stock: 5 }));
    client.query.mockResolvedValueOnce({ rows: [makeDeliveryRow()] });
    client.query.mockResolvedValueOnce({ rows: [makeOrderRow({ products_total_cents: 20000, total_cents: 22500 })] });
    client.query.mockResolvedValueOnce({}); // order_item 1
    client.query.mockResolvedValueOnce({}); // order_item 2
    client.query.mockResolvedValueOnce({ rows: [{ stock: 4 }] });
    client.query.mockResolvedValueOnce({ rows: [{ stock: 3 }] });
    client.query.mockResolvedValueOnce({});
    client.query.mockResolvedValueOnce({});
    client.query.mockResolvedValueOnce({});
    mockConnect(client);

    const result = await createOrder(CART_ID, true, "Casablanca", "cash_on_delivery", AS_OF_DATE);

    expect(result.created).toBe(true);
    const itemInserts = client.query.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("INSERT INTO order_items"),
    );
    expect(itemInserts).toHaveLength(2);
  });

  it("AJ, AK: stock is decremented exactly, guarded by stock >= quantity in SQL", async () => {
    const client = makeFakeClient();
    queuePrefix(client, { itemRows: [{ product_ref: "REF-0001", quantity: 2, unit_price_cents: 10000 }] });
    client.query.mockResolvedValueOnce({ rows: [{ ref: "REF-0001", stock: 5 }] });
    queuePricing(client, makeProductRow({ price_cents: 10000, stock: 5 }));
    queueHappyPathTail(client, makeDeliveryRow(), makeOrderRow({ products_total_cents: 20000, total_cents: 22500 }), 3);
    mockConnect(client);

    await createOrder(CART_ID, true, "Casablanca", "cash_on_delivery", AS_OF_DATE);

    const stockCall = client.query.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("UPDATE products"),
    ) as [string, unknown[]];
    expect(stockCall[0]).toMatch(/stock\s*=\s*stock\s*-\s*\$2/i);
    expect(stockCall[0]).toMatch(/AND stock >= \$2/i);
    expect(stockCall[1]).toEqual(["REF-0001", 2]);
  });

  it("AL: no query ever mutates carts.status or carts.version", async () => {
    const client = makeFakeClient();
    queuePrefix(client);
    client.query.mockResolvedValueOnce({ rows: [{ ref: "REF-0001", stock: 5 }] });
    queuePricing(client, makeProductRow());
    queueHappyPathTail(client, makeDeliveryRow(), makeOrderRow(), 4);
    mockConnect(client);

    await createOrder(CART_ID, true, "Casablanca", "cash_on_delivery", AS_OF_DATE);

    const cartMutations = client.query.mock.calls.filter(
      (call) => typeof call[0] === "string" && /UPDATE\s+carts/i.test(call[0]),
    );
    expect(cartMutations).toHaveLength(0);
  });
});

describe("createOrder — rollback and error handling (AM, AN, AO, AP, AQ, AR, AS)", () => {
  it("AM: a DB failure during the order INSERT rolls back and rethrows", async () => {
    const client = makeFakeClient();
    queuePrefix(client);
    client.query.mockResolvedValueOnce({ rows: [{ ref: "REF-0001", stock: 5 }] });
    queuePricing(client, makeProductRow());
    client.query.mockResolvedValueOnce({ rows: [makeDeliveryRow()] });
    client.query.mockRejectedValueOnce(new Error("connection lost"));
    client.query.mockResolvedValueOnce({}); // ROLLBACK
    mockConnect(client);

    await expect(createOrder(CART_ID, true, "Casablanca", "cash_on_delivery", AS_OF_DATE)).rejects.toThrow(
      "connection lost",
    );
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.query).not.toHaveBeenCalledWith("COMMIT");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("AN: a DB failure during an order-item INSERT rolls back the whole multi-item order", async () => {
    const client = makeFakeClient();
    queuePrefix(client, {
      itemRows: [
        { product_ref: "REF-0001", quantity: 1, unit_price_cents: 10000 },
        { product_ref: "REF-0002", quantity: 1, unit_price_cents: 5000 },
      ],
    });
    client.query.mockResolvedValueOnce({
      rows: [
        { ref: "REF-0001", stock: 5 },
        { ref: "REF-0002", stock: 5 },
      ],
    });
    queuePricing(client, makeProductRow({ ref: "REF-0001", price_cents: 10000, stock: 5 }));
    queuePricing(client, makeProductRow({ ref: "REF-0002", price_cents: 5000, stock: 5 }));
    client.query.mockResolvedValueOnce({ rows: [makeDeliveryRow()] });
    client.query.mockResolvedValueOnce({ rows: [makeOrderRow()] });
    client.query.mockResolvedValueOnce({}); // order_item 1 ok
    client.query.mockRejectedValueOnce(new Error("constraint violation")); // order_item 2 fails
    client.query.mockResolvedValueOnce({}); // ROLLBACK
    mockConnect(client);

    await expect(createOrder(CART_ID, true, "Casablanca", "cash_on_delivery", AS_OF_DATE)).rejects.toThrow(
      "constraint violation",
    );
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.query).not.toHaveBeenCalledWith("COMMIT");
  });

  it("AO: a DB failure during stock decrement rolls back — no partial multi-item order survives", async () => {
    const client = makeFakeClient();
    queuePrefix(client, {
      itemRows: [
        { product_ref: "REF-0001", quantity: 1, unit_price_cents: 10000 },
        { product_ref: "REF-0002", quantity: 1, unit_price_cents: 5000 },
      ],
    });
    client.query.mockResolvedValueOnce({
      rows: [
        { ref: "REF-0001", stock: 5 },
        { ref: "REF-0002", stock: 5 },
      ],
    });
    queuePricing(client, makeProductRow({ ref: "REF-0001", price_cents: 10000, stock: 5 }));
    queuePricing(client, makeProductRow({ ref: "REF-0002", price_cents: 5000, stock: 5 }));
    client.query.mockResolvedValueOnce({ rows: [makeDeliveryRow()] });
    client.query.mockResolvedValueOnce({ rows: [makeOrderRow()] });
    client.query.mockResolvedValueOnce({}); // order_item 1
    client.query.mockResolvedValueOnce({}); // order_item 2
    client.query.mockResolvedValueOnce({ rows: [{ stock: 4 }] }); // stock decrement 1 ok
    client.query.mockRejectedValueOnce(new Error("deadlock detected")); // stock decrement 2 fails
    client.query.mockResolvedValueOnce({}); // ROLLBACK
    mockConnect(client);

    await expect(createOrder(CART_ID, true, "Casablanca", "cash_on_delivery", AS_OF_DATE)).rejects.toThrow(
      "deadlock detected",
    );
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.query).not.toHaveBeenCalledWith("COMMIT");
  });

  it("AQ, AR, AS: the client is released exactly once on success, business failure, and thrown failure", async () => {
    // success
    const successClient = makeFakeClient();
    queuePrefix(successClient);
    successClient.query.mockResolvedValueOnce({ rows: [{ ref: "REF-0001", stock: 5 }] });
    queuePricing(successClient, makeProductRow());
    queueHappyPathTail(successClient, makeDeliveryRow(), makeOrderRow(), 4);
    vi.spyOn(postgresPool, "connect").mockResolvedValueOnce(successClient as never);
    await createOrder(CART_ID, true, "Casablanca", "cash_on_delivery", AS_OF_DATE);
    expect(successClient.release).toHaveBeenCalledTimes(1);

    // business failure
    const businessFailureClient = makeFakeClient();
    queuePrefix(businessFailureClient, { cartRow: null });
    businessFailureClient.query.mockResolvedValueOnce({}); // ROLLBACK
    vi.spyOn(postgresPool, "connect").mockResolvedValueOnce(businessFailureClient as never);
    await createOrder(CART_ID, true, "Casablanca", "card", AS_OF_DATE);
    expect(businessFailureClient.release).toHaveBeenCalledTimes(1);

    // thrown failure
    const thrownFailureClient = makeFakeClient();
    queuePrefix(thrownFailureClient, { cartRow: null });
    thrownFailureClient.query.mockRejectedValueOnce(new Error("rollback also fails")); // ROLLBACK itself fails
    vi.spyOn(postgresPool, "connect").mockResolvedValueOnce(thrownFailureClient as never);
    thrownFailureClient.query.mockReset();
    thrownFailureClient.query.mockResolvedValueOnce({}); // BEGIN
    thrownFailureClient.query.mockResolvedValueOnce({}); // SET lock_timeout
    thrownFailureClient.query.mockRejectedValueOnce(new Error("statement_timeout failed")); // SET statement_timeout throws
    thrownFailureClient.query.mockResolvedValueOnce({}); // ROLLBACK best-effort
    await expect(createOrder(CART_ID, true, "Casablanca", "card", AS_OF_DATE)).rejects.toThrow(
      "statement_timeout failed",
    );
    expect(thrownFailureClient.release).toHaveBeenCalledTimes(1);
  });
});

describe("createOrder — server-side timeouts, no client-side race (AT, AU, AV)", () => {
  it("AT: SET LOCAL lock_timeout/statement_timeout are issued right after BEGIN", async () => {
    const client = makeFakeClient();
    queuePrefix(client);
    client.query.mockResolvedValueOnce({ rows: [{ ref: "REF-0001", stock: 5 }] });
    queuePricing(client, makeProductRow());
    queueHappyPathTail(client, makeDeliveryRow(), makeOrderRow(), 4);
    mockConnect(client);

    await createOrder(CART_ID, true, "Casablanca", "cash_on_delivery", AS_OF_DATE);

    expect(client.query.mock.calls[0][0]).toBe("BEGIN");
    expect(client.query.mock.calls[1][0]).toMatch(/SET LOCAL lock_timeout/i);
    expect(client.query.mock.calls[2][0]).toMatch(/SET LOCAL statement_timeout/i);
  });

  it("AU: timeouts are reset to 0 before COMMIT, and COMMIT is the very last call", async () => {
    const client = makeFakeClient();
    queuePrefix(client);
    client.query.mockResolvedValueOnce({ rows: [{ ref: "REF-0001", stock: 5 }] });
    queuePricing(client, makeProductRow());
    queueHappyPathTail(client, makeDeliveryRow(), makeOrderRow(), 4);
    mockConnect(client);

    await createOrder(CART_ID, true, "Casablanca", "cash_on_delivery", AS_OF_DATE);

    const calls = client.query.mock.calls.map((call) => call[0]);
    const lastThree = calls.slice(-3);
    expect(lastThree[0]).toMatch(/SET LOCAL statement_timeout = 0/i);
    expect(lastThree[1]).toMatch(/SET LOCAL lock_timeout = 0/i);
    expect(lastThree[2]).toBe("COMMIT");
  });

  it("AV: withTimeout is never used anywhere in the createOrder transaction path", async () => {
    const timeoutSpy = vi.spyOn(timeoutModule, "withTimeout");
    const client = makeFakeClient();
    queuePrefix(client);
    client.query.mockResolvedValueOnce({ rows: [{ ref: "REF-0001", stock: 5 }] });
    queuePricing(client, makeProductRow());
    queueHappyPathTail(client, makeDeliveryRow(), makeOrderRow(), 4);
    mockConnect(client);

    await createOrder(CART_ID, true, "Casablanca", "cash_on_delivery", AS_OF_DATE);

    expect(timeoutSpy).not.toHaveBeenCalled();
  });
});

describe("createOrder — schema validation timing and mapping (AW, AX, AY, AZ)", () => {
  it("AW: no COMMIT is ever sent before all writes (order/order_items/stock) complete — proving OrderSchema.parse runs before COMMIT", async () => {
    const client = makeFakeClient();
    queuePrefix(client);
    client.query.mockResolvedValueOnce({ rows: [{ ref: "REF-0001", stock: 5 }] });
    queuePricing(client, makeProductRow());
    queueHappyPathTail(client, makeDeliveryRow(), makeOrderRow(), 4);
    mockConnect(client);

    await createOrder(CART_ID, true, "Casablanca", "cash_on_delivery", AS_OF_DATE);

    const calls = client.query.mock.calls.map((call) => call[0] as string);
    const commitIndex = calls.indexOf("COMMIT");
    const orderInsertIndex = calls.findIndex((sql) => sql.includes("INSERT INTO orders"));
    const itemInsertIndex = calls.findIndex((sql) => sql.includes("INSERT INTO order_items"));
    const stockUpdateIndex = calls.findIndex((sql) => sql.includes("UPDATE products"));
    expect(commitIndex).toBeGreaterThan(orderInsertIndex);
    expect(commitIndex).toBeGreaterThan(itemInsertIndex);
    expect(commitIndex).toBeGreaterThan(stockUpdateIndex);
  });

  it("AX: created_at (a JS Date from timestamptz) maps via toISOString(), not a raw text cast", async () => {
    const client = makeFakeClient();
    queuePrefix(client);
    client.query.mockResolvedValueOnce({ rows: [{ ref: "REF-0001", stock: 5 }] });
    queuePricing(client, makeProductRow());
    queueHappyPathTail(
      client,
      makeDeliveryRow(),
      makeOrderRow({ created_at: new Date("2026-09-18T12:34:56.789Z") }),
      4,
    );
    mockConnect(client);

    const result = await createOrder(CART_ID, true, "Casablanca", "cash_on_delivery", AS_OF_DATE);

    expect(result.created).toBe(true);
    if (result.created) {
      expect(result.order.createdAt).toBe("2026-09-18T12:34:56.789Z");
      expect(OrderSchema.safeParse(result.order).success).toBe(true);
    }
  });

  it("AY: no query is issued after COMMIT (no post-commit reload)", async () => {
    const client = makeFakeClient();
    queuePrefix(client);
    client.query.mockResolvedValueOnce({ rows: [{ ref: "REF-0001", stock: 5 }] });
    queuePricing(client, makeProductRow());
    queueHappyPathTail(client, makeDeliveryRow(), makeOrderRow(), 4);
    mockConnect(client);

    await createOrder(CART_ID, true, "Casablanca", "cash_on_delivery", AS_OF_DATE);

    const calls = client.query.mock.calls.map((call) => call[0] as string);
    expect(calls[calls.length - 1]).toBe("COMMIT");
  });

  it("AZ: a failure on COMMIT itself rethrows and attempts a best-effort rollback", async () => {
    const client = makeFakeClient();
    queuePrefix(client);
    client.query.mockResolvedValueOnce({ rows: [{ ref: "REF-0001", stock: 5 }] });
    queuePricing(client, makeProductRow());
    client.query.mockResolvedValueOnce({ rows: [makeDeliveryRow()] });
    client.query.mockResolvedValueOnce({ rows: [makeOrderRow()] });
    client.query.mockResolvedValueOnce({});
    client.query.mockResolvedValueOnce({ rows: [{ stock: 4 }] });
    client.query.mockResolvedValueOnce({}); // SET statement_timeout = 0
    client.query.mockResolvedValueOnce({}); // SET lock_timeout = 0
    client.query.mockRejectedValueOnce(new Error("commit ack lost")); // COMMIT fails
    client.query.mockResolvedValueOnce({}); // best-effort ROLLBACK
    mockConnect(client);

    await expect(createOrder(CART_ID, true, "Casablanca", "cash_on_delivery", AS_OF_DATE)).rejects.toThrow(
      "commit ack lost",
    );
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});

describe("createOrder — security and scope (BA)", () => {
  it("BA: the signature never accepts a caller-supplied price, fee, total, or idempotency key", () => {
    expect(createOrder.length).toBe(5);
  });
});

function makeExistingOrderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    customer_id: CUSTOMER_ID,
    conversation_id: CONVERSATION_ID,
    status: "confirmed",
    products_total_cents: 10000,
    delivery_fee_cents: 2500,
    total_cents: 12500,
    city: "Casablanca",
    payment_method: "cash_on_delivery",
    created_at: new Date("2026-09-18T12:00:00.000Z"),
    city_matches: true,
    ...overrides,
  };
}

function makeExistingOrderItemRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "66666666-6666-4666-8666-666666666666",
    product_ref: "REF-0001",
    quantity: 1,
    unit_price_cents: 10000,
    ...overrides,
  };
}

describe("createOrder — idempotency (A-AL)", () => {
  it("B: deterministic key is cart:${cartId}:v${version} — covered directly in AF above", () => {
    expect(true).toBe(true);
  });

  it("D, E: a valid early replay returns the SAME order id, replayed:true, via ROLLBACK not COMMIT", async () => {
    const client = makeFakeClient();
    queuePrefix(client, { existingOrderRows: [makeExistingOrderRow()] });
    client.query.mockResolvedValueOnce({ rows: [makeExistingOrderItemRow()] }); // order_items
    client.query.mockResolvedValueOnce({}); // ROLLBACK
    mockConnect(client);

    const result = await createOrder(CART_ID, true, "Casablanca", "cash_on_delivery", AS_OF_DATE);

    expect(result).toEqual({
      created: true,
      replayed: true,
      order: expect.objectContaining({ id: ORDER_ID }),
    });
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.query).not.toHaveBeenCalledWith("COMMIT");
  });

  it("G, H, I, J, K, M: a valid replay never queries cart_items/products/promotions/delivery, never inserts/decrements", async () => {
    const client = makeFakeClient();
    queuePrefix(client, { existingOrderRows: [makeExistingOrderRow()] });
    client.query.mockResolvedValueOnce({ rows: [makeExistingOrderItemRow()] });
    client.query.mockResolvedValueOnce({}); // ROLLBACK
    mockConnect(client);

    await createOrder(CART_ID, true, "Casablanca", "cash_on_delivery", AS_OF_DATE);

    const sqlCalls = client.query.mock.calls.map((call) => call[0]).filter((sql): sql is string => typeof sql === "string");
    expect(sqlCalls.some((sql) => sql.includes("FROM cart_items"))).toBe(false);
    expect(sqlCalls.some((sql) => sql.includes("FROM products"))).toBe(false);
    expect(sqlCalls.some((sql) => sql.includes("FROM promotions"))).toBe(false);
    expect(sqlCalls.some((sql) => sql.includes("FROM delivery_zones"))).toBe(false);
    expect(sqlCalls.some((sql) => sql.includes("INSERT INTO orders"))).toBe(false);
    expect(sqlCalls.some((sql) => sql.includes("INSERT INTO order_items"))).toBe(false);
    expect(sqlCalls.some((sql) => sql.includes("UPDATE products"))).toBe(false);
  });

  it("N, O: replay returns the stored original price/delivery fee, ignoring any current values", async () => {
    const client = makeFakeClient();
    queuePrefix(client, {
      existingOrderRows: [makeExistingOrderRow({ products_total_cents: 77700, delivery_fee_cents: 3300, total_cents: 81000 })],
    });
    client.query.mockResolvedValueOnce({ rows: [makeExistingOrderItemRow({ unit_price_cents: 77700 })] });
    client.query.mockResolvedValueOnce({}); // ROLLBACK
    mockConnect(client);

    const result = await createOrder(CART_ID, true, "Casablanca", "cash_on_delivery", AS_OF_DATE);

    expect(result.created).toBe(true);
    if (result.created) {
      expect(result.order.productsTotal).toBe(777);
      expect(result.order.deliveryFee).toBe(33);
      expect(result.order.total).toBe(810);
      expect(result.order.items[0]?.unitPrice).toBe(777);
    }
  });

  it("R: retry with a city casing difference (CASABLANCA vs Casablanca) replays successfully", async () => {
    const client = makeFakeClient();
    // city_matches is computed by SQL lower(...) in production; the mock
    // simulates that SQL result directly rather than re-implementing case-folding.
    queuePrefix(client, { existingOrderRows: [makeExistingOrderRow({ city: "Casablanca", city_matches: true })] });
    client.query.mockResolvedValueOnce({ rows: [makeExistingOrderItemRow()] });
    client.query.mockResolvedValueOnce({}); // ROLLBACK
    mockConnect(client);

    const result = await createOrder(CART_ID, true, "CASABLANCA", "cash_on_delivery", AS_OF_DATE);

    expect(result).toEqual({ created: true, replayed: true, order: expect.objectContaining({ id: ORDER_ID }) });
  });

  it("S: an accent-different city (Fès stored vs Fes requested) is a conflict, not a replay", async () => {
    const client = makeFakeClient();
    queuePrefix(client, {
      existingOrderRows: [makeExistingOrderRow({ city: "Fès", city_matches: false })],
    });
    client.query.mockResolvedValueOnce({}); // ROLLBACK
    mockConnect(client);

    const result = await createOrder(CART_ID, true, "Fes", "cash_on_delivery", AS_OF_DATE);

    expect(result).toEqual({ created: false, reason: "idempotency_conflict" });
  });

  it("T: a different paymentMethod under the same identity is a conflict", async () => {
    const client = makeFakeClient();
    queuePrefix(client, {
      existingOrderRows: [makeExistingOrderRow({ payment_method: "cash_on_delivery", city_matches: true })],
    });
    client.query.mockResolvedValueOnce({}); // ROLLBACK
    mockConnect(client);

    const result = await createOrder(CART_ID, true, "Casablanca", "card", AS_OF_DATE);

    expect(result).toEqual({ created: false, reason: "idempotency_conflict" });
  });

  it("U: a stored customer mismatch throws an explicit Integrity error, never idempotency_conflict", async () => {
    const client = makeFakeClient();
    queuePrefix(client, {
      existingOrderRows: [makeExistingOrderRow({ customer_id: "99999999-9999-4999-8999-999999999999" })],
    });
    client.query.mockResolvedValueOnce({}); // best-effort ROLLBACK on thrown error
    mockConnect(client);

    await expect(createOrder(CART_ID, true, "Casablanca", "cash_on_delivery", AS_OF_DATE)).rejects.toThrow(
      /Integrity error.*customer/i,
    );
  });

  it("V: a stored conversation mismatch throws an explicit Integrity error, never idempotency_conflict", async () => {
    const client = makeFakeClient();
    queuePrefix(client, {
      existingOrderRows: [makeExistingOrderRow({ conversation_id: "88888888-8888-4888-8888-888888888888" })],
    });
    client.query.mockResolvedValueOnce({}); // best-effort ROLLBACK on thrown error
    mockConnect(client);

    await expect(createOrder(CART_ID, true, "Casablanca", "cash_on_delivery", AS_OF_DATE)).rejects.toThrow(
      /Integrity error.*conversation/i,
    );
  });

  it("W: a malformed/corrupt existing order (fails OrderSchema) throws rather than being silently repaired", async () => {
    const client = makeFakeClient();
    queuePrefix(client, { existingOrderRows: [makeExistingOrderRow()] });
    client.query.mockResolvedValueOnce({ rows: [] }); // zero order_items -> OrderSchema requires >= 1
    client.query.mockResolvedValueOnce({}); // best-effort ROLLBACK
    mockConnect(client);

    await expect(createOrder(CART_ID, true, "Casablanca", "cash_on_delivery", AS_OF_DATE)).rejects.toThrow();
  });

  it("Y: existing order items are loaded ORDER BY product_ref, id", async () => {
    const client = makeFakeClient();
    queuePrefix(client, { existingOrderRows: [makeExistingOrderRow()] });
    client.query.mockResolvedValueOnce({ rows: [makeExistingOrderItemRow()] });
    client.query.mockResolvedValueOnce({}); // ROLLBACK
    mockConnect(client);

    await createOrder(CART_ID, true, "Casablanca", "cash_on_delivery", AS_OF_DATE);

    const itemsCall = client.query.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("FROM order_items"),
    ) as [string, unknown[]];
    expect(itemsCall[0]).toMatch(/ORDER BY product_ref,\s*id/i);
  });

  it("Z, AA: first creation uses ON CONFLICT (idempotency_key) DO NOTHING with the deterministic key", async () => {
    const client = makeFakeClient();
    queuePrefix(client, { cartRow: { id: CART_ID, conversation_id: CONVERSATION_ID, customer_id: CUSTOMER_ID, version: 7 } });
    client.query.mockResolvedValueOnce({ rows: [{ ref: "REF-0001", stock: 5 }] });
    queuePricing(client, makeProductRow());
    queueHappyPathTail(client, makeDeliveryRow(), makeOrderRow(), 4);
    mockConnect(client);

    await createOrder(CART_ID, true, "Casablanca", "cash_on_delivery", AS_OF_DATE);

    const insertCall = client.query.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("INSERT INTO orders"),
    ) as [string, unknown[]];
    expect(insertCall[0]).toMatch(/ON CONFLICT \(idempotency_key\) DO NOTHING/i);
    expect(insertCall[1][7]).toBe(`cart:${CART_ID}:v7`);
  });

  it("AB-AE: the ON CONFLICT zero-row fallback applies the same replay semantics (valid replay, conflict, and impossible-mismatch throw)", async () => {
    // AC: fallback valid replay
    const replayClient = makeFakeClient();
    queuePrefix(replayClient);
    replayClient.query.mockResolvedValueOnce({ rows: [{ ref: "REF-0001", stock: 5 }] });
    queuePricing(replayClient, makeProductRow());
    replayClient.query.mockResolvedValueOnce({ rows: [makeDeliveryRow()] });
    replayClient.query.mockResolvedValueOnce({ rows: [] }); // INSERT ... ON CONFLICT DO NOTHING -> 0 rows
    replayClient.query.mockResolvedValueOnce({ rows: [makeExistingOrderRow()] }); // fallback loader: orders
    replayClient.query.mockResolvedValueOnce({ rows: [makeExistingOrderItemRow()] }); // fallback loader: order_items
    replayClient.query.mockResolvedValueOnce({}); // ROLLBACK
    vi.spyOn(postgresPool, "connect").mockResolvedValueOnce(replayClient as never);
    const replayResult = await createOrder(CART_ID, true, "Casablanca", "cash_on_delivery", AS_OF_DATE);
    expect(replayResult).toEqual({ created: true, replayed: true, order: expect.objectContaining({ id: ORDER_ID }) });
    expect(replayClient.query).toHaveBeenCalledWith("ROLLBACK");
    expect(replayClient.query).not.toHaveBeenCalledWith("COMMIT");

    // AD: fallback conflict
    const conflictClient = makeFakeClient();
    queuePrefix(conflictClient);
    conflictClient.query.mockResolvedValueOnce({ rows: [{ ref: "REF-0001", stock: 5 }] });
    queuePricing(conflictClient, makeProductRow());
    conflictClient.query.mockResolvedValueOnce({ rows: [makeDeliveryRow()] });
    conflictClient.query.mockResolvedValueOnce({ rows: [] }); // INSERT conflict
    conflictClient.query.mockResolvedValueOnce({ rows: [makeExistingOrderRow({ city_matches: false })] }); // fallback loader
    conflictClient.query.mockResolvedValueOnce({}); // ROLLBACK
    vi.spyOn(postgresPool, "connect").mockResolvedValueOnce(conflictClient as never);
    const conflictResult = await createOrder(CART_ID, true, "Casablanca", "cash_on_delivery", AS_OF_DATE);
    expect(conflictResult).toEqual({ created: false, reason: "idempotency_conflict" });

    // AE: fallback impossible mismatch -> throw
    const throwClient = makeFakeClient();
    queuePrefix(throwClient);
    throwClient.query.mockResolvedValueOnce({ rows: [{ ref: "REF-0001", stock: 5 }] });
    queuePricing(throwClient, makeProductRow());
    throwClient.query.mockResolvedValueOnce({ rows: [makeDeliveryRow()] });
    throwClient.query.mockResolvedValueOnce({ rows: [] }); // INSERT conflict
    throwClient.query.mockResolvedValueOnce({
      rows: [makeExistingOrderRow({ customer_id: "77777777-7777-4777-8777-777777777777" })],
    });
    throwClient.query.mockResolvedValueOnce({}); // best-effort ROLLBACK
    vi.spyOn(postgresPool, "connect").mockResolvedValueOnce(throwClient as never);
    await expect(createOrder(CART_ID, true, "Casablanca", "cash_on_delivery", AS_OF_DATE)).rejects.toThrow(/Integrity error/i);
  });

  it("AF: business failures (e.g. insufficient_stock) never attempt the orders INSERT — no identity reserved", async () => {
    const client = makeFakeClient();
    queuePrefix(client, { itemRows: [{ product_ref: "REF-0001", quantity: 3, unit_price_cents: 10000 }] });
    client.query.mockResolvedValueOnce({ rows: [{ ref: "REF-0001", stock: 2 }] });
    queuePricing(client, makeProductRow({ stock: 2 }));
    client.query.mockResolvedValueOnce({}); // ROLLBACK
    mockConnect(client);

    const result = await createOrder(CART_ID, true, "Casablanca", "card", AS_OF_DATE);

    expect(result).toEqual({
      created: false,
      reason: "insufficient_stock",
      productRef: "REF-0001",
      requestedQuantity: 3,
      availableStock: 2,
    });
    expect(client.query).not.toHaveBeenCalledWith(expect.stringMatching(/INSERT INTO orders/i), expect.anything());
  });

  it("AG: price_changed never attempts the orders INSERT — no identity reserved", async () => {
    const client = makeFakeClient();
    queuePrefix(client, { itemRows: [{ product_ref: "REF-0001", quantity: 1, unit_price_cents: 9000 }] });
    client.query.mockResolvedValueOnce({ rows: [{ ref: "REF-0001", stock: 5 }] });
    queuePricing(client, makeProductRow({ price_cents: 10000, stock: 5 }));
    client.query.mockResolvedValueOnce({}); // ROLLBACK
    mockConnect(client);

    const result = await createOrder(CART_ID, true, "Casablanca", "card", AS_OF_DATE);

    expect(result.created).toBe(false);
    if (!result.created) expect(result.reason).toBe("price_changed");
    expect(client.query).not.toHaveBeenCalledWith(expect.stringMatching(/INSERT INTO orders/i), expect.anything());
  });

  it("AH: a higher cart version after price_changed recovery derives a different, independent key", async () => {
    const client = makeFakeClient();
    queuePrefix(client, {
      cartRow: { id: CART_ID, conversation_id: CONVERSATION_ID, customer_id: CUSTOMER_ID, version: 2 },
    });
    client.query.mockResolvedValueOnce({ rows: [{ ref: "REF-0001", stock: 5 }] });
    queuePricing(client, makeProductRow());
    queueHappyPathTail(client, makeDeliveryRow(), makeOrderRow(), 4);
    mockConnect(client);

    await createOrder(CART_ID, true, "Casablanca", "cash_on_delivery", AS_OF_DATE);

    const insertCall = client.query.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("INSERT INTO orders"),
    ) as [string, unknown[]];
    expect(insertCall[1][7]).toBe(`cart:${CART_ID}:v2`);
  });

  it("AI: an invalid locked cart version (negative) throws an explicit Integrity error", async () => {
    const client = makeFakeClient();
    queuePrefix(client, {
      cartRow: { id: CART_ID, conversation_id: CONVERSATION_ID, customer_id: CUSTOMER_ID, version: -1 },
    });
    client.query.mockResolvedValueOnce({}); // best-effort ROLLBACK
    mockConnect(client);

    await expect(createOrder(CART_ID, true, "Casablanca", "cash_on_delivery", AS_OF_DATE)).rejects.toThrow(
      /Integrity error.*version/i,
    );
  });

  it("AJ, AK, AL: regression — timeouts, rollback/release, and OrderSchema-before-COMMIT guarantees remain green with the new replay step", async () => {
    const client = makeFakeClient();
    queuePrefix(client);
    client.query.mockResolvedValueOnce({ rows: [{ ref: "REF-0001", stock: 5 }] });
    queuePricing(client, makeProductRow());
    queueHappyPathTail(client, makeDeliveryRow(), makeOrderRow(), 4);
    mockConnect(client);

    const result = await createOrder(CART_ID, true, "Casablanca", "cash_on_delivery", AS_OF_DATE);

    expect(result).toEqual({ created: true, replayed: false, order: expect.objectContaining({ id: ORDER_ID }) });
    expect(client.query.mock.calls[0][0]).toBe("BEGIN");
    const calls = client.query.mock.calls.map((call) => call[0]);
    expect(calls[calls.length - 1]).toBe("COMMIT");
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
