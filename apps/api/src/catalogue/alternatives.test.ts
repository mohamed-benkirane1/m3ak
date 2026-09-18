import { afterEach, describe, expect, it, vi } from "vitest";
import { postgresPool } from "../infrastructure/postgres";
import { findAlternatives, MAX_ALTERNATIVES, rankAlternatives } from "./alternatives";
import type { ProductRow } from "./products";

function makeRow(overrides: Partial<ProductRow> = {}): ProductRow {
  return {
    ref: "REF-BASE",
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("findAlternatives — input validation and not-found (A, B)", () => {
  it("A: rejects a malformed/empty ref before any DB query", async () => {
    const spy = vi.spyOn(postgresPool, "query");

    await expect(findAlternatives("   ")).rejects.toThrow();

    expect(spy).not.toHaveBeenCalled();
  });

  it("B: returns {found:false, ref} for an unknown source ref", async () => {
    vi.spyOn(postgresPool, "query").mockResolvedValue({ rows: [] } as never);

    expect(await findAlternatives("REF-9999")).toEqual({ found: false, ref: "REF-9999" });
  });
});

describe("rankAlternatives — defensive eligibility filter (C, D, E, F)", () => {
  const source = makeRow({ ref: "REF-SRC", family: "FamilyA", gender: "femme", stock: 5 });

  it("C: excludes the source ref even if it is present in the candidate list", () => {
    const result = rankAlternatives(source, [source, makeRow({ ref: "REF-OK", stock: 3 })]);
    expect(result.map((r) => r.ref)).not.toContain("REF-SRC");
  });

  it("D: excludes a stock<=0 candidate even if it would score highest", () => {
    const sameModelButOOS = makeRow({
      ref: "REF-OOS",
      model: source.model,
      color: source.color,
      size: source.size,
      stock: 0,
    });
    const result = rankAlternatives(source, [sameModelButOOS]);
    expect(result).toEqual([]);
  });

  it("E: excludes a candidate from a different family", () => {
    const wrongFamily = makeRow({ ref: "REF-WRONGFAM", family: "FamilyB", stock: 3 });
    expect(rankAlternatives(source, [wrongFamily])).toEqual([]);
  });

  it("F: excludes a candidate with a different gender", () => {
    const wrongGender = makeRow({ ref: "REF-WRONGGENDER", gender: "homme", stock: 3 });
    expect(rankAlternatives(source, [wrongGender])).toEqual([]);
  });
});

describe("rankAlternatives — scoring and deterministic tie-break chain (G, H, I, J)", () => {
  const source = makeRow({
    ref: "REF-SRC",
    model: "Foulard bleu nuit",
    color: "bleu nuit",
    size: "unique",
    material: "soie",
    season: "été",
    price_cents: 18000,
  });

  it("G: a same-model candidate outranks a non-same-model candidate", () => {
    const sameModel = makeRow({ ref: "REF-A", model: source.model, stock: 4 });
    const differentModel = makeRow({
      ref: "REF-B",
      model: "Other model",
      color: source.color,
      size: source.size,
      stock: 4,
    });
    const result = rankAlternatives(source, [differentModel, sameModel]);
    expect(result.map((r) => r.ref)).toEqual(["REF-A", "REF-B"]);
  });

  it("H: on a score tie, orders by price distance ascending", () => {
    const near = makeRow({ ref: "REF-NEAR", model: "X", price_cents: source.price_cents + 1000, stock: 1 });
    const far = makeRow({ ref: "REF-FAR", model: "X", price_cents: source.price_cents + 9000, stock: 1 });
    const result = rankAlternatives(source, [far, near]);
    expect(result.map((r) => r.ref)).toEqual(["REF-NEAR", "REF-FAR"]);
  });

  it("I: on a score+price tie, orders by stock descending", () => {
    const lowStock = makeRow({ ref: "REF-LOW", model: "X", price_cents: source.price_cents, stock: 1 });
    const highStock = makeRow({ ref: "REF-HIGH", model: "X", price_cents: source.price_cents, stock: 20 });
    const result = rankAlternatives(source, [lowStock, highStock]);
    expect(result.map((r) => r.ref)).toEqual(["REF-HIGH", "REF-LOW"]);
  });

  it("J: on a score+price+stock tie, orders by ref ascending", () => {
    const b = makeRow({ ref: "REF-B", model: "X", price_cents: source.price_cents, stock: 5 });
    const a = makeRow({ ref: "REF-A", model: "X", price_cents: source.price_cents, stock: 5 });
    const result = rankAlternatives(source, [b, a]);
    expect(result.map((r) => r.ref)).toEqual(["REF-A", "REF-B"]);
  });
});

describe("rankAlternatives — result count and purity (K, L, M)", () => {
  const source = makeRow({ ref: "REF-SRC" });

  it("K: returns exactly MAX_ALTERNATIVES when more candidates are eligible", () => {
    const candidates = Array.from({ length: 5 }, (_, i) => makeRow({ ref: `REF-C${i}`, stock: i + 1 }));
    const result = rankAlternatives(source, candidates);
    expect(result).toHaveLength(MAX_ALTERNATIVES);
  });

  it("L: returns [] when zero candidates are eligible", () => {
    expect(rankAlternatives(source, [])).toEqual([]);
  });

  it("M: does not mutate the original candidates array or its objects", () => {
    const candidates = [makeRow({ ref: "REF-C2", stock: 2 }), makeRow({ ref: "REF-C1", stock: 1 })];
    const snapshot = JSON.parse(JSON.stringify(candidates));

    rankAlternatives(source, candidates);

    expect(candidates).toEqual(snapshot);
  });
});

describe("findAlternatives — SQL parameterization and security (N, O, P)", () => {
  it("N: both source and candidate queries are parameterized", async () => {
    const spy = vi.spyOn(postgresPool, "query").mockResolvedValue({ rows: [] } as never);
    // First call returns the source row so a second call is made for candidates.
    spy.mockResolvedValueOnce({ rows: [makeRow({ ref: "REF-0001" })] } as never);
    spy.mockResolvedValueOnce({ rows: [] } as never);

    await findAlternatives("REF-0001");

    expect(spy).toHaveBeenCalledTimes(2);
    const [sourceCall, candidatesCall] = spy.mock.calls as [string, unknown[]][][];
    expect((sourceCall as [string, unknown[]])[1]).toEqual(["REF-0001"]);
    expect(typeof (candidatesCall as [string, unknown[]])[0]).toBe("string");
  });

  it("O: the candidate query text includes stock > 0, ref <> $3, family and gender conditions", async () => {
    const spy = vi.spyOn(postgresPool, "query").mockResolvedValue({ rows: [] } as never);
    spy.mockResolvedValueOnce({ rows: [makeRow({ ref: "REF-0001" })] } as never);
    spy.mockResolvedValueOnce({ rows: [] } as never);

    await findAlternatives("REF-0001");

    const candidatesSql = (spy.mock.calls[1] as [string, unknown[]])[0];
    expect(candidatesSql).toContain("family = $1");
    expect(candidatesSql).toContain("gender = $2");
    expect(candidatesSql).toContain("stock > 0");
    expect(candidatesSql).toContain("ref <> $3");
  });

  it("P: a SQL-injection-style ref appears only as a parameter, never in the SQL text", async () => {
    const payload = "'; DROP TABLE products; --";
    const spy = vi.spyOn(postgresPool, "query").mockResolvedValue({ rows: [] } as never);

    await findAlternatives(payload);

    const [sql, params] = spy.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toContain(payload);
    expect(params).toEqual([payload]);
  });
});

describe("findAlternatives — DB failure propagation (Q, R)", () => {
  it("Q: a failure on the source lookup rejects", async () => {
    vi.spyOn(postgresPool, "query").mockRejectedValue(new Error("source lookup failed"));

    await expect(findAlternatives("REF-0001")).rejects.toThrow("source lookup failed");
  });

  it("R: a failure on the candidate lookup rejects", async () => {
    const spy = vi.spyOn(postgresPool, "query");
    spy.mockResolvedValueOnce({ rows: [makeRow({ ref: "REF-0001" })] } as never);
    spy.mockRejectedValueOnce(new Error("candidate lookup failed"));

    await expect(findAlternatives("REF-0001")).rejects.toThrow("candidate lookup failed");
  });
});

describe("findAlternatives — mapper/ProductSchema reuse (S)", () => {
  it("S: returned source and alternatives are mapped Products (MAD price, grams weight, no cents/restock fields)", async () => {
    const sourceRow = makeRow({ ref: "REF-0001", price_cents: 34990 });
    const candidateRow = makeRow({ ref: "REF-0002", model: sourceRow.model, price_cents: 10000, stock: 3 });
    const spy = vi.spyOn(postgresPool, "query");
    spy.mockResolvedValueOnce({ rows: [sourceRow] } as never);
    spy.mockResolvedValueOnce({ rows: [candidateRow] } as never);

    const result = await findAlternatives("REF-0001");

    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.source.price).toBe(349.9);
      expect(result.source.weight).toBe(500);
      expect(result.alternatives[0]?.price).toBe(100);
      expect(result.source).not.toHaveProperty("price_cents");
      expect(result.source).not.toHaveProperty("restock_delay_days");
      expect(result.source).not.toHaveProperty("imported_at");
    }
  });
});
