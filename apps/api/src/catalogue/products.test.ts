import { afterEach, describe, expect, it, vi } from "vitest";
import { postgresPool } from "../infrastructure/postgres";
import { getAvailability, getProduct, searchProducts } from "./products";

const SAMPLE_ROW = {
  ref: "REF-0001",
  model: "Foulard bordeaux",
  family: "Foulard",
  gender: "femme",
  color: "bordeaux",
  size: "unique",
  material: "cuir",
  season: "toute saison",
  price_cents: 10000,
  stock: 2,
  barcode: "6119052578161",
  weight_grams: 1127,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getProduct", () => {
  it("returns found:true with the DB row mapped and price converted to MAD", async () => {
    vi.spyOn(postgresPool, "query").mockResolvedValue({ rows: [SAMPLE_ROW] } as never);

    const result = await getProduct("REF-0001");

    expect(result).toEqual({
      found: true,
      product: {
        ref: "REF-0001",
        model: "Foulard bordeaux",
        family: "Foulard",
        gender: "femme",
        color: "bordeaux",
        size: "unique",
        material: "cuir",
        season: "toute saison",
        price: 100,
        stock: 2,
        barcode: "6119052578161",
        weight: 1127,
      },
    });
  });

  it("returns found:false when no row matches", async () => {
    vi.spyOn(postgresPool, "query").mockResolvedValue({ rows: [] } as never);

    expect(await getProduct("REF-9999")).toEqual({ found: false });
  });
});

describe("searchProducts", () => {
  it("builds a parameterized multi-field query", async () => {
    const spy = vi.spyOn(postgresPool, "query").mockResolvedValue({ rows: [] } as never);

    await searchProducts({ family: "Ceinture", color: "bordeaux" });

    const [sql, params] = spy.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("lower(family) = lower($1)");
    expect(sql).toContain("lower(color) = lower($2)");
    expect(sql).toContain("ORDER BY ref");
    expect(params).toEqual(["Ceinture", "bordeaux"]);
  });

  it("returns every ambiguous candidate, never collapsed to one", async () => {
    const rows = [
      { ...SAMPLE_ROW, ref: "REF-0006", model: "Foulard bleu nuit", color: "bleu nuit", material: "coton", price_cents: 19000, stock: 22 },
      { ...SAMPLE_ROW, ref: "REF-0053", model: "Foulard bleu nuit", color: "bleu nuit", material: "viscose", price_cents: 9000, stock: 4 },
      { ...SAMPLE_ROW, ref: "REF-0054", model: "Foulard bleu nuit", color: "bleu nuit", material: "soie", price_cents: 18000, stock: 0 },
    ];
    vi.spyOn(postgresPool, "query").mockResolvedValue({ rows } as never);

    const result = await searchProducts({ model: "Foulard bleu nuit", color: "bleu nuit", size: "unique" });

    expect(result.map((p) => p.ref)).toEqual(["REF-0006", "REF-0053", "REF-0054"]);
  });

  it("escapes a literal % so it is not treated as a wildcard", async () => {
    const spy = vi.spyOn(postgresPool, "query").mockResolvedValue({ rows: [] } as never);

    await searchProducts({ model: "%" });

    const [sql, params] = spy.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("ILIKE $1 ESCAPE '\\'");
    expect(params[0]).toBe("%\\%%");
  });

  it("escapes a literal _ so it is not treated as a single-character wildcard", async () => {
    const spy = vi.spyOn(postgresPool, "query").mockResolvedValue({ rows: [] } as never);

    await searchProducts({ model: "_" });

    const [, params] = spy.mock.calls[0] as [string, unknown[]];
    expect(params[0]).toBe("%\\_%");
  });

  it("treats a SQL-injection-style model string as inert data, never as SQL", async () => {
    const spy = vi.spyOn(postgresPool, "query").mockResolvedValue({ rows: [] } as never);
    const payload = "'; DROP TABLE products; --";

    await searchProducts({ model: payload });

    const [sql, params] = spy.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toContain(payload);
    expect(params[0]).toBe(`%${payload}%`);
  });

  it("propagates a DB failure as a rejection", async () => {
    vi.spyOn(postgresPool, "query").mockRejectedValue(new Error("connection lost"));

    await expect(searchProducts({ ref: "REF-0001" })).rejects.toThrow("connection lost");
  });

  describe("TASK-P2: family canonicalization", () => {
    it("resolves a natural French plural ('vestes') to the canonical stored singular ('Veste')", async () => {
      const spy = vi.spyOn(postgresPool, "query").mockResolvedValue({ rows: [] } as never);

      await searchProducts({ family: "vestes" });

      const [, params] = spy.mock.calls[0] as [string, unknown[]];
      expect(params).toEqual(["Veste"]);
    });

    it("leaves an already-canonical family ('Veste') unchanged", async () => {
      const spy = vi.spyOn(postgresPool, "query").mockResolvedValue({ rows: [] } as never);

      await searchProducts({ family: "Veste" });

      const [, params] = spy.mock.calls[0] as [string, unknown[]];
      expect(params).toEqual(["Veste"]);
    });

    it("resolves regardless of input casing ('VESTE', 'veste')", async () => {
      const spy = vi.spyOn(postgresPool, "query").mockResolvedValue({ rows: [] } as never);

      await searchProducts({ family: "VESTE" });
      await searchProducts({ family: "veste" });

      const [, firstParams] = spy.mock.calls[0] as [string, unknown[]];
      const [, secondParams] = spy.mock.calls[1] as [string, unknown[]];
      expect(firstParams).toEqual(["Veste"]);
      expect(secondParams).toEqual(["Veste"]);
    });

    it("never damages an already-canonical plural family ('Chaussures') into a singular that does not exist", async () => {
      const spy = vi.spyOn(postgresPool, "query").mockResolvedValue({ rows: [] } as never);

      await searchProducts({ family: "chaussures" });

      const [, params] = spy.mock.calls[0] as [string, unknown[]];
      expect(params).toEqual(["Chaussures"]);
    });

    it("passes through a family with no canonical match unchanged, so a genuinely nonexistent family still queries as given", async () => {
      const spy = vi.spyOn(postgresPool, "query").mockResolvedValue({ rows: [] } as never);

      await searchProducts({ family: "kimono" });

      const [, params] = spy.mock.calls[0] as [string, unknown[]];
      expect(params).toEqual(["kimono"]);
    });

    it("still returns zero rows for a canonical family with a color that genuinely does not exist for it (dataset truth, not a search defect)", async () => {
      vi.spyOn(postgresPool, "query").mockResolvedValue({ rows: [] } as never);

      const result = await searchProducts({ family: "vestes", color: "noir" });

      expect(result).toEqual([]);
    });
  });
});

describe("getAvailability", () => {
  it("reports available:true when stock > 0", async () => {
    vi.spyOn(postgresPool, "query").mockResolvedValue({ rows: [{ stock: 5 }] } as never);

    expect(await getAvailability("REF-0006")).toEqual({
      found: true,
      ref: "REF-0006",
      stock: 5,
      available: true,
    });
  });

  it("reports available:false when stock = 0", async () => {
    vi.spyOn(postgresPool, "query").mockResolvedValue({ rows: [{ stock: 0 }] } as never);

    expect(await getAvailability("REF-0054")).toEqual({
      found: true,
      ref: "REF-0054",
      stock: 0,
      available: false,
    });
  });

  it("returns found:false for an unknown ref", async () => {
    vi.spyOn(postgresPool, "query").mockResolvedValue({ rows: [] } as never);

    expect(await getAvailability("REF-9999")).toEqual({ found: false, ref: "REF-9999" });
  });
});
