import { z } from "zod";

const NonEmptyTrimmedString = z.string().trim().min(1, "must be a non-empty value after trimming");

// Counts only criteria the caller actually supplied (an explicit `undefined`
// value never counts as "provided"), independent of whether Zod happens to
// preserve undefined-valued keys on the parsed object.
function providedKeys(value: Record<string, unknown>): string[] {
  return Object.entries(value)
    .filter(([, fieldValue]) => fieldValue !== undefined)
    .map(([key]) => key);
}

export const SearchProductsInputSchema = z
  .object({
    ref: NonEmptyTrimmedString.optional(),
    model: NonEmptyTrimmedString.optional(),
    family: NonEmptyTrimmedString.optional(),
    gender: NonEmptyTrimmedString.optional(),
    color: NonEmptyTrimmedString.optional(),
    size: NonEmptyTrimmedString.optional(),
    material: NonEmptyTrimmedString.optional(),
    season: NonEmptyTrimmedString.optional(),
  })
  .strict()
  .refine((value) => providedKeys(value).length > 0, {
    message: "at least one search criterion is required",
  })
  .refine(
    (value) => {
      const keys = providedKeys(value);
      return !keys.includes("ref") || keys.length === 1;
    },
    { message: "ref must be the only criterion when supplied" },
  );

export type SearchProductsInput = z.infer<typeof SearchProductsInputSchema>;

// Shared by getProduct(ref) and getAvailability(ref).
export const ProductRefInputSchema = NonEmptyTrimmedString;
