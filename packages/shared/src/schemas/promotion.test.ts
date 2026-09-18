import { describe, expect, it } from "vitest";
import { PromotionSchema } from "./promotion";

const validPromotion = {
  id: "promo-1",
  productRef: "REF-001",
  normalPrice: 100,
  promoPrice: 80,
  startsAt: "2026-09-01",
  endsAt: "2026-09-30",
};

describe("PromotionSchema", () => {
  it("accepts a valid promotion with calendar dates", () => {
    expect(PromotionSchema.safeParse(validPromotion).success).toBe(true);
  });

  it("accepts 2026-09-01 as a starts date", () => {
    const result = PromotionSchema.safeParse({ ...validPromotion, startsAt: "2026-09-01" });
    expect(result.success).toBe(true);
  });

  it("rejects a full timestamp for a promotion date", () => {
    const result = PromotionSchema.safeParse({
      ...validPromotion,
      startsAt: "2026-09-01T00:00:00Z",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid date", () => {
    const result = PromotionSchema.safeParse({ ...validPromotion, startsAt: "2026-02-30" });
    expect(result.success).toBe(false);
  });

  it("rejects a promoPrice higher than normalPrice", () => {
    const result = PromotionSchema.safeParse({ ...validPromotion, promoPrice: 120 });
    expect(result.success).toBe(false);
  });

  it("rejects an endsAt before startsAt", () => {
    const result = PromotionSchema.safeParse({
      ...validPromotion,
      startsAt: "2026-09-30",
      endsAt: "2026-09-01",
    });
    expect(result.success).toBe(false);
  });
});
