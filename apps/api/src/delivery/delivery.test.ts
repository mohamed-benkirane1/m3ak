import { DeliveryZoneSchema } from "@m3ak/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { postgresPool } from "../infrastructure/postgres";
import { getDeliveryOptions } from "./delivery";

interface DeliveryZoneRowFixture {
  city: string;
  fee_cents: number;
  delay_hours: number;
  cash_on_delivery: boolean;
  store_pickup: boolean;
}

function makeDeliveryZoneRow(overrides: Partial<DeliveryZoneRowFixture> = {}): DeliveryZoneRowFixture {
  return {
    city: "Casablanca",
    fee_cents: 2500,
    delay_hours: 72,
    cash_on_delivery: true,
    store_pickup: true,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getDeliveryOptions — input validation (A, B, C)", () => {
  it("A: rejects an empty city before any DB query", async () => {
    const spy = vi.spyOn(postgresPool, "query");
    await expect(getDeliveryOptions("")).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });

  it("B: rejects a whitespace-only city before any DB query", async () => {
    const spy = vi.spyOn(postgresPool, "query");
    await expect(getDeliveryOptions("   ")).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });

  it("C: rejects a non-string city before any DB query", async () => {
    const spy = vi.spyOn(postgresPool, "query");
    await expect(getDeliveryOptions(42)).rejects.toThrow();
    await expect(getDeliveryOptions(null)).rejects.toThrow();
    await expect(getDeliveryOptions(undefined)).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("getDeliveryOptions — normalization (D, E)", () => {
  it("D: trims whitespace before querying (query param is the trimmed city)", async () => {
    const spy = vi
      .spyOn(postgresPool, "query")
      .mockResolvedValueOnce({ rows: [makeDeliveryZoneRow()] } as never);

    await getDeliveryOptions("  Rabat  ");

    expect(spy).toHaveBeenCalledTimes(1);
    const [, params] = spy.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual(["Rabat"]);
  });

  it("E: lookup SQL is case-insensitive (lower(city) = lower($1))", async () => {
    const spy = vi
      .spyOn(postgresPool, "query")
      .mockResolvedValueOnce({ rows: [makeDeliveryZoneRow()] } as never);

    await getDeliveryOptions("Casablanca");

    const [sql] = spy.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/lower\(city\)\s*=\s*lower\(\$1\)/);
  });
});

describe("getDeliveryOptions — field mapping (F, G, H, I, J, K, L)", () => {
  it("F: maps fee_cents to MAD via centimesToMad", async () => {
    vi.spyOn(postgresPool, "query").mockResolvedValueOnce({
      rows: [makeDeliveryZoneRow({ fee_cents: 3500 })],
    } as never);
    const result = await getDeliveryOptions("Fès");
    expect(result).toEqual({ found: true, zone: expect.objectContaining({ fee: 35 }) });
  });

  it("G: preserves delay_hours exactly as delayHours", async () => {
    vi.spyOn(postgresPool, "query").mockResolvedValueOnce({
      rows: [makeDeliveryZoneRow({ delay_hours: 24 })],
    } as never);
    const result = await getDeliveryOptions("Fès");
    expect(result).toEqual({ found: true, zone: expect.objectContaining({ delayHours: 24 }) });
  });

  it("H: preserves cash_on_delivery=true", async () => {
    vi.spyOn(postgresPool, "query").mockResolvedValueOnce({
      rows: [makeDeliveryZoneRow({ cash_on_delivery: true })],
    } as never);
    const result = await getDeliveryOptions("Casablanca");
    expect(result).toEqual({ found: true, zone: expect.objectContaining({ cashOnDelivery: true }) });
  });

  it("I: preserves cash_on_delivery=false", async () => {
    vi.spyOn(postgresPool, "query").mockResolvedValueOnce({
      rows: [makeDeliveryZoneRow({ cash_on_delivery: false })],
    } as never);
    const result = await getDeliveryOptions("Tanger");
    expect(result).toEqual({ found: true, zone: expect.objectContaining({ cashOnDelivery: false }) });
  });

  it("J: preserves store_pickup=true", async () => {
    vi.spyOn(postgresPool, "query").mockResolvedValueOnce({
      rows: [makeDeliveryZoneRow({ store_pickup: true })],
    } as never);
    const result = await getDeliveryOptions("Casablanca");
    expect(result).toEqual({ found: true, zone: expect.objectContaining({ storePickup: true }) });
  });

  it("K: preserves store_pickup=false", async () => {
    vi.spyOn(postgresPool, "query").mockResolvedValueOnce({
      rows: [makeDeliveryZoneRow({ store_pickup: false })],
    } as never);
    const result = await getDeliveryOptions("Rabat");
    expect(result).toEqual({ found: true, zone: expect.objectContaining({ storePickup: false }) });
  });

  it("L: the returned zone passes DeliveryZoneSchema", async () => {
    vi.spyOn(postgresPool, "query").mockResolvedValueOnce({ rows: [makeDeliveryZoneRow()] } as never);
    const result = await getDeliveryOptions("Casablanca");
    if (!result.found) throw new Error("expected found:true");
    expect(DeliveryZoneSchema.safeParse(result.zone).success).toBe(true);
  });
});

describe("getDeliveryOptions — unknown city and no invented geography (M, N, O)", () => {
  it("M: unknown city returns found:false/city_not_in_delivery_grid with the trimmed input city", async () => {
    vi.spyOn(postgresPool, "query").mockResolvedValueOnce({ rows: [] } as never);
    const result = await getDeliveryOptions("  Zagora  ");
    expect(result).toEqual({ found: false, city: "Zagora", reason: "city_not_in_delivery_grid" });
  });

  it('N: "Fes" (no accent) is NOT silently normalized to "Fès" — zero DB rows -> not found', async () => {
    const spy = vi.spyOn(postgresPool, "query").mockResolvedValueOnce({ rows: [] } as never);
    const result = await getDeliveryOptions("Fes");
    expect(result).toEqual({ found: false, city: "Fes", reason: "city_not_in_delivery_grid" });
    const [, params] = spy.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual(["Fes"]);
  });

  it('O: "Casa" is NOT silently normalized to "Casablanca" — zero DB rows -> not found', async () => {
    const spy = vi.spyOn(postgresPool, "query").mockResolvedValueOnce({ rows: [] } as never);
    const result = await getDeliveryOptions("Casa");
    expect(result).toEqual({ found: false, city: "Casa", reason: "city_not_in_delivery_grid" });
    const [, params] = spy.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual(["Casa"]);
  });
});

describe("getDeliveryOptions — security and integrity (P, Q, R, S, T)", () => {
  it("P: SQL-injection-style city is passed only as a query parameter", async () => {
    const spy = vi.spyOn(postgresPool, "query").mockResolvedValueOnce({ rows: [] } as never);
    const malicious = "Rabat'; DROP TABLE delivery_zones; --";
    await getDeliveryOptions(malicious);
    const [sql, params] = spy.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toContain(malicious);
    expect(params).toEqual([malicious]);
  });

  it("Q: more than one case-insensitive match throws an explicit integrity error", async () => {
    vi.spyOn(postgresPool, "query").mockResolvedValueOnce({
      rows: [makeDeliveryZoneRow({ city: "Fès" }), makeDeliveryZoneRow({ city: "FÈS" })],
    } as never);
    await expect(getDeliveryOptions("fès")).rejects.toThrow(/Integrity error/i);
  });

  it("R: a DB failure propagates (rejects), it is never swallowed", async () => {
    vi.spyOn(postgresPool, "query").mockRejectedValueOnce(new Error("connection terminated"));
    await expect(getDeliveryOptions("Rabat")).rejects.toThrow("connection terminated");
  });

  it("S: exactly one query is issued per call", async () => {
    const spy = vi.spyOn(postgresPool, "query").mockResolvedValueOnce({ rows: [makeDeliveryZoneRow()] } as never);
    await getDeliveryOptions("Casablanca");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("T: the SQL never references historical tables", async () => {
    const spy = vi.spyOn(postgresPool, "query").mockResolvedValueOnce({ rows: [makeDeliveryZoneRow()] } as never);
    await getDeliveryOptions("Casablanca");
    const [sql] = spy.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toMatch(/historical_orders/i);
    expect(sql).not.toMatch(/historical_order_items/i);
    expect(sql).toMatch(/delivery_zones/i);
  });
});
