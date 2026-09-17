import { describe, expect, it } from "vitest";
import { ProductSchema } from "./product";

const validProduct = {
  ref: "REF-001",
  model: "Veste Atlas",
  family: "vestes",
  price: 349.9,
  stock: 12,
};

describe("ProductSchema", () => {
  it("accepts a valid product", () => {
    expect(ProductSchema.safeParse(validProduct).success).toBe(true);
  });

  it("rejects negative stock", () => {
    const result = ProductSchema.safeParse({ ...validProduct, stock: -1 });
    expect(result.success).toBe(false);
  });

  it("rejects negative price", () => {
    const result = ProductSchema.safeParse({ ...validProduct, price: -10 });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown field (strict schema)", () => {
    const result = ProductSchema.safeParse({ ...validProduct, unexpectedField: "x" });
    expect(result.success).toBe(false);
  });

  it("rejects a non-integer stock", () => {
    const result = ProductSchema.safeParse({ ...validProduct, stock: 1.5 });
    expect(result.success).toBe(false);
  });
});
