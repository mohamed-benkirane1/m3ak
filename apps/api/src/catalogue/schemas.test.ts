import { describe, expect, it } from "vitest";
import { ProductRefInputSchema, SearchProductsInputSchema } from "./schemas";

describe("SearchProductsInputSchema", () => {
  it("rejects an empty object", () => {
    expect(() => SearchProductsInputSchema.parse({})).toThrow();
  });

  it("rejects an empty/whitespace-only field", () => {
    expect(() => SearchProductsInputSchema.parse({ model: "   " })).toThrow();
  });

  it("rejects an unknown property", () => {
    expect(() => SearchProductsInputSchema.parse({ model: "x", nope: "y" })).toThrow();
  });

  it("rejects ref combined with another filter", () => {
    expect(() => SearchProductsInputSchema.parse({ ref: "REF-0001", color: "noir" })).toThrow();
  });

  it("accepts ref alone", () => {
    expect(SearchProductsInputSchema.parse({ ref: "REF-0001" })).toEqual({ ref: "REF-0001" });
  });

  it("trims whitespace from valid fields", () => {
    expect(SearchProductsInputSchema.parse({ family: "  Ceinture  " })).toEqual({ family: "Ceinture" });
  });

  it("accepts a genuine multi-field query", () => {
    expect(SearchProductsInputSchema.parse({ family: "Ceinture", color: "bordeaux" })).toEqual({
      family: "Ceinture",
      color: "bordeaux",
    });
  });
});

describe("ProductRefInputSchema", () => {
  it("rejects an empty string", () => {
    expect(() => ProductRefInputSchema.parse("")).toThrow();
  });

  it("rejects a whitespace-only string", () => {
    expect(() => ProductRefInputSchema.parse("   ")).toThrow();
  });

  it("trims and accepts a valid ref", () => {
    expect(ProductRefInputSchema.parse("  REF-0001  ")).toBe("REF-0001");
  });
});
