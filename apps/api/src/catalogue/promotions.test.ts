import { PromotionSchema } from "@m3ak/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { postgresPool } from "../infrastructure/postgres";
import { getApplicablePromotion, validateDiscount } from "./promotions";
import type { ProductRow } from "./products";

const KNOWN_CONDITION = "dans la limite des stocks disponibles";

function makeProductRow(overrides: Partial<ProductRow> = {}): ProductRow {
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

interface PromotionRowFixture {
  id: string;
  product_ref: string;
  normal_price_cents: number;
  promo_price_cents: number;
  starts_at: string;
  ends_at: string;
  condition: string;
}

function makePromotionRow(overrides: Partial<PromotionRowFixture> = {}): PromotionRowFixture {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    product_ref: "REF-BASE",
    normal_price_cents: 10000,
    promo_price_cents: 8000,
    starts_at: "2026-09-01",
    ends_at: "2026-09-30",
    condition: KNOWN_CONDITION,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getApplicablePromotion — input validation and not-found (A, B, C)", () => {
  it("A: rejects a malformed/empty ref before any DB query", async () => {
    const spy = vi.spyOn(postgresPool, "query");
    await expect(getApplicablePromotion("   ", "2026-09-15")).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });

  it("B: rejects a malformed date before any DB query", async () => {
    const spy = vi.spyOn(postgresPool, "query");
    await expect(getApplicablePromotion("REF-0001", "15-09-2026")).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });

  it("C: returns found:false/product_not_found for an unknown product ref", async () => {
    vi.spyOn(postgresPool, "query").mockResolvedValueOnce({ rows: [] } as never);
    const result = await getApplicablePromotion("REF-9999", "2026-09-15");
    expect(result).toEqual({ found: false, reason: "product_not_found", ref: "REF-9999" });
  });
});

describe("getApplicablePromotion — promotion absence (D, E, I)", () => {
  // D, E and I (no promo at all / future / day-after-expiry) are indistinguishable
  // at the mocked-JS level: the date-window filtering happens entirely inside
  // PostgreSQL's WHERE clause, never in this code. Each is still exercised
  // separately here for traceability; the boundary-specific behavior itself is
  // proven against the real database (see the task report's real-DB section).
  it("D: no promotion row at all -> promotion:null", async () => {
    const spy = vi.spyOn(postgresPool, "query");
    spy.mockResolvedValueOnce({ rows: [makeProductRow({ ref: "REF-0001" })] } as never);
    spy.mockResolvedValueOnce({ rows: [] } as never);
    const result = await getApplicablePromotion("REF-0001", "2026-09-15");
    expect(result.found).toBe(true);
    if (result.found) expect(result.promotion).toBeNull();
  });

  it("E: a not-yet-active (future) promotion window -> promotion:null", async () => {
    const spy = vi.spyOn(postgresPool, "query");
    spy.mockResolvedValueOnce({ rows: [makeProductRow({ ref: "REF-0001" })] } as never);
    spy.mockResolvedValueOnce({ rows: [] } as never);
    const result = await getApplicablePromotion("REF-0001", "2026-08-15");
    expect(result.found).toBe(true);
    if (result.found) expect(result.promotion).toBeNull();
  });

  it("I: the day after an expired promotion window -> promotion:null", async () => {
    const spy = vi.spyOn(postgresPool, "query");
    spy.mockResolvedValueOnce({ rows: [makeProductRow({ ref: "REF-0001" })] } as never);
    spy.mockResolvedValueOnce({ rows: [] } as never);
    const result = await getApplicablePromotion("REF-0001", "2026-10-01");
    expect(result.found).toBe(true);
    if (result.found) expect(result.promotion).toBeNull();
  });
});

describe("getApplicablePromotion — active promotion boundaries, no JS-side date manipulation (F, G, H)", () => {
  // These prove two things at once: the promotion is correctly mapped when SQL
  // returns a matching row, AND the asOfDate string is passed to the query
  // completely unmodified (no Date object round-trip, no reformatting) for
  // each of the three inclusive boundary dates.
  it.each([
    ["F", "2026-09-01"],
    ["G", "2026-09-15"],
    ["H", "2026-09-30"],
  ])("%s: an active promotion is returned for asOfDate=%s, passed through unmodified", async (_label, asOfDate) => {
    const spy = vi.spyOn(postgresPool, "query");
    spy.mockResolvedValueOnce({ rows: [makeProductRow({ ref: "REF-0001", price_cents: 32000, stock: 3 })] } as never);
    spy.mockResolvedValueOnce({
      rows: [makePromotionRow({ product_ref: "REF-0001", normal_price_cents: 32000, promo_price_cents: 25000 })],
    } as never);

    const result = await getApplicablePromotion("REF-0001", asOfDate);

    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.promotion).not.toBeNull();
    }
    const promotionCallParams = (spy.mock.calls[1] as [string, unknown[]])[1];
    expect(promotionCallParams).toEqual(["REF-0001", asOfDate]);
  });
});

describe("getApplicablePromotion — mapping and PromotionSchema (J, K, L)", () => {
  it("J: converts normal/promo cents to MAD via centimesToMad", async () => {
    const spy = vi.spyOn(postgresPool, "query");
    spy.mockResolvedValueOnce({ rows: [makeProductRow({ ref: "REF-0001", price_cents: 32000, stock: 3 })] } as never);
    spy.mockResolvedValueOnce({
      rows: [makePromotionRow({ product_ref: "REF-0001", normal_price_cents: 32000, promo_price_cents: 25000 })],
    } as never);

    const result = await getApplicablePromotion("REF-0001", "2026-09-15");

    expect(result.found).toBe(true);
    if (result.found && result.promotion) {
      expect(result.promotion.normalPrice).toBe(320);
      expect(result.promotion.promoPrice).toBe(250);
    }
  });

  it("K: the returned Promotion passes PromotionSchema", async () => {
    const spy = vi.spyOn(postgresPool, "query");
    spy.mockResolvedValueOnce({ rows: [makeProductRow({ ref: "REF-0001", price_cents: 32000, stock: 3 })] } as never);
    spy.mockResolvedValueOnce({
      rows: [makePromotionRow({ product_ref: "REF-0001", normal_price_cents: 32000, promo_price_cents: 25000 })],
    } as never);

    const result = await getApplicablePromotion("REF-0001", "2026-09-15");

    expect(result.found).toBe(true);
    if (result.found) {
      expect(PromotionSchema.safeParse(result.promotion).success).toBe(true);
    }
  });

  it("L: the promotion SQL casts starts_at/ends_at to text", async () => {
    const spy = vi.spyOn(postgresPool, "query");
    spy.mockResolvedValueOnce({ rows: [makeProductRow({ ref: "REF-0001" })] } as never);
    spy.mockResolvedValueOnce({ rows: [] } as never);

    await getApplicablePromotion("REF-0001", "2026-09-15");

    const promotionSql = (spy.mock.calls[1] as [string, unknown[]])[0];
    expect(promotionSql).toContain("starts_at::text");
    expect(promotionSql).toContain("ends_at::text");
  });
});

describe("getApplicablePromotion — integrity guardrails (M, N, O, P)", () => {
  it("M: throws when more than one active promotion is found", async () => {
    const spy = vi.spyOn(postgresPool, "query");
    spy.mockResolvedValueOnce({ rows: [makeProductRow({ ref: "REF-0001", price_cents: 32000, stock: 3 })] } as never);
    spy.mockResolvedValueOnce({
      rows: [
        makePromotionRow({ product_ref: "REF-0001", normal_price_cents: 32000 }),
        makePromotionRow({ id: "22222222-2222-2222-2222-222222222222", product_ref: "REF-0001", normal_price_cents: 32000 }),
      ],
    } as never);

    await expect(getApplicablePromotion("REF-0001", "2026-09-15")).rejects.toThrow(/active promotions found/i);
  });

  it("N: throws when promotion normal_price_cents mismatches the product price", async () => {
    const spy = vi.spyOn(postgresPool, "query");
    spy.mockResolvedValueOnce({ rows: [makeProductRow({ ref: "REF-0001", price_cents: 32000, stock: 3 })] } as never);
    spy.mockResolvedValueOnce({
      rows: [makePromotionRow({ product_ref: "REF-0001", normal_price_cents: 99999 })],
    } as never);

    await expect(getApplicablePromotion("REF-0001", "2026-09-15")).rejects.toThrow(/does not match/i);
  });

  it("O: throws for an unsupported promotion condition", async () => {
    const spy = vi.spyOn(postgresPool, "query");
    spy.mockResolvedValueOnce({ rows: [makeProductRow({ ref: "REF-0001", price_cents: 32000, stock: 3 })] } as never);
    spy.mockResolvedValueOnce({
      rows: [makePromotionRow({ product_ref: "REF-0001", normal_price_cents: 32000, condition: "some other condition" })],
    } as never);

    await expect(getApplicablePromotion("REF-0001", "2026-09-15")).rejects.toThrow(/unsupported promotion condition/i);
  });

  it("P: supported condition + product stock=0 -> promotion:null", async () => {
    const spy = vi.spyOn(postgresPool, "query");
    spy.mockResolvedValueOnce({ rows: [makeProductRow({ ref: "REF-0001", price_cents: 32000, stock: 0 })] } as never);
    spy.mockResolvedValueOnce({
      rows: [makePromotionRow({ product_ref: "REF-0001", normal_price_cents: 32000 })],
    } as never);

    const result = await getApplicablePromotion("REF-0001", "2026-09-15");

    expect(result.found).toBe(true);
    if (result.found) expect(result.promotion).toBeNull();
  });
});

describe("getApplicablePromotion — DB failures and security (Q, R, S)", () => {
  it("Q: propagates a failure on the product lookup", async () => {
    vi.spyOn(postgresPool, "query").mockRejectedValue(new Error("product lookup failed"));
    await expect(getApplicablePromotion("REF-0001", "2026-09-15")).rejects.toThrow("product lookup failed");
  });

  it("R: propagates a failure on the promotion lookup", async () => {
    const spy = vi.spyOn(postgresPool, "query");
    spy.mockResolvedValueOnce({ rows: [makeProductRow({ ref: "REF-0001" })] } as never);
    spy.mockRejectedValueOnce(new Error("promotion lookup failed"));
    await expect(getApplicablePromotion("REF-0001", "2026-09-15")).rejects.toThrow("promotion lookup failed");
  });

  it("S: a SQL-injection-style ref appears only as a parameter, never in SQL text", async () => {
    const payload = "'; DROP TABLE promotions; --";
    const spy = vi.spyOn(postgresPool, "query").mockResolvedValue({ rows: [] } as never);

    await getApplicablePromotion(payload, "2026-09-15");

    const [sql, params] = spy.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toContain(payload);
    expect(params).toEqual([payload]);
  });
});

describe("validateDiscount — no active promotion (T, U, V, W, X, Y)", () => {
  it("T: requested price equal to catalogue price -> allowed/no_discount_requested", async () => {
    const spy = vi.spyOn(postgresPool, "query");
    spy.mockResolvedValueOnce({ rows: [makeProductRow({ ref: "REF-0001", price_cents: 10000, stock: 3 })] } as never);
    spy.mockResolvedValueOnce({ rows: [] } as never);

    const result = await validateDiscount("REF-0001", 10000, "2026-09-15");

    expect(result).toMatchObject({
      allowed: true,
      reason: "no_discount_requested",
      basePriceCents: 10000,
      minimumAllowedPriceCents: 9000,
    });
  });

  it("U: a discount under 10% -> allowed/within_discretionary_limit", async () => {
    const spy = vi.spyOn(postgresPool, "query");
    spy.mockResolvedValueOnce({ rows: [makeProductRow({ ref: "REF-0001", price_cents: 10000, stock: 3 })] } as never);
    spy.mockResolvedValueOnce({ rows: [] } as never);

    const result = await validateDiscount("REF-0001", 9500, "2026-09-15");

    expect(result).toMatchObject({ allowed: true, reason: "within_discretionary_limit" });
  });

  it("V: exactly 10% discount -> allowed/within_discretionary_limit", async () => {
    const spy = vi.spyOn(postgresPool, "query");
    spy.mockResolvedValueOnce({ rows: [makeProductRow({ ref: "REF-0001", price_cents: 10000, stock: 3 })] } as never);
    spy.mockResolvedValueOnce({ rows: [] } as never);

    const result = await validateDiscount("REF-0001", 9000, "2026-09-15");

    expect(result).toMatchObject({ allowed: true, reason: "within_discretionary_limit" });
  });

  it("W: a discount over 10% -> requires escalation/discount_exceeds_limit", async () => {
    const spy = vi.spyOn(postgresPool, "query");
    spy.mockResolvedValueOnce({ rows: [makeProductRow({ ref: "REF-0001", price_cents: 10000, stock: 3 })] } as never);
    spy.mockResolvedValueOnce({ rows: [] } as never);

    const result = await validateDiscount("REF-0001", 8999, "2026-09-15");

    expect(result).toMatchObject({ allowed: false, requiresEscalation: true, reason: "discount_exceeds_limit" });
  });

  it("X: the 999-cent rounding edge — 900 accepted, 899 escalated", async () => {
    const spy = vi.spyOn(postgresPool, "query");
    spy.mockResolvedValueOnce({ rows: [makeProductRow({ ref: "REF-EDGE", price_cents: 999, stock: 3 })] } as never);
    spy.mockResolvedValueOnce({ rows: [] } as never);
    const accepted = await validateDiscount("REF-EDGE", 900, "2026-09-15");
    expect(accepted.allowed).toBe(true);

    spy.mockResolvedValueOnce({ rows: [makeProductRow({ ref: "REF-EDGE", price_cents: 999, stock: 3 })] } as never);
    spy.mockResolvedValueOnce({ rows: [] } as never);
    const escalated = await validateDiscount("REF-EDGE", 899, "2026-09-15");
    expect(escalated.allowed).toBe(false);
    if (!escalated.allowed && escalated.reason !== "product_not_found" && escalated.reason !== "price_above_authoritative_base") {
      expect(escalated.reason).toBe("discount_exceeds_limit");
    }
  });

  it("Y: a requested price above the catalogue base -> not allowed, no escalation", async () => {
    const spy = vi.spyOn(postgresPool, "query");
    spy.mockResolvedValueOnce({ rows: [makeProductRow({ ref: "REF-0001", price_cents: 10000, stock: 3 })] } as never);
    spy.mockResolvedValueOnce({ rows: [] } as never);

    const result = await validateDiscount("REF-0001", 11000, "2026-09-15");

    expect(result).toEqual({
      allowed: false,
      requiresEscalation: false,
      productRef: "REF-0001",
      requestedPriceCents: 11000,
      reason: "price_above_authoritative_base",
    });
  });
});

describe("validateDiscount — active promotion, no stacking (Z, AA, AB)", () => {
  it("Z: requesting exactly the active promo price -> allowed/active_promotion_price", async () => {
    const spy = vi.spyOn(postgresPool, "query");
    spy.mockResolvedValueOnce({ rows: [makeProductRow({ ref: "REF-0018", price_cents: 20000, stock: 1 })] } as never);
    spy.mockResolvedValueOnce({
      rows: [makePromotionRow({ product_ref: "REF-0018", normal_price_cents: 20000, promo_price_cents: 16000 })],
    } as never);

    const result = await validateDiscount("REF-0018", 16000, "2026-09-15");

    expect(result).toMatchObject({
      allowed: true,
      reason: "active_promotion_price",
      basePriceCents: 16000,
      minimumAllowedPriceCents: 16000,
    });
  });

  it("AA: even a 1-cent discount below the active promo price requires escalation", async () => {
    const spy = vi.spyOn(postgresPool, "query");
    spy.mockResolvedValueOnce({ rows: [makeProductRow({ ref: "REF-0018", price_cents: 20000, stock: 1 })] } as never);
    spy.mockResolvedValueOnce({
      rows: [makePromotionRow({ product_ref: "REF-0018", normal_price_cents: 20000, promo_price_cents: 16000 })],
    } as never);

    const result = await validateDiscount("REF-0018", 15999, "2026-09-15");

    expect(result).toMatchObject({
      allowed: false,
      requiresEscalation: true,
      reason: "active_promotion_no_further_discount",
    });
  });

  it("AB: a requested price above the active promo price -> not allowed, no escalation", async () => {
    const spy = vi.spyOn(postgresPool, "query");
    spy.mockResolvedValueOnce({ rows: [makeProductRow({ ref: "REF-0018", price_cents: 20000, stock: 1 })] } as never);
    spy.mockResolvedValueOnce({
      rows: [makePromotionRow({ product_ref: "REF-0018", normal_price_cents: 20000, promo_price_cents: 16000 })],
    } as never);

    const result = await validateDiscount("REF-0018", 17000, "2026-09-15");

    expect(result).toEqual({
      allowed: false,
      requiresEscalation: false,
      productRef: "REF-0018",
      requestedPriceCents: 17000,
      reason: "price_above_authoritative_base",
    });
  });
});

describe("validateDiscount — future/expired promotions never affect the base (AC, AD)", () => {
  it("AC: a not-yet-active (future) promotion leaves the catalogue price as the base", async () => {
    const spy = vi.spyOn(postgresPool, "query");
    spy.mockResolvedValueOnce({ rows: [makeProductRow({ ref: "REF-0001", price_cents: 10000, stock: 3 })] } as never);
    spy.mockResolvedValueOnce({ rows: [] } as never);

    const result = await validateDiscount("REF-0001", 10000, "2026-08-15");

    expect(result).toMatchObject({ allowed: true, reason: "no_discount_requested", basePriceCents: 10000 });
  });

  it("AD: an expired promotion leaves the catalogue price as the base", async () => {
    const spy = vi.spyOn(postgresPool, "query");
    spy.mockResolvedValueOnce({ rows: [makeProductRow({ ref: "REF-0001", price_cents: 10000, stock: 3 })] } as never);
    spy.mockResolvedValueOnce({ rows: [] } as never);

    const result = await validateDiscount("REF-0001", 10000, "2026-10-15");

    expect(result).toMatchObject({ allowed: true, reason: "no_discount_requested", basePriceCents: 10000 });
  });
});

describe("validateDiscount — malformed requestedPriceCents rejected before any DB query (AE-AI)", () => {
  it("AE: zero is rejected", async () => {
    const spy = vi.spyOn(postgresPool, "query");
    await expect(validateDiscount("REF-0001", 0, "2026-09-15")).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });

  it("AF: negative is rejected", async () => {
    const spy = vi.spyOn(postgresPool, "query");
    await expect(validateDiscount("REF-0001", -100, "2026-09-15")).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });

  it("AG: non-integer is rejected", async () => {
    const spy = vi.spyOn(postgresPool, "query");
    await expect(validateDiscount("REF-0001", 100.5, "2026-09-15")).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });

  it("AH: unsafe integer is rejected", async () => {
    const spy = vi.spyOn(postgresPool, "query");
    await expect(validateDiscount("REF-0001", 2 ** 60, "2026-09-15")).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });

  it("AI: NaN and Infinity are rejected", async () => {
    const spy = vi.spyOn(postgresPool, "query");
    await expect(validateDiscount("REF-0001", Number.NaN, "2026-09-15")).rejects.toThrow();
    await expect(validateDiscount("REF-0001", Number.POSITIVE_INFINITY, "2026-09-15")).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("validateDiscount — unknown product (AJ)", () => {
  it("AJ: an unknown product returns allowed:false/product_not_found", async () => {
    vi.spyOn(postgresPool, "query").mockResolvedValueOnce({ rows: [] } as never);

    const result = await validateDiscount("REF-9999", 5000, "2026-09-15");

    expect(result).toEqual({
      allowed: false,
      requiresEscalation: false,
      productRef: "REF-9999",
      reason: "product_not_found",
    });
  });
});
