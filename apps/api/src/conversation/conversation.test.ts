import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../cart/cart", () => ({
  getCart: vi.fn(),
}));

import { getCart } from "../cart/cart";
import { postgresPool } from "../infrastructure/postgres";
import { loadConversationContext, persistConversation } from "./conversation";

const mockedGetCart = vi.mocked(getCart);

const THREAD_ID = "thread-abc-123";
const CONVERSATION_ID = "11111111-1111-4111-8111-111111111111";
const CUSTOMER_ID = "22222222-2222-4222-8222-222222222222";
const CART_ID = "33333333-3333-4333-8333-333333333333";
const ESCALATION_ID = "44444444-4444-4444-8444-444444444444";

interface FakeClient {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}

function makeFakeClient(): FakeClient {
  return { query: vi.fn(), release: vi.fn() };
}

function makeConversationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CONVERSATION_ID,
    customer_id: CUSTOMER_ID,
    status: "active",
    language: "french",
    created_at: new Date("2026-09-18T10:00:00.000Z"),
    updated_at: new Date("2026-09-19T12:00:00.000Z"),
    ...overrides,
  };
}

function makeMessageRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    conversation_id: CONVERSATION_ID,
    role: "customer",
    content: "Bghit veste",
    created_at: new Date("2026-09-18T10:00:00.000Z"),
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  // restoreAllMocks() undoes vi.spyOn() wrappers (postgresPool.*), but the
  // persistent vi.mock("../cart/cart") factory mock is not a spy — its
  // queued mockResolvedValueOnce/call history must be cleared separately.
  mockedGetCart.mockReset();
});

describe("loadConversationContext — found (1, 2, 6, 7)", () => {
  it("1/2/6/7: maps conversation/customer/language/messages through the shared schemas", async () => {
    const spy = vi.spyOn(postgresPool, "query");
    spy.mockResolvedValueOnce({ rows: [makeConversationRow()] }); // conversation
    spy.mockResolvedValueOnce({ rows: [makeMessageRow()] }); // messages
    spy.mockResolvedValueOnce({ rows: [] }); // cart
    spy.mockResolvedValueOnce({ rows: [] }); // escalation

    const result = await loadConversationContext(THREAD_ID);

    expect(result).toEqual({
      found: true,
      conversation: {
        id: CONVERSATION_ID,
        customerId: CUSTOMER_ID,
        status: "active",
        language: "french",
        createdAt: "2026-09-18T10:00:00.000Z",
        updatedAt: "2026-09-19T12:00:00.000Z",
      },
      messages: [
        {
          id: "55555555-5555-4555-8555-555555555555",
          conversationId: CONVERSATION_ID,
          role: "customer",
          content: "Bghit veste",
          createdAt: "2026-09-18T10:00:00.000Z",
        },
      ],
      cart: null,
      escalationId: null,
    });
  });
});

describe("loadConversationContext — unknown thread (3, 4)", () => {
  it("3/4: returns {found:false} and performs no further queries", async () => {
    const spy = vi.spyOn(postgresPool, "query").mockResolvedValueOnce({ rows: [] });

    const result = await loadConversationContext(THREAD_ID);

    expect(result).toEqual({ found: false });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("loadConversationContext — message ordering (5)", () => {
  it("5: the messages query orders by created_at then id, ascending", async () => {
    const spy = vi.spyOn(postgresPool, "query");
    spy.mockResolvedValueOnce({ rows: [makeConversationRow()] });
    spy.mockResolvedValueOnce({ rows: [] });
    spy.mockResolvedValueOnce({ rows: [] });
    spy.mockResolvedValueOnce({ rows: [] });

    await loadConversationContext(THREAD_ID);

    const messagesSql = String(spy.mock.calls[1]?.[0]);
    expect(messagesSql).toMatch(/ORDER BY\s+created_at\s+ASC,\s*id\s+ASC/i);
  });
});

describe("loadConversationContext — active cart lookup (8, 9, 10, 11)", () => {
  it("8/9: queries carts filtered to the real active status", async () => {
    const spy = vi.spyOn(postgresPool, "query");
    spy.mockResolvedValueOnce({ rows: [makeConversationRow()] });
    spy.mockResolvedValueOnce({ rows: [] });
    spy.mockResolvedValueOnce({ rows: [] }); // no active cart
    spy.mockResolvedValueOnce({ rows: [] });

    await loadConversationContext(THREAD_ID);

    const cartSql = String(spy.mock.calls[2]?.[0]);
    expect(cartSql).toContain("carts");
    expect(cartSql).toContain("status = 'active'");
  });

  it("10: reuses the existing getCart() and maps the exact snapshot shape", async () => {
    const spy = vi.spyOn(postgresPool, "query");
    spy.mockResolvedValueOnce({ rows: [makeConversationRow()] });
    spy.mockResolvedValueOnce({ rows: [] });
    spy.mockResolvedValueOnce({ rows: [{ id: CART_ID }] });
    spy.mockResolvedValueOnce({ rows: [] });
    mockedGetCart.mockResolvedValueOnce({
      found: true,
      cart: {
        id: CART_ID, conversationId: CONVERSATION_ID, status: "active", version: 2,
        items: [{ productRef: "REF-001", quantity: 2, unitPrice: 199.95 }],
      },
    });

    const result = await loadConversationContext(THREAD_ID);

    expect(mockedGetCart).toHaveBeenCalledWith(CART_ID);
    expect(result).toMatchObject({
      cart: { id: CART_ID, version: 2, items: [{ productRef: "REF-001", quantity: 2, unitPrice: 199.95 }] },
    });
  });

  it("11: no cart row -> cart is null", async () => {
    const spy = vi.spyOn(postgresPool, "query");
    spy.mockResolvedValueOnce({ rows: [makeConversationRow()] });
    spy.mockResolvedValueOnce({ rows: [] });
    spy.mockResolvedValueOnce({ rows: [] });
    spy.mockResolvedValueOnce({ rows: [] });

    const result = await loadConversationContext(THREAD_ID);

    expect(result).toMatchObject({ cart: null });
    expect(mockedGetCart).not.toHaveBeenCalled();
  });
});

describe("loadConversationContext — open escalation (12, 13)", () => {
  it("12: rehydrates an existing open escalation id", async () => {
    const spy = vi.spyOn(postgresPool, "query");
    spy.mockResolvedValueOnce({ rows: [makeConversationRow()] });
    spy.mockResolvedValueOnce({ rows: [] });
    spy.mockResolvedValueOnce({ rows: [] });
    spy.mockResolvedValueOnce({ rows: [{ id: ESCALATION_ID }] });

    const result = await loadConversationContext(THREAD_ID);

    expect(result).toMatchObject({ escalationId: ESCALATION_ID });
  });

  it("13: no open escalation -> null", async () => {
    const spy = vi.spyOn(postgresPool, "query");
    spy.mockResolvedValueOnce({ rows: [makeConversationRow()] });
    spy.mockResolvedValueOnce({ rows: [] });
    spy.mockResolvedValueOnce({ rows: [] });
    spy.mockResolvedValueOnce({ rows: [] });

    const result = await loadConversationContext(THREAD_ID);

    expect(result).toMatchObject({ escalationId: null });
  });
});

describe("loadConversationContext — errors and no client checkout (14, 15)", () => {
  it("14: a DB failure propagates unchanged", async () => {
    vi.spyOn(postgresPool, "query").mockRejectedValueOnce(new Error("connection reset"));

    await expect(loadConversationContext(THREAD_ID)).rejects.toThrow("connection reset");
  });

  it("15: loadConversationContext never checks out a dedicated client (read-only, no release concern)", async () => {
    const connectSpy = vi.spyOn(postgresPool, "connect");
    const spy = vi.spyOn(postgresPool, "query");
    spy.mockResolvedValueOnce({ rows: [makeConversationRow()] });
    spy.mockResolvedValueOnce({ rows: [] });
    spy.mockResolvedValueOnce({ rows: [] });
    spy.mockResolvedValueOnce({ rows: [] });

    await loadConversationContext(THREAD_ID);

    expect(connectSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

function queuePersistPrefix(
  client: FakeClient,
  options: { currentStatus?: string; updatedStatus?: string; dbMessageCount?: number } = {},
) {
  const currentStatus = options.currentStatus ?? "active";
  const updatedStatus = options.updatedStatus ?? currentStatus;
  client.query.mockResolvedValueOnce({}); // BEGIN
  client.query.mockResolvedValueOnce({ rows: [{ id: CONVERSATION_ID, status: currentStatus }] }); // lock
  client.query.mockResolvedValueOnce({ rows: [makeConversationRow({ status: updatedStatus })] }); // UPDATE ... RETURNING
  client.query.mockResolvedValueOnce({ rows: [{ count: String(options.dbMessageCount ?? 0) }] }); // COUNT
}

describe("persistConversation — transaction shape (1, 2, 3)", () => {
  it("1/2/3: BEGIN then locks the conversation first with valid WHERE id = $1 FOR UPDATE syntax", async () => {
    const client = makeFakeClient();
    vi.spyOn(postgresPool, "connect").mockResolvedValue(client as never);
    queuePersistPrefix(client);
    client.query.mockResolvedValueOnce({}); // COMMIT

    await persistConversation(CONVERSATION_ID, "french", false, []);

    expect(client.query.mock.calls[0]?.[0]).toBe("BEGIN");
    const lockSql = String(client.query.mock.calls[1]?.[0]);
    expect(lockSql).toMatch(/WHERE\s+id\s*=\s*\$1\s+FOR\s+UPDATE/i);
    expect(lockSql).toContain("conversations");
  });
});

describe("persistConversation — conversation not found (4)", () => {
  it("4: rolls back and returns the controlled result", async () => {
    const client = makeFakeClient();
    vi.spyOn(postgresPool, "connect").mockResolvedValue(client as never);
    client.query.mockResolvedValueOnce({}); // BEGIN
    client.query.mockResolvedValueOnce({ rows: [] }); // lock -> not found
    client.query.mockResolvedValueOnce({}); // ROLLBACK

    const result = await persistConversation(CONVERSATION_ID, "french", false, []);

    expect(result).toEqual({ persisted: false, reason: "conversation_not_found" });
    expect(client.query.mock.calls[2]?.[0]).toBe("ROLLBACK");
  });
});

describe("persistConversation — status rules (5-9)", () => {
  it("5: active + no escalation stays active", async () => {
    const client = makeFakeClient();
    vi.spyOn(postgresPool, "connect").mockResolvedValue(client as never);
    queuePersistPrefix(client, { currentStatus: "active", updatedStatus: "active" });
    client.query.mockResolvedValueOnce({});

    await persistConversation(CONVERSATION_ID, "french", false, []);

    expect(client.query.mock.calls[2]?.[1]).toEqual([CONVERSATION_ID, "french", "active"]);
  });

  it("6: active + open escalation becomes escalated", async () => {
    const client = makeFakeClient();
    vi.spyOn(postgresPool, "connect").mockResolvedValue(client as never);
    queuePersistPrefix(client, { currentStatus: "active", updatedStatus: "escalated" });
    client.query.mockResolvedValueOnce({});

    await persistConversation(CONVERSATION_ID, "french", true, []);

    expect(client.query.mock.calls[2]?.[1]).toEqual([CONVERSATION_ID, "french", "escalated"]);
  });

  it("7: escalated is never downgraded back to active", async () => {
    const client = makeFakeClient();
    vi.spyOn(postgresPool, "connect").mockResolvedValue(client as never);
    queuePersistPrefix(client, { currentStatus: "escalated", updatedStatus: "escalated" });
    client.query.mockResolvedValueOnce({});

    await persistConversation(CONVERSATION_ID, "french", false, []);

    expect(client.query.mock.calls[2]?.[1]).toEqual([CONVERSATION_ID, "french", "escalated"]);
  });

  it("8: completed is never downgraded to active", async () => {
    const client = makeFakeClient();
    vi.spyOn(postgresPool, "connect").mockResolvedValue(client as never);
    queuePersistPrefix(client, { currentStatus: "completed", updatedStatus: "completed" });
    client.query.mockResolvedValueOnce({});

    await persistConversation(CONVERSATION_ID, "french", false, []);

    expect(client.query.mock.calls[2]?.[1]).toEqual([CONVERSATION_ID, "french", "completed"]);
  });

  it("9: completed + a REAL open escalation becomes escalated (allowed — a real business fact)", async () => {
    const client = makeFakeClient();
    vi.spyOn(postgresPool, "connect").mockResolvedValue(client as never);
    queuePersistPrefix(client, { currentStatus: "completed", updatedStatus: "escalated" });
    client.query.mockResolvedValueOnce({});

    await persistConversation(CONVERSATION_ID, "french", true, []);

    expect(client.query.mock.calls[2]?.[1]).toEqual([CONVERSATION_ID, "french", "escalated"]);
  });
});

describe("persistConversation — language / updated_at (10, 11)", () => {
  it("10/11: the UPDATE writes language and refreshes updated_at via now()", async () => {
    const client = makeFakeClient();
    vi.spyOn(postgresPool, "connect").mockResolvedValue(client as never);
    queuePersistPrefix(client);
    client.query.mockResolvedValueOnce({});

    await persistConversation(CONVERSATION_ID, "darija", false, []);

    const updateSql = String(client.query.mock.calls[2]?.[0]);
    expect(updateSql).toContain("SET language = $2");
    expect(updateSql).toContain("updated_at = now()");
    expect(client.query.mock.calls[2]?.[1]).toEqual([CONVERSATION_ID, "darija", "active"]);
  });
});

describe("persistConversation — message tail insertion (12-16)", () => {
  it("12/13/14: only the tail beyond dbCount is inserted, in order", async () => {
    const client = makeFakeClient();
    vi.spyOn(postgresPool, "connect").mockResolvedValue(client as never);
    queuePersistPrefix(client, { dbMessageCount: 1 });
    client.query.mockResolvedValueOnce({}); // insert #1
    client.query.mockResolvedValueOnce({}); // insert #2
    client.query.mockResolvedValueOnce({}); // COMMIT

    const messages = [
      { role: "customer" as const, content: "already persisted" },
      { role: "assistant" as const, content: "second message" },
      { role: "customer" as const, content: "third message" },
    ];
    const result = await persistConversation(CONVERSATION_ID, "french", false, messages);

    expect(result).toMatchObject({ persisted: true, newMessageCount: 2 });
    expect(client.query.mock.calls[4]?.[0]).toContain("INSERT INTO messages");
    expect(client.query.mock.calls[4]?.[1]).toEqual([CONVERSATION_ID, "assistant", "second message"]);
    expect(client.query.mock.calls[5]?.[1]).toEqual([CONVERSATION_ID, "customer", "third message"]);
  });

  it("15: dbCount equals cumulative length -> zero inserts", async () => {
    const client = makeFakeClient();
    vi.spyOn(postgresPool, "connect").mockResolvedValue(client as never);
    queuePersistPrefix(client, { dbMessageCount: 2 });
    client.query.mockResolvedValueOnce({}); // COMMIT

    const messages = [
      { role: "customer" as const, content: "one" },
      { role: "assistant" as const, content: "two" },
    ];
    const result = await persistConversation(CONVERSATION_ID, "french", false, messages);

    expect(result).toMatchObject({ persisted: true, newMessageCount: 0 });
    const insertCalls = client.query.mock.calls.filter((call) => String(call[0]).includes("INSERT"));
    expect(insertCalls).toHaveLength(0);
  });

  it("16: dbCount greater than cumulative length throws a controlled invariant error, never truncates/rewrites", async () => {
    const client = makeFakeClient();
    vi.spyOn(postgresPool, "connect").mockResolvedValue(client as never);
    queuePersistPrefix(client, { dbMessageCount: 5 });
    client.query.mockResolvedValueOnce({}); // best-effort ROLLBACK

    await expect(
      persistConversation(CONVERSATION_ID, "french", false, [{ role: "customer", content: "only one" }]),
    ).rejects.toThrow("conversation_message_history_mismatch");
    const insertCalls = client.query.mock.calls.filter((call) => String(call[0]).includes("INSERT"));
    expect(insertCalls).toHaveLength(0);
  });
});

describe("persistConversation — input validation (17, 18, 19)", () => {
  it("17: rejects a malformed conversation id before acquiring a client", async () => {
    const spy = vi.spyOn(postgresPool, "connect");
    await expect(persistConversation("not-a-uuid", "french", false, [])).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });

  it("18: rejects an invalid language before acquiring a client", async () => {
    const spy = vi.spyOn(postgresPool, "connect");
    await expect(persistConversation(CONVERSATION_ID, "spanish", false, [])).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });

  it("19: rejects an invalid message (bad role, blank content) before acquiring a client", async () => {
    const spy = vi.spyOn(postgresPool, "connect");
    await expect(
      persistConversation(CONVERSATION_ID, "french", false, [{ role: "system", content: "x" }]),
    ).rejects.toThrow();
    await expect(
      persistConversation(CONVERSATION_ID, "french", false, [{ role: "customer", content: "" }]),
    ).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("persistConversation — DB failure propagation (20, 21, 22)", () => {
  it("20/21/22: a DB failure propagates, rollback is attempted, and the client is always released", async () => {
    const client = makeFakeClient();
    vi.spyOn(postgresPool, "connect").mockResolvedValue(client as never);
    client.query.mockResolvedValueOnce({}); // BEGIN
    client.query.mockRejectedValueOnce(new Error("connection reset by peer")); // lock fails
    client.query.mockResolvedValueOnce({}); // best-effort ROLLBACK

    await expect(persistConversation(CONVERSATION_ID, "french", false, [])).rejects.toThrow("connection reset by peer");
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});

describe("persistConversation — no unrelated writes (23, 24, 25)", () => {
  it("23/24/25: only touches conversations and messages — never carts, escalations, orders, customers, or checkpoint tables", async () => {
    const client = makeFakeClient();
    vi.spyOn(postgresPool, "connect").mockResolvedValue(client as never);
    queuePersistPrefix(client, { dbMessageCount: 0 });
    client.query.mockResolvedValueOnce({}); // insert
    client.query.mockResolvedValueOnce({}); // COMMIT

    await persistConversation(CONVERSATION_ID, "french", false, [{ role: "customer", content: "hello" }]);

    const allSql = client.query.mock.calls.map((call) => String(call[0]));
    expect(allSql.some((sql) => /\b(carts|cart_items|escalations|orders|order_items|customers|checkpoints?)\b/i.test(sql))).toBe(
      false,
    );
  });
});
