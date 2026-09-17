import { describe, expect, it } from "vitest";
import { OrderSchema } from "./order";

const validOrder = {
  id: "order-1",
  customerId: "customer-1",
  conversationId: "conv-1",
  status: "confirmed",
  productsTotal: 349.9,
  deliveryFee: 30,
  total: 379.9,
  city: "Casablanca",
  paymentMethod: "cash_on_delivery",
  items: [{ productRef: "REF-001", quantity: 1, unitPrice: 349.9 }],
  createdAt: "2026-01-01T10:00:00Z",
};

describe("OrderSchema", () => {
  it("accepts a valid order", () => {
    expect(OrderSchema.safeParse(validOrder).success).toBe(true);
  });

  it("rejects a negative total", () => {
    const result = OrderSchema.safeParse({ ...validOrder, total: -1 });
    expect(result.success).toBe(false);
  });

  it("rejects an order with no items", () => {
    const result = OrderSchema.safeParse({ ...validOrder, items: [] });
    expect(result.success).toBe(false);
  });

  it("rejects a cancelled status (not yet part of the documented lifecycle)", () => {
    const result = OrderSchema.safeParse({ ...validOrder, status: "cancelled" });
    expect(result.success).toBe(false);
  });
});
