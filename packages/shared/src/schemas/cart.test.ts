import { describe, expect, it } from "vitest";
import { CartItemSchema, CartSchema } from "./cart";

describe("CartItemSchema", () => {
  it("accepts quantity 1", () => {
    expect(
      CartItemSchema.safeParse({ productRef: "REF-001", quantity: 1, unitPrice: 10 }).success,
    ).toBe(true);
  });

  it("rejects quantity 0", () => {
    expect(
      CartItemSchema.safeParse({ productRef: "REF-001", quantity: 0, unitPrice: 10 }).success,
    ).toBe(false);
  });

  it("rejects a non-integer quantity", () => {
    expect(
      CartItemSchema.safeParse({ productRef: "REF-001", quantity: 1.5, unitPrice: 10 }).success,
    ).toBe(false);
  });
});

describe("CartSchema", () => {
  it("accepts an empty cart just after creation", () => {
    const result = CartSchema.safeParse({
      id: "cart-1",
      conversationId: "conv-1",
      status: "active",
      version: 0,
      items: [],
    });
    expect(result.success).toBe(true);
  });
});
