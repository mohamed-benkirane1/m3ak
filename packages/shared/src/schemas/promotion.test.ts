import { describe, expect, it } from "vitest";
import { PromotionSchema } from "./promotion";

const validPromotion = {
  id: "promo-1",
  productRef: "REF-001",
  normalPrice: 100,
  promoPrice: 80,
  startsAt: "2026-01-01T00:00:00Z",
  endsAt: "2026-01-31T00:00:00Z",
};

describe("PromotionSchema", () => {
  it("accepts a valid promotion", () => {
    expect(PromotionSchema.safeParse(validPromotion).success).toBe(true);
  });

  it("rejects a promoPrice higher than normalPrice", () => {
    const result = PromotionSchema.safeParse({ ...validPromotion, promoPrice: 120 });
    expect(result.success).toBe(false);
  });

  it("rejects an endsAt before startsAt", () => {
    const result = PromotionSchema.safeParse({
      ...validPromotion,
      startsAt: "2026-01-31T00:00:00Z",
      endsAt: "2026-01-01T00:00:00Z",
    });
    expect(result.success).toBe(false);
  });
});
