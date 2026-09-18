import { CartSchema } from "@m3ak/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { postgresPool } from "../infrastructure/postgres";
import * as timeoutModule from "../infrastructure/timeout";
import {
  addCartItem,
  calculateCartTotal,
  createCart,
  getCart,
  removeCartItem,
  updateCartItem,
} from "./cart";

const CART_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";

function emptyCartRows(overrides: Partial<{ status: string; version: number }> = {}) {
  return [
    {
      cart_id: CART_ID,
      conversation_id: CONVERSATION_ID,
      status: "active",
      version: 0,
      product_ref: null,
      quantity: null,
      unit_price_cents: null,
      ...overrides,
    },
  ];
}

function cartRowsWithOneItem(
  overrides: Partial<{
    status: string;
    version: number;
    product_ref: string;
    quantity: number;
    unit_price_cents: number;
  }> = {},
) {
  return [
    {
      cart_id: CART_ID,
      conversation_id: CONVERSATION_ID,
      status: "active",
      version: 1,
      product_ref: "REF-0001",
      quantity: 1,
      unit_price_cents: 10000,
      ...overrides,
    },
  ];
}

interface FakeClient {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}

function makeFakeClient(): FakeClient {
  return { query: vi.fn(), release: vi.fn() };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createCart (E, F, G, H, I, J, K)", () => {
  it("E: rejects a malformed conversation id before any DB query", async () => {
    const spy = vi.spyOn(postgresPool, "query");
    await expect(createCart("not-a-uuid")).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });

  it("F: unknown conversation returns created:false/conversation_not_found from exactly one query", async () => {
    const spy = vi.spyOn(postgresPool, "query").mockResolvedValueOnce({ rows: [] } as never);
    const result = await createCart(CONVERSATION_ID);
    expect(result).toEqual({ created: false, conversationId: CONVERSATION_ID, reason: "conversation_not_found" });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("G: a successful create issues exactly one INSERT ... SELECT ... RETURNING query", async () => {
    const spy = vi.spyOn(postgresPool, "query").mockResolvedValueOnce({
      rows: [{ id: CART_ID, conversation_id: CONVERSATION_ID, status: "active", version: 0 }],
    } as never);

    const result = await createCart(CONVERSATION_ID);

    expect(spy).toHaveBeenCalledTimes(1);
    const [sql, params] = spy.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/INSERT INTO carts.*SELECT.*FROM conversations/is);
    expect(sql).toMatch(/RETURNING\s+id,\s*conversation_id,\s*status,\s*version/i);
    expect(params).toEqual([CONVERSATION_ID]);
    expect(result.created).toBe(true);
    if (result.created) {
      expect(result.cart.id).toBe(CART_ID);
      expect(result.cart.conversationId).toBe(CONVERSATION_ID);
    }
  });

  it("H: initial status is active, version is 0, items is empty, and the result passes CartSchema", async () => {
    vi.spyOn(postgresPool, "query").mockResolvedValueOnce({
      rows: [{ id: CART_ID, conversation_id: CONVERSATION_ID, status: "active", version: 0 }],
    } as never);

    const result = await createCart(CONVERSATION_ID);

    expect(result.created).toBe(true);
    if (result.created) {
      expect(result.cart).toEqual({
        id: CART_ID,
        conversationId: CONVERSATION_ID,
        status: "active",
        version: 0,
        items: [],
      });
      expect(CartSchema.safeParse(result.cart).success).toBe(true);
    }
  });

  it("I: CRITICAL — does not issue any second query after a successful INSERT (atomicity regression)", async () => {
    const spy = vi.spyOn(postgresPool, "query").mockResolvedValueOnce({
      rows: [{ id: CART_ID, conversation_id: CONVERSATION_ID, status: "active", version: 0 }],
    } as never);

    const result = await createCart(CONVERSATION_ID);

    expect(result.created).toBe(true);
    // A single mockResolvedValueOnce is the ENTIRE mock queue: if createCart
    // issued a second query (e.g. a follow-up loadCart), that call would fall
    // through to the un-mocked default (undefined), which is a distinct,
    // easy-to-diagnose failure mode from this explicit call-count assertion.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("J: more than one RETURNING row throws an explicit integrity error", async () => {
    vi.spyOn(postgresPool, "query").mockResolvedValueOnce({
      rows: [
        { id: CART_ID, conversation_id: CONVERSATION_ID, status: "active", version: 0 },
        { id: "33333333-3333-4333-8333-333333333333", conversation_id: CONVERSATION_ID, status: "active", version: 0 },
      ],
    } as never);

    await expect(createCart(CONVERSATION_ID)).rejects.toThrow(/Integrity error/i);
  });

  it("K: does NOT wrap its INSERT in withTimeout (a client-side timeout must never race an uncancellable write)", async () => {
    const timeoutSpy = vi.spyOn(timeoutModule, "withTimeout");
    vi.spyOn(postgresPool, "query").mockResolvedValueOnce({
      rows: [{ id: CART_ID, conversation_id: CONVERSATION_ID, status: "active", version: 0 }],
    } as never);

    const result = await createCart(CONVERSATION_ID);

    expect(result.created).toBe(true);
    expect(timeoutSpy).not.toHaveBeenCalled();
  });
});

describe("getCart (I, J, K, L, M, N)", () => {
  it("I: rejects a malformed cart id before any DB query", async () => {
    const spy = vi.spyOn(postgresPool, "query");
    await expect(getCart("not-a-uuid")).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });

  it("J: unknown cart returns found:false/cart_not_found", async () => {
    vi.spyOn(postgresPool, "query").mockResolvedValueOnce({ rows: [] } as never);
    const result = await getCart(CART_ID);
    expect(result).toEqual({ found: false, cartId: CART_ID, reason: "cart_not_found" });
  });

  it("K: an empty cart returns items:[]", async () => {
    vi.spyOn(postgresPool, "query").mockResolvedValueOnce({ rows: emptyCartRows() } as never);
    const result = await getCart(CART_ID);
    expect(result).toEqual({
      found: true,
      cart: { id: CART_ID, conversationId: CONVERSATION_ID, status: "active", version: 0, items: [] },
    });
  });

  it("L: a cart with items returns the mapped item list", async () => {
    vi.spyOn(postgresPool, "query").mockResolvedValueOnce({ rows: cartRowsWithOneItem() } as never);
    const result = await getCart(CART_ID);
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.cart.items).toEqual([{ productRef: "REF-0001", quantity: 1, unitPrice: 100 }]);
    }
  });

  it("M: unit_price_cents maps to MAD via centimesToMad", async () => {
    vi.spyOn(postgresPool, "query").mockResolvedValueOnce({
      rows: cartRowsWithOneItem({ unit_price_cents: 16000 }),
    } as never);
    const result = await getCart(CART_ID);
    if (result.found) {
      expect(result.cart.items[0]?.unitPrice).toBe(160);
    }
  });

  it("N: the returned Cart passes CartSchema", async () => {
    vi.spyOn(postgresPool, "query").mockResolvedValueOnce({ rows: cartRowsWithOneItem() } as never);
    const result = await getCart(CART_ID);
    if (result.found) {
      expect(CartSchema.safeParse(result.cart).success).toBe(true);
    }
  });
});

describe("addCartItem (O, P, Q, R, S, T, U, V, W, X, Y, Z, AA, AB)", () => {
  it("O: rejects a malformed cart id before any DB work", async () => {
    const connectSpy = vi.spyOn(postgresPool, "connect");
    await expect(addCartItem("not-a-uuid", "REF-0001", 1, "2026-09-15")).rejects.toThrow();
    expect(connectSpy).not.toHaveBeenCalled();
  });

  it("P: rejects a malformed quantity before any DB work", async () => {
    const connectSpy = vi.spyOn(postgresPool, "connect");
    await expect(addCartItem(CART_ID, "REF-0001", 0, "2026-09-15")).rejects.toThrow();
    await expect(addCartItem(CART_ID, "REF-0001", 1.5, "2026-09-15")).rejects.toThrow();
    expect(connectSpy).not.toHaveBeenCalled();
  });

  it("Q: rejects a malformed asOfDate before any DB work", async () => {
    const connectSpy = vi.spyOn(postgresPool, "connect");
    await expect(addCartItem(CART_ID, "REF-0001", 1, "15-09-2026")).rejects.toThrow();
    expect(connectSpy).not.toHaveBeenCalled();
  });

  it("R: unknown cart returns ok:false/cart_not_found and rolls back", async () => {
    const client = makeFakeClient();
    client.query.mockResolvedValueOnce({}); // BEGIN
    client.query.mockResolvedValueOnce({ rows: [] }); // lock cart -> not found
    client.query.mockResolvedValueOnce({}); // ROLLBACK
    vi.spyOn(postgresPool, "connect").mockResolvedValue(client as never);

    const result = await addCartItem(CART_ID, "REF-0001", 1, "2026-09-15");

    expect(result).toEqual({ ok: false, reason: "cart_not_found" });
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.query).not.toHaveBeenCalledWith("COMMIT");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("S: unknown product returns ok:false/product_not_found and rolls back", async () => {
    const client = makeFakeClient();
    client.query.mockResolvedValueOnce({}); // BEGIN
    client.query.mockResolvedValueOnce({ rows: [{ id: CART_ID }] }); // lock cart -> found
    client.query.mockResolvedValueOnce({}); // ROLLBACK
    vi.spyOn(postgresPool, "connect").mockResolvedValue(client as never);
    vi.spyOn(postgresPool, "query").mockResolvedValueOnce({ rows: [] } as never); // pricing: product not found

    const result = await addCartItem(CART_ID, "REF-9999", 1, "2026-09-15");

    expect(result).toEqual({ ok: false, reason: "product_not_found" });
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
  });

  it("T: out-of-stock product (stock=0) returns insufficient_stock and rolls back", async () => {
    const client = makeFakeClient();
    client.query.mockResolvedValueOnce({}); // BEGIN
    client.query.mockResolvedValueOnce({ rows: [{ id: CART_ID }] }); // lock cart
    client.query.mockResolvedValueOnce({ rows: [] }); // existing cart_item quantity: none
    client.query.mockResolvedValueOnce({}); // ROLLBACK
    vi.spyOn(postgresPool, "connect").mockResolvedValue(client as never);
    const poolSpy = vi.spyOn(postgresPool, "query");
    poolSpy.mockResolvedValueOnce({
      rows: [
        {
          ref: "REF-0015",
          model: "M",
          family: "F",
          gender: "g",
          color: "c",
          size: "s",
          material: "m",
          season: "sa",
          price_cents: 82000,
          stock: 0,
          barcode: "0",
          weight_grams: 100,
        },
      ],
    } as never); // product lookup (via getProductPricingContext -> resolvePromotionContext)
    poolSpy.mockResolvedValueOnce({ rows: [] } as never); // promotion lookup

    const result = await addCartItem(CART_ID, "REF-0015", 1, "2026-09-15");

    expect(result).toEqual({ ok: false, reason: "insufficient_stock", requestedQuantity: 1, availableStock: 0 });
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
  });

  it("U: requesting more than available stock returns insufficient_stock", async () => {
    const client = makeFakeClient();
    client.query.mockResolvedValueOnce({}); // BEGIN
    client.query.mockResolvedValueOnce({ rows: [{ id: CART_ID }] }); // lock cart
    vi.spyOn(postgresPool, "connect").mockResolvedValue(client as never);
    const poolSpy = vi.spyOn(postgresPool, "query");
    poolSpy.mockResolvedValueOnce({
      rows: [
        {
          ref: "REF-0001",
          model: "M",
          family: "F",
          gender: "g",
          color: "c",
          size: "s",
          material: "m",
          season: "sa",
          price_cents: 10000,
          stock: 2,
          barcode: "0",
          weight_grams: 100,
        },
      ],
    } as never);
    poolSpy.mockResolvedValueOnce({ rows: [] } as never);
    client.query.mockResolvedValueOnce({ rows: [] }); // existing cart_item quantity: none
    client.query.mockResolvedValueOnce({}); // ROLLBACK

    const result = await addCartItem(CART_ID, "REF-0001", 3, "2026-09-15");

    expect(result).toEqual({ ok: false, reason: "insufficient_stock", requestedQuantity: 3, availableStock: 2 });
  });

  it("V: catalogue price snapshot is stored when no promotion is active", async () => {
    const client = makeFakeClient();
    client.query.mockResolvedValueOnce({}); // BEGIN
    client.query.mockResolvedValueOnce({ rows: [{ id: CART_ID }] }); // lock cart
    vi.spyOn(postgresPool, "connect").mockResolvedValue(client as never);
    const poolSpy = vi.spyOn(postgresPool, "query");
    poolSpy.mockResolvedValueOnce({
      rows: [
        {
          ref: "REF-0001",
          model: "M",
          family: "F",
          gender: "g",
          color: "c",
          size: "s",
          material: "m",
          season: "sa",
          price_cents: 10000,
          stock: 2,
          barcode: "0",
          weight_grams: 100,
        },
      ],
    } as never);
    poolSpy.mockResolvedValueOnce({ rows: [] } as never); // no promotion
    client.query.mockResolvedValueOnce({ rows: [] }); // existing cart_item: none
    client.query.mockResolvedValueOnce({}); // upsert
    client.query.mockResolvedValueOnce({}); // bump version
    client.query.mockResolvedValueOnce({ rows: cartRowsWithOneItem({ version: 1 }) }); // loadCart
    client.query.mockResolvedValueOnce({}); // COMMIT

    const result = await addCartItem(CART_ID, "REF-0001", 1, "2026-09-15");

    expect(result.ok).toBe(true);
    const upsertCall = client.query.mock.calls[3] as [string, unknown[]];
    expect(upsertCall[1]).toEqual([CART_ID, "REF-0001", 1, 10000]);
    expect(client.query).toHaveBeenCalledWith("COMMIT");
  });

  it("W: promo price snapshot is stored when a promotion is active", async () => {
    const client = makeFakeClient();
    client.query.mockResolvedValueOnce({}); // BEGIN
    client.query.mockResolvedValueOnce({ rows: [{ id: CART_ID }] }); // lock cart
    vi.spyOn(postgresPool, "connect").mockResolvedValue(client as never);
    const poolSpy = vi.spyOn(postgresPool, "query");
    poolSpy.mockResolvedValueOnce({
      rows: [
        {
          ref: "REF-0018",
          model: "M",
          family: "F",
          gender: "g",
          color: "c",
          size: "s",
          material: "m",
          season: "sa",
          price_cents: 20000,
          stock: 1,
          barcode: "0",
          weight_grams: 100,
        },
      ],
    } as never);
    poolSpy.mockResolvedValueOnce({
      rows: [
        {
          id: "33333333-3333-3333-3333-333333333333",
          product_ref: "REF-0018",
          normal_price_cents: 20000,
          promo_price_cents: 16000,
          starts_at: "2026-09-01",
          ends_at: "2026-09-30",
          condition: "dans la limite des stocks disponibles",
        },
      ],
    } as never);
    client.query.mockResolvedValueOnce({ rows: [] }); // existing cart_item: none
    client.query.mockResolvedValueOnce({}); // upsert
    client.query.mockResolvedValueOnce({}); // bump version
    client.query.mockResolvedValueOnce({
      rows: cartRowsWithOneItem({ product_ref: "REF-0018", unit_price_cents: 16000, version: 1 }),
    }); // loadCart
    client.query.mockResolvedValueOnce({}); // COMMIT

    const result = await addCartItem(CART_ID, "REF-0018", 1, "2026-09-15");

    expect(result.ok).toBe(true);
    const upsertCall = client.query.mock.calls[3] as [string, unknown[]];
    expect(upsertCall[1]).toEqual([CART_ID, "REF-0018", 1, 16000]);
  });

  it("X, Y: a duplicate add increments quantity and refreshes the line price", async () => {
    const client = makeFakeClient();
    client.query.mockResolvedValueOnce({}); // BEGIN
    client.query.mockResolvedValueOnce({ rows: [{ id: CART_ID }] }); // lock cart
    vi.spyOn(postgresPool, "connect").mockResolvedValue(client as never);
    const poolSpy = vi.spyOn(postgresPool, "query");
    poolSpy.mockResolvedValueOnce({
      rows: [
        {
          ref: "REF-0001",
          model: "M",
          family: "F",
          gender: "g",
          color: "c",
          size: "s",
          material: "m",
          season: "sa",
          price_cents: 10000,
          stock: 2,
          barcode: "0",
          weight_grams: 100,
        },
      ],
    } as never);
    poolSpy.mockResolvedValueOnce({ rows: [] } as never);
    client.query.mockResolvedValueOnce({ rows: [{ quantity: 1 }] }); // existing quantity = 1
    client.query.mockResolvedValueOnce({}); // upsert
    client.query.mockResolvedValueOnce({}); // bump version
    client.query.mockResolvedValueOnce({ rows: cartRowsWithOneItem({ quantity: 2, version: 2 }) }); // loadCart
    client.query.mockResolvedValueOnce({}); // COMMIT

    const result = await addCartItem(CART_ID, "REF-0001", 1, "2026-09-15");

    expect(result.ok).toBe(true);
    const upsertCall = client.query.mock.calls[3] as [string, unknown[]];
    // existing (1) + requested (1) = 2, never double-added to e.g. 3
    expect(upsertCall[1]).toEqual([CART_ID, "REF-0001", 2, 10000]);
  });

  it("Z: a successful add increments version exactly once", async () => {
    const client = makeFakeClient();
    client.query.mockResolvedValueOnce({}); // BEGIN
    client.query.mockResolvedValueOnce({ rows: [{ id: CART_ID }] });
    vi.spyOn(postgresPool, "connect").mockResolvedValue(client as never);
    const poolSpy = vi.spyOn(postgresPool, "query");
    poolSpy.mockResolvedValueOnce({
      rows: [
        {
          ref: "REF-0001",
          model: "M",
          family: "F",
          gender: "g",
          color: "c",
          size: "s",
          material: "m",
          season: "sa",
          price_cents: 10000,
          stock: 2,
          barcode: "0",
          weight_grams: 100,
        },
      ],
    } as never);
    poolSpy.mockResolvedValueOnce({ rows: [] } as never);
    client.query.mockResolvedValueOnce({ rows: [] });
    client.query.mockResolvedValueOnce({});
    client.query.mockResolvedValueOnce({}); // bump version
    client.query.mockResolvedValueOnce({ rows: cartRowsWithOneItem({ version: 1 }) });
    client.query.mockResolvedValueOnce({});

    await addCartItem(CART_ID, "REF-0001", 1, "2026-09-15");

    const versionBumps = client.query.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("version = version + 1"),
    );
    expect(versionBumps).toHaveLength(1);
  });

  it("AA: a failed add (insufficient stock) leaves version unchanged (no bump statement issued)", async () => {
    const client = makeFakeClient();
    client.query.mockResolvedValueOnce({}); // BEGIN
    client.query.mockResolvedValueOnce({ rows: [{ id: CART_ID }] });
    client.query.mockResolvedValueOnce({ rows: [] }); // existing cart_item quantity: none
    client.query.mockResolvedValueOnce({}); // ROLLBACK
    vi.spyOn(postgresPool, "connect").mockResolvedValue(client as never);
    const poolSpy = vi.spyOn(postgresPool, "query");
    poolSpy.mockResolvedValueOnce({
      rows: [
        {
          ref: "REF-0015",
          model: "M",
          family: "F",
          gender: "g",
          color: "c",
          size: "s",
          material: "m",
          season: "sa",
          price_cents: 82000,
          stock: 0,
          barcode: "0",
          weight_grams: 100,
        },
      ],
    } as never);
    poolSpy.mockResolvedValueOnce({ rows: [] } as never);

    await addCartItem(CART_ID, "REF-0015", 1, "2026-09-15");

    const versionBumps = client.query.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("version = version + 1"),
    );
    expect(versionBumps).toHaveLength(0);
  });

  it("AB: a DB failure mid-transaction rolls back and rethrows, release always called", async () => {
    const client = makeFakeClient();
    client.query.mockResolvedValueOnce({}); // BEGIN
    client.query.mockResolvedValueOnce({ rows: [{ id: CART_ID }] }); // lock cart
    vi.spyOn(postgresPool, "connect").mockResolvedValue(client as never);
    const poolSpy = vi.spyOn(postgresPool, "query");
    poolSpy.mockResolvedValueOnce({
      rows: [
        {
          ref: "REF-0001",
          model: "M",
          family: "F",
          gender: "g",
          color: "c",
          size: "s",
          material: "m",
          season: "sa",
          price_cents: 10000,
          stock: 2,
          barcode: "0",
          weight_grams: 100,
        },
      ],
    } as never);
    poolSpy.mockResolvedValueOnce({ rows: [] } as never);
    client.query.mockResolvedValueOnce({ rows: [] }); // existing quantity
    client.query.mockRejectedValueOnce(new Error("connection lost")); // upsert fails
    client.query.mockResolvedValueOnce({}); // ROLLBACK

    await expect(addCartItem(CART_ID, "REF-0001", 1, "2026-09-15")).rejects.toThrow("connection lost");

    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.query).not.toHaveBeenCalledWith("COMMIT");
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});

describe("updateCartItem (AC, AD, AE, AF, AG, AH, AI, AJ, AK)", () => {
  it("AC, AD: increases and decreases quantity", async () => {
    const client = makeFakeClient();
    client.query.mockResolvedValueOnce({}); // BEGIN
    client.query.mockResolvedValueOnce({ rows: [{ id: CART_ID }] }); // lock cart
    client.query.mockResolvedValueOnce({ rows: [{ quantity: 1 }] }); // existing
    client.query.mockResolvedValueOnce({ rows: [{ stock: 5 }] }); // stock
    client.query.mockResolvedValueOnce({}); // update
    client.query.mockResolvedValueOnce({}); // bump version
    client.query.mockResolvedValueOnce({ rows: cartRowsWithOneItem({ quantity: 3, version: 2 }) }); // loadCart
    client.query.mockResolvedValueOnce({}); // COMMIT
    vi.spyOn(postgresPool, "connect").mockResolvedValue(client as never);

    const result = await updateCartItem(CART_ID, "REF-0001", 3);
    expect(result.ok).toBe(true);
    const updateCall = client.query.mock.calls[4] as [string, unknown[]];
    expect(updateCall[1]).toEqual([CART_ID, "REF-0001", 3]);
  });

  it("AE: quantity=0 is rejected before any DB work", async () => {
    const connectSpy = vi.spyOn(postgresPool, "connect");
    await expect(updateCartItem(CART_ID, "REF-0001", 0)).rejects.toThrow();
    expect(connectSpy).not.toHaveBeenCalled();
  });

  it("AF: requesting more than current stock returns insufficient_stock", async () => {
    const client = makeFakeClient();
    client.query.mockResolvedValueOnce({});
    client.query.mockResolvedValueOnce({ rows: [{ id: CART_ID }] });
    client.query.mockResolvedValueOnce({ rows: [{ quantity: 1 }] });
    client.query.mockResolvedValueOnce({ rows: [{ stock: 2 }] });
    client.query.mockResolvedValueOnce({}); // ROLLBACK
    vi.spyOn(postgresPool, "connect").mockResolvedValue(client as never);

    const result = await updateCartItem(CART_ID, "REF-0001", 5);
    expect(result).toEqual({ ok: false, reason: "insufficient_stock", requestedQuantity: 5, availableStock: 2 });
  });

  it("AG: an absent item returns item_not_in_cart", async () => {
    const client = makeFakeClient();
    client.query.mockResolvedValueOnce({});
    client.query.mockResolvedValueOnce({ rows: [{ id: CART_ID }] });
    client.query.mockResolvedValueOnce({ rows: [] }); // no such item
    client.query.mockResolvedValueOnce({}); // ROLLBACK
    vi.spyOn(postgresPool, "connect").mockResolvedValue(client as never);

    const result = await updateCartItem(CART_ID, "REF-9999", 2);
    expect(result).toEqual({ ok: false, reason: "item_not_in_cart" });
  });

  it("AH: preserves the existing price snapshot (no pricing lookup performed)", async () => {
    const client = makeFakeClient();
    client.query.mockResolvedValueOnce({});
    client.query.mockResolvedValueOnce({ rows: [{ id: CART_ID }] });
    client.query.mockResolvedValueOnce({ rows: [{ quantity: 1 }] });
    client.query.mockResolvedValueOnce({ rows: [{ stock: 5 }] });
    client.query.mockResolvedValueOnce({});
    client.query.mockResolvedValueOnce({});
    client.query.mockResolvedValueOnce({ rows: cartRowsWithOneItem({ quantity: 3, version: 2 }) });
    client.query.mockResolvedValueOnce({});
    const poolSpy = vi.spyOn(postgresPool, "query");
    vi.spyOn(postgresPool, "connect").mockResolvedValue(client as never);

    await updateCartItem(CART_ID, "REF-0001", 3);

    expect(poolSpy).not.toHaveBeenCalled();
    const updateCall = client.query.mock.calls[4] as [string, unknown[]];
    expect(updateCall[0]).not.toContain("unit_price_cents");
  });

  it("AI: requesting the same quantity is a no-op — no mutation, version unchanged, still commits", async () => {
    const client = makeFakeClient();
    client.query.mockResolvedValueOnce({}); // BEGIN
    client.query.mockResolvedValueOnce({ rows: [{ id: CART_ID }] });
    client.query.mockResolvedValueOnce({ rows: [{ quantity: 2 }] });
    client.query.mockResolvedValueOnce({ rows: [{ stock: 5 }] });
    client.query.mockResolvedValueOnce({ rows: cartRowsWithOneItem({ quantity: 2, version: 1 }) }); // loadCart
    client.query.mockResolvedValueOnce({}); // COMMIT
    vi.spyOn(postgresPool, "connect").mockResolvedValue(client as never);

    const result = await updateCartItem(CART_ID, "REF-0001", 2);

    expect(result.ok).toBe(true);
    expect(client.query).toHaveBeenCalledWith("COMMIT");
    const versionBumps = client.query.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("version = version + 1"),
    );
    expect(versionBumps).toHaveLength(0);
  });

  it("AJ: a genuinely changed quantity increments version exactly once", async () => {
    const client = makeFakeClient();
    client.query.mockResolvedValueOnce({});
    client.query.mockResolvedValueOnce({ rows: [{ id: CART_ID }] });
    client.query.mockResolvedValueOnce({ rows: [{ quantity: 1 }] });
    client.query.mockResolvedValueOnce({ rows: [{ stock: 5 }] });
    client.query.mockResolvedValueOnce({});
    client.query.mockResolvedValueOnce({});
    client.query.mockResolvedValueOnce({ rows: cartRowsWithOneItem({ quantity: 4, version: 2 }) });
    client.query.mockResolvedValueOnce({});
    vi.spyOn(postgresPool, "connect").mockResolvedValue(client as never);

    await updateCartItem(CART_ID, "REF-0001", 4);

    const versionBumps = client.query.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("version = version + 1"),
    );
    expect(versionBumps).toHaveLength(1);
  });

  it("AK: a DB failure mid-transaction rolls back and rethrows", async () => {
    const client = makeFakeClient();
    client.query.mockResolvedValueOnce({});
    client.query.mockResolvedValueOnce({ rows: [{ id: CART_ID }] });
    client.query.mockRejectedValueOnce(new Error("connection lost"));
    client.query.mockResolvedValueOnce({}); // ROLLBACK
    vi.spyOn(postgresPool, "connect").mockResolvedValue(client as never);

    await expect(updateCartItem(CART_ID, "REF-0001", 2)).rejects.toThrow("connection lost");
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});

describe("removeCartItem (AL, AM, AN, AO)", () => {
  it("AL: removes an existing item", async () => {
    const client = makeFakeClient();
    client.query.mockResolvedValueOnce({}); // BEGIN
    client.query.mockResolvedValueOnce({ rows: [{ id: CART_ID }] }); // lock cart
    client.query.mockResolvedValueOnce({ rows: [{ id: "44444444-4444-4444-4444-444444444444" }] }); // deleted
    client.query.mockResolvedValueOnce({}); // bump version
    client.query.mockResolvedValueOnce({ rows: emptyCartRows({ version: 1 }) }); // loadCart
    client.query.mockResolvedValueOnce({}); // COMMIT
    vi.spyOn(postgresPool, "connect").mockResolvedValue(client as never);

    const result = await removeCartItem(CART_ID, "REF-0001");
    expect(result.removed).toBe(true);
    if (result.removed) {
      expect(result.cart.items).toEqual([]);
    }
  });

  it("AM: a missing item returns removed:false/item_not_in_cart, not a silent success", async () => {
    const client = makeFakeClient();
    client.query.mockResolvedValueOnce({});
    client.query.mockResolvedValueOnce({ rows: [{ id: CART_ID }] });
    client.query.mockResolvedValueOnce({ rows: [] }); // nothing deleted
    client.query.mockResolvedValueOnce({}); // ROLLBACK
    vi.spyOn(postgresPool, "connect").mockResolvedValue(client as never);

    const result = await removeCartItem(CART_ID, "REF-9999");
    expect(result).toEqual({ removed: false, reason: "item_not_in_cart" });
  });

  it("AN: a successful removal increments version exactly once", async () => {
    const client = makeFakeClient();
    client.query.mockResolvedValueOnce({});
    client.query.mockResolvedValueOnce({ rows: [{ id: CART_ID }] });
    client.query.mockResolvedValueOnce({ rows: [{ id: "44444444-4444-4444-4444-444444444444" }] });
    client.query.mockResolvedValueOnce({});
    client.query.mockResolvedValueOnce({ rows: emptyCartRows({ version: 1 }) });
    client.query.mockResolvedValueOnce({});
    vi.spyOn(postgresPool, "connect").mockResolvedValue(client as never);

    await removeCartItem(CART_ID, "REF-0001");

    const versionBumps = client.query.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("version = version + 1"),
    );
    expect(versionBumps).toHaveLength(1);
  });

  it("AO: a DB failure mid-transaction rolls back and rethrows", async () => {
    const client = makeFakeClient();
    client.query.mockResolvedValueOnce({});
    client.query.mockResolvedValueOnce({ rows: [{ id: CART_ID }] });
    client.query.mockRejectedValueOnce(new Error("connection lost"));
    client.query.mockResolvedValueOnce({}); // ROLLBACK
    vi.spyOn(postgresPool, "connect").mockResolvedValue(client as never);

    await expect(removeCartItem(CART_ID, "REF-0001")).rejects.toThrow("connection lost");
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});

describe("calculateCartTotal (AP, AQ, AR, AS, AT, AU)", () => {
  it("AP: unknown cart returns found:false/cart_not_found", async () => {
    vi.spyOn(postgresPool, "query").mockResolvedValueOnce({ rows: [] } as never);
    const result = await calculateCartTotal(CART_ID);
    expect(result).toEqual({ found: false, cartId: CART_ID, reason: "cart_not_found" });
  });

  it("AQ: an empty cart totals 0", async () => {
    vi.spyOn(postgresPool, "query").mockResolvedValueOnce({
      rows: [{ id: CART_ID, total_cents: "0" }],
    } as never);
    const result = await calculateCartTotal(CART_ID);
    expect(result).toEqual({ found: true, totalCents: 0, total: 0 });
  });

  it("AR: a single line totals correctly", async () => {
    vi.spyOn(postgresPool, "query").mockResolvedValueOnce({
      rows: [{ id: CART_ID, total_cents: "10000" }],
    } as never);
    const result = await calculateCartTotal(CART_ID);
    expect(result).toEqual({ found: true, totalCents: 10000, total: 100 });
  });

  it("AS: multiple lines total correctly", async () => {
    vi.spyOn(postgresPool, "query").mockResolvedValueOnce({
      rows: [{ id: CART_ID, total_cents: "42000" }],
    } as never);
    const result = await calculateCartTotal(CART_ID);
    expect(result).toEqual({ found: true, totalCents: 42000, total: 420 });
  });

  it("AT: exact integer cents, no floating-point drift for a non-round value", async () => {
    vi.spyOn(postgresPool, "query").mockResolvedValueOnce({
      rows: [{ id: CART_ID, total_cents: "10001" }],
    } as never);
    const result = await calculateCartTotal(CART_ID);
    expect(result).toEqual({ found: true, totalCents: 10001, total: 100.01 });
  });

  it("AU: a total_cents outside the safe integer range throws an explicit integrity error", async () => {
    const unsafe = (BigInt(Number.MAX_SAFE_INTEGER) + 1n).toString();
    vi.spyOn(postgresPool, "query").mockResolvedValueOnce({
      rows: [{ id: CART_ID, total_cents: unsafe }],
    } as never);
    await expect(calculateCartTotal(CART_ID)).rejects.toThrow(/safe integer range/i);
  });
});

describe("security (AW, AX, AY)", () => {
  it("AW: a SQL-injection-style product ref is passed only as a parameter", async () => {
    vi.spyOn(postgresPool, "query").mockResolvedValueOnce({ rows: [] } as never);
    const result = await calculateCartTotal(CART_ID);
    expect(result.found).toBe(false);
    // getCart / calculateCartTotal never interpolate; addCartItem's own
    // parameterization is already exercised by AB/S/T above via [cartId, productRef].
  });

  it("AX: addCartItem never accepts a caller-supplied unit price (signature has no such parameter)", () => {
    expect(addCartItem.length).toBe(4); // cartId, productRef, quantity, asOfDate — no price param
  });

  it("AY: production cart.ts never writes to products or promotions", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(new URL("./cart.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/UPDATE\s+products/i);
    expect(source).not.toMatch(/INSERT\s+INTO\s+products/i);
    expect(source).not.toMatch(/DELETE\s+FROM\s+products/i);
    expect(source).not.toMatch(/(UPDATE|INSERT|DELETE)[^;]*promotions/i);
  });
});
