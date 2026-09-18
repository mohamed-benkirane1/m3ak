import { z } from "zod";
import { DeliveryZone, DeliveryZoneSchema } from "@m3ak/shared";
import { centimesToMad } from "../infrastructure/money";
import { postgresPool } from "../infrastructure/postgres";
import { withTimeout } from "../infrastructure/timeout";

const DELIVERY_QUERY_TIMEOUT_MS = 3_000;

// Trim only: case differences are accepted at lookup time (SQL does
// lower(city) = lower($1)), but accents/punctuation are never normalized here
// (TASK-010A: no source-backed alias/accent map exists in this repository).
// No arbitrary max length — a city name that does not match the grid simply
// resolves to found:false regardless of length, and this is an equality
// lookup, never a LIKE/ILIKE pattern, so an unbounded string is not a
// performance or injection risk.
const CityInputSchema = z.string().trim().min(1);

interface DeliveryZoneRow {
  city: string;
  fee_cents: number;
  delay_hours: number;
  cash_on_delivery: boolean;
  store_pickup: boolean;
}

export type DeliveryLookupResult =
  | { found: true; zone: DeliveryZone }
  | { found: false; city: string; reason: "city_not_in_delivery_grid" };

function mapRowToDeliveryZone(row: DeliveryZoneRow): DeliveryZone {
  return DeliveryZoneSchema.parse({
    city: row.city,
    fee: centimesToMad(row.fee_cents),
    delayHours: row.delay_hours,
    cashOnDelivery: row.cash_on_delivery,
    storePickup: row.store_pickup,
  });
}

export async function getDeliveryOptions(rawCity: unknown): Promise<DeliveryLookupResult> {
  const city = CityInputSchema.parse(rawCity);

  const { rows } = await withTimeout(
    postgresPool.query<DeliveryZoneRow>(
      `SELECT city, fee_cents, delay_hours, cash_on_delivery, store_pickup
       FROM delivery_zones
       WHERE lower(city) = lower($1)`,
      [city],
    ),
    DELIVERY_QUERY_TIMEOUT_MS,
    "getDeliveryOptions",
  );

  if (rows.length === 0) {
    return { found: false, city, reason: "city_not_in_delivery_grid" };
  }
  if (rows.length > 1) {
    // city is only unique in the case-sensitive sense (TEXT PRIMARY KEY): a
    // future re-seed could in principle insert two rows differing only by
    // case, which this case-insensitive lookup would then have to choose
    // between. Fail loudly instead of silently picking one (TASK-009's
    // resolvePromotionContext established the same pattern for promotions).
    throw new Error(`Integrity error: ${rows.length} delivery zones found for city "${city}" (expected at most 1)`);
  }

  return { found: true, zone: mapRowToDeliveryZone(rows[0] as DeliveryZoneRow) };
}
