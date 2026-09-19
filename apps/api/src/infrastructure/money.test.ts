import { describe, expect, it } from "vitest";
import { centimesToMad, madToCentimes } from "./money";

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

describe("madToCentimes", () => {
  it("converts 349.9 to 34990", () => {
    expect(madToCentimes(349.9)).toBe(34990);
  });

  it("converts 1 to 100", () => {
    expect(madToCentimes(1)).toBe(100);
  });

  it("rounds to the nearest centime rather than truncating", () => {
    expect(madToCentimes(10.005)).toBe(1001);
    expect(madToCentimes(10.001)).toBe(1000);
  });

  it("rejects zero and negative values", () => {
    expect(() => madToCentimes(0)).toThrow();
    expect(() => madToCentimes(-50)).toThrow();
  });

  it("rejects non-finite values", () => {
    expect(() => madToCentimes(NaN)).toThrow();
    expect(() => madToCentimes(Infinity)).toThrow();
  });
});
