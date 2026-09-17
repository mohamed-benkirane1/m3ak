import { describe, expect, it } from "vitest";
import { LanguageSchema } from "./language";

describe("LanguageSchema", () => {
  it.each(["darija", "arabic", "french", "mixed", "unknown"] as const)(
    "accepts %s",
    (value) => {
      expect(LanguageSchema.safeParse(value).success).toBe(true);
    },
  );

  it("rejects english", () => {
    expect(LanguageSchema.safeParse("english").success).toBe(false);
  });
});
