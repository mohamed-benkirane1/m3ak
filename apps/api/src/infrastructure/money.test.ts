import { describe, expect, it } from "vitest";
import { centimesToMad } from "./money";

describe("centimesToMad", () => {
  it("converts 34990 to 349.9", () => {
    expect(centimesToMad(34990)).toBe(349.9);
  });

  it("converts 100 to 1", () => {
    expect(centimesToMad(100)).toBe(1);
  });

  it("converts 1 to 0.01", () => {
    expect(centimesToMad(1)).toBe(0.01);
  });

  it("rejects negative values", () => {
    expect(() => centimesToMad(-100)).toThrow();
  });

  it("rejects non-integer values", () => {
    expect(() => centimesToMad(100.5)).toThrow();
  });

  it("rejects unsafe integers", () => {
    expect(() => centimesToMad(2 ** 60)).toThrow();
  });
});
