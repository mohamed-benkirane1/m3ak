import { afterEach, describe, expect, it, vi } from "vitest";
import { postgresPool } from "../infrastructure/postgres";
import { getCustomerMemory } from "./customerMemory";

const CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_CUSTOMER_ID = "22222222-2222-4222-8222-222222222222";

function emptyResult() {
  return { rows: [] };
}

function customerRow(overrides: Record<string, unknown> = {}) {
  return { rows: [{ city: "Casablanca", preferred_language: "darija", ...overrides }] };
}

function countRow(count: number) {
  return { rows: [{ count: String(count) }] };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getCustomerMemory — input validation", () => {
  it("rejects a malformed customer id before issuing any query", async () => {
    const spy = vi.spyOn(postgresPool, "query");

    await expect(getCustomerMemory("not-a-uuid")).rejects.toThrow();

    expect(spy).not.toHaveBeenCalled();
  });
});

describe("getCustomerMemory — customer not found (3)", () => {
  it("3: returns found:false without querying orders/historical_orders", async () => {
    const spy = vi.spyOn(postgresPool, "query").mockResolvedValueOnce(emptyResult());

    const result = await getCustomerMemory(CUSTOMER_ID);

    expect(result).toEqual({ found: false });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]?.[0])).toContain("FROM customers");
  });
});

describe("getCustomerMemory — strict customerId scoping (1, 2)", () => {
  it("1: every query is scoped by the exact given customerId", async () => {
    const spy = vi
      .spyOn(postgresPool, "query")
      .mockResolvedValueOnce(customerRow())
      .mockResolvedValueOnce(emptyResult())
      .mockResolvedValueOnce(emptyResult())
      .mockResolvedValueOnce(countRow(0))
      .mockResolvedValueOnce(countRow(0))
      .mockResolvedValueOnce(emptyResult());

    await getCustomerMemory(CUSTOMER_ID);

    for (const call of spy.mock.calls) {
      const params = call[1] as unknown[];
      expect(params).toContain(CUSTOMER_ID);
      expect(params).not.toContain(OTHER_CUSTOMER_ID);
    }
  });

  it("2: two different customerIds never cross-contaminate (isolation)", async () => {
    vi.spyOn(postgresPool, "query")
      .mockResolvedValueOnce(customerRow({ city: "Rabat", preferred_language: "french" }))
      .mockResolvedValueOnce(emptyResult())
      .mockResolvedValueOnce(emptyResult())
      .mockResolvedValueOnce(countRow(0))
      .mockResolvedValueOnce(countRow(0))
      .mockResolvedValueOnce(emptyResult());
    const resultA = await getCustomerMemory(CUSTOMER_ID);

    vi.spyOn(postgresPool, "query")
      .mockResolvedValueOnce(customerRow({ city: "Marrakech", preferred_language: "arabic" }))
      .mockResolvedValueOnce(emptyResult())
      .mockResolvedValueOnce(emptyResult())
      .mockResolvedValueOnce(countRow(0))
      .mockResolvedValueOnce(countRow(0))
      .mockResolvedValueOnce(emptyResult());
    const resultB = await getCustomerMemory(OTHER_CUSTOMER_ID);

    expect(resultA).toMatchObject({ found: true, memory: { city: "Rabat", preferredLanguage: "french" } });
    expect(resultB).toMatchObject({ found: true, memory: { city: "Marrakech", preferredLanguage: "arabic" } });
  });
});

describe("getCustomerMemory — error propagation (4)", () => {
  it("4: a genuine DB/programmer error propagates unchanged, never swallowed", async () => {
    vi.spyOn(postgresPool, "query").mockRejectedValueOnce(new Error("connection reset by peer"));

    await expect(getCustomerMemory(CUSTOMER_ID)).rejects.toThrow("connection reset by peer");
  });
});

describe("getCustomerMemory — city precedence (5)", () => {
  it("5a: a live order's city wins over historical and customers.city", async () => {
    vi.spyOn(postgresPool, "query")
      .mockResolvedValueOnce(customerRow({ city: "StaleCity" }))
      .mockResolvedValueOnce({ rows: [{ city: "LiveCity", created_at: new Date("2026-09-10T00:00:00.000Z") }] })
      .mockResolvedValueOnce({ rows: [{ city: "HistoricalCity", order_date: new Date("2026-01-01T00:00:00.000Z") }] })
      .mockResolvedValueOnce(countRow(1))
      .mockResolvedValueOnce(countRow(1))
      .mockResolvedValueOnce(emptyResult());

    const result = await getCustomerMemory(CUSTOMER_ID);

    expect(result).toMatchObject({ found: true, memory: { city: "LiveCity" } });
  });

  it("5b: no live order -> historical order city wins over customers.city", async () => {
    vi.spyOn(postgresPool, "query")
      .mockResolvedValueOnce(customerRow({ city: "StaleCity" }))
      .mockResolvedValueOnce(emptyResult())
      .mockResolvedValueOnce({ rows: [{ city: "HistoricalCity", order_date: new Date("2026-01-01T00:00:00.000Z") }] })
      .mockResolvedValueOnce(countRow(0))
      .mockResolvedValueOnce(countRow(1))
      .mockResolvedValueOnce(emptyResult());

    const result = await getCustomerMemory(CUSTOMER_ID);

    expect(result).toMatchObject({ found: true, memory: { city: "HistoricalCity" } });
  });

  it("5c: no order anywhere -> falls back to customers.city", async () => {
    vi.spyOn(postgresPool, "query")
      .mockResolvedValueOnce(customerRow({ city: "OnlyKnownCity" }))
      .mockResolvedValueOnce(emptyResult())
      .mockResolvedValueOnce(emptyResult())
      .mockResolvedValueOnce(countRow(0))
      .mockResolvedValueOnce(countRow(0))
      .mockResolvedValueOnce(emptyResult());

    const result = await getCustomerMemory(CUSTOMER_ID);

    expect(result).toMatchObject({ found: true, memory: { city: "OnlyKnownCity" } });
  });

  it("5d: nothing known anywhere -> city is null, never invented", async () => {
    vi.spyOn(postgresPool, "query")
      .mockResolvedValueOnce(customerRow({ city: null }))
      .mockResolvedValueOnce(emptyResult())
      .mockResolvedValueOnce(emptyResult())
      .mockResolvedValueOnce(countRow(0))
      .mockResolvedValueOnce(countRow(0))
      .mockResolvedValueOnce(emptyResult());

    const result = await getCustomerMemory(CUSTOMER_ID);

    expect(result).toMatchObject({ found: true, memory: { city: null } });
  });
});

describe("getCustomerMemory — preferredLanguage (passthrough, including unknown)", () => {
  it("returns customers.preferred_language as-is, including the literal 'unknown' value", async () => {
    vi.spyOn(postgresPool, "query")
      .mockResolvedValueOnce(customerRow({ preferred_language: "unknown" }))
      .mockResolvedValueOnce(emptyResult())
      .mockResolvedValueOnce(emptyResult())
      .mockResolvedValueOnce(countRow(0))
      .mockResolvedValueOnce(countRow(0))
      .mockResolvedValueOnce(emptyResult());

    const result = await getCustomerMemory(CUSTOMER_ID);

    expect(result).toMatchObject({ found: true, memory: { preferredLanguage: "unknown" } });
  });

  it("returns null when customers.preferred_language is null", async () => {
    vi.spyOn(postgresPool, "query")
      .mockResolvedValueOnce(customerRow({ preferred_language: null }))
      .mockResolvedValueOnce(emptyResult())
      .mockResolvedValueOnce(emptyResult())
      .mockResolvedValueOnce(countRow(0))
      .mockResolvedValueOnce(countRow(0))
      .mockResolvedValueOnce(emptyResult());

    const result = await getCustomerMemory(CUSTOMER_ID);

    expect(result).toMatchObject({ found: true, memory: { preferredLanguage: null } });
  });
});

describe("getCustomerMemory — totalKnownOrders (6)", () => {
  it("6: sums live and historical order counts from the real tables", async () => {
    vi.spyOn(postgresPool, "query")
      .mockResolvedValueOnce(customerRow())
      .mockResolvedValueOnce(emptyResult())
      .mockResolvedValueOnce(emptyResult())
      .mockResolvedValueOnce(countRow(4))
      .mockResolvedValueOnce(countRow(7))
      .mockResolvedValueOnce(emptyResult());

    const result = await getCustomerMemory(CUSTOMER_ID);

    expect(result).toMatchObject({ found: true, memory: { totalKnownOrders: 11 } });
  });
});

describe("getCustomerMemory — latestOrderDate (7)", () => {
  it("7a: picks the true latest date across live and historical sources (live wins here)", async () => {
    vi.spyOn(postgresPool, "query")
      .mockResolvedValueOnce(customerRow())
      .mockResolvedValueOnce({ rows: [{ city: "X", created_at: new Date("2026-09-15T12:00:00.000Z") }] })
      .mockResolvedValueOnce({ rows: [{ city: "Y", order_date: new Date("2026-02-01T00:00:00.000Z") }] })
      .mockResolvedValueOnce(countRow(1))
      .mockResolvedValueOnce(countRow(1))
      .mockResolvedValueOnce(emptyResult());

    const result = await getCustomerMemory(CUSTOMER_ID);

    expect(result).toMatchObject({ found: true, memory: { latestOrderDate: "2026-09-15T12:00:00.000Z" } });
  });

  it("7b: picks the historical date when it is actually more recent than the live one", async () => {
    vi.spyOn(postgresPool, "query")
      .mockResolvedValueOnce(customerRow())
      .mockResolvedValueOnce({ rows: [{ city: "X", created_at: new Date("2025-01-01T00:00:00.000Z") }] })
      .mockResolvedValueOnce({ rows: [{ city: "Y", order_date: new Date("2026-08-01T00:00:00.000Z") }] })
      .mockResolvedValueOnce(countRow(1))
      .mockResolvedValueOnce(countRow(1))
      .mockResolvedValueOnce(emptyResult());

    const result = await getCustomerMemory(CUSTOMER_ID);

    expect(result).toMatchObject({ found: true, memory: { latestOrderDate: "2026-08-01T00:00:00.000Z" } });
  });

  it("7c: null when no order exists anywhere", async () => {
    vi.spyOn(postgresPool, "query")
      .mockResolvedValueOnce(customerRow())
      .mockResolvedValueOnce(emptyResult())
      .mockResolvedValueOnce(emptyResult())
      .mockResolvedValueOnce(countRow(0))
      .mockResolvedValueOnce(countRow(0))
      .mockResolvedValueOnce(emptyResult());

    const result = await getCustomerMemory(CUSTOMER_ID);

    expect(result).toMatchObject({ found: true, memory: { latestOrderDate: null } });
  });
});

describe("getCustomerMemory — recentProducts (8)", () => {
  it("8: product_ref only, distinct, most-recent-first, limited to exactly 3", async () => {
    // Rows shaped exactly like the real query's own GROUP BY output: already
    // one row per distinct product_ref (each carrying that ref's own latest
    // occurrence), already ordered latest-first — getCustomerMemory only
    // maps these rows to product_ref, it does not deduplicate/limit itself.
    vi.spyOn(postgresPool, "query")
      .mockResolvedValueOnce(customerRow())
      .mockResolvedValueOnce(emptyResult())
      .mockResolvedValueOnce(emptyResult())
      .mockResolvedValueOnce(countRow(0))
      .mockResolvedValueOnce(countRow(0))
      .mockResolvedValueOnce({
        rows: [
          { product_ref: "REF-005", latest_order_date: new Date("2026-09-01T00:00:00.000Z") },
          { product_ref: "REF-004", latest_order_date: new Date("2026-08-01T00:00:00.000Z") },
          { product_ref: "REF-003", latest_order_date: new Date("2026-06-01T00:00:00.000Z") },
        ],
      });

    const result = await getCustomerMemory(CUSTOMER_ID);

    expect(result).toMatchObject({
      found: true,
      memory: { recentProducts: ["REF-005", "REF-004", "REF-003"] },
    });
  });

  it("TASK-025C: the SQL itself deduplicates by product_ref BEFORE the final limit — not a raw-row cap plus JS dedup", async () => {
    const spy = vi
      .spyOn(postgresPool, "query")
      .mockResolvedValueOnce(customerRow())
      .mockResolvedValueOnce(emptyResult())
      .mockResolvedValueOnce(emptyResult())
      .mockResolvedValueOnce(countRow(0))
      .mockResolvedValueOnce(countRow(0))
      .mockResolvedValueOnce(emptyResult());

    await getCustomerMemory(CUSTOMER_ID);

    const recentProductsCall = spy.mock.calls[5];
    const sql = String(recentProductsCall?.[0]);
    const params = recentProductsCall?.[1] as unknown[];

    // Combines both live and historical item history.
    expect(sql).toMatch(/order_items/i);
    expect(sql).toMatch(/historical_order_items/i);
    // Deduplication happens in SQL, before any limit is applied — the bug
    // this regression test closes was a raw-row LIMIT (50) applied BEFORE
    // deduplication, which could truncate a still-relevant distinct ref
    // behind a run of repeated occurrences of another ref. A bare
    // `LIMIT $2` with no GROUP BY (the old shape) would fail this.
    expect(sql).toMatch(/GROUP BY\s+product_ref/i);
    expect(sql).toMatch(/MAX\s*\(\s*order_date\s*\)/i);
    // Deterministic most-recent ordering, with a stable tiebreaker.
    expect(sql).toMatch(/ORDER BY\s+latest_order_date\s+DESC\s*,\s*product_ref\s+ASC/i);
    // The final limit is exactly 3 — not an arbitrary larger raw-row cap.
    expect(params?.[1]).toBe(3);
  });

  it("does not query the products catalogue table to resolve names", async () => {
    const spy = vi
      .spyOn(postgresPool, "query")
      .mockResolvedValueOnce(customerRow())
      .mockResolvedValueOnce(emptyResult())
      .mockResolvedValueOnce(emptyResult())
      .mockResolvedValueOnce(countRow(0))
      .mockResolvedValueOnce(countRow(0))
      .mockResolvedValueOnce(emptyResult());

    await getCustomerMemory(CUSTOMER_ID);

    const allSql = spy.mock.calls.map((call) => String(call[0]));
    expect(allSql.some((sql) => /\bFROM\s+products\b/i.test(sql))).toBe(false);
  });
});

describe("getCustomerMemory — no mutation, no unrelated tables", () => {
  it("never issues INSERT/UPDATE/DELETE and never checks out a transactional client", async () => {
    const connectSpy = vi.spyOn(postgresPool, "connect");
    const querySpy = vi
      .spyOn(postgresPool, "query")
      .mockResolvedValueOnce(customerRow())
      .mockResolvedValueOnce(emptyResult())
      .mockResolvedValueOnce(emptyResult())
      .mockResolvedValueOnce(countRow(0))
      .mockResolvedValueOnce(countRow(0))
      .mockResolvedValueOnce(emptyResult());

    await getCustomerMemory(CUSTOMER_ID);

    expect(connectSpy).not.toHaveBeenCalled();
    const allSql = querySpy.mock.calls.map((call) => String(call[0]));
    expect(allSql.some((sql) => /\b(INSERT|UPDATE|DELETE)\b/i.test(sql))).toBe(false);
  });
});
