import { describe, expect, it } from "vitest";
import { CustomerSchema } from "./customer";

describe("CustomerSchema", () => {
  it("accepts a customer without a name (unknown at first contact)", () => {
    const result = CustomerSchema.safeParse({
      id: "customer-1",
      createdAt: "2026-01-01T10:00:00Z",
    });
    expect(result.success).toBe(true);
  });

  it("does not fabricate a name when it is absent", () => {
    const result = CustomerSchema.safeParse({
      id: "customer-1",
      createdAt: "2026-01-01T10:00:00Z",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBeUndefined();
      expect("name" in result.data).toBe(false);
    }
  });
});
