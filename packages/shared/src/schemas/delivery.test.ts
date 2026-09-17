import { describe, expect, it } from "vitest";
import { DeliveryZoneSchema } from "./delivery";

describe("DeliveryZoneSchema", () => {
  it("accepts a valid delivery zone", () => {
    const result = DeliveryZoneSchema.safeParse({
      city: "Casablanca",
      fee: 30,
      delayHours: 48,
      cashOnDelivery: true,
      storePickup: false,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a negative fee", () => {
    const result = DeliveryZoneSchema.safeParse({
      city: "Casablanca",
      fee: -5,
      delayHours: 48,
      cashOnDelivery: true,
      storePickup: false,
    });
    expect(result.success).toBe(false);
  });
});
