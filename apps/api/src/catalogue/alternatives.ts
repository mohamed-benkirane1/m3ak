import { Product } from "@m3ak/shared";
import { postgresPool } from "../infrastructure/postgres";
import { withTimeout } from "../infrastructure/timeout";
import { CATALOGUE_QUERY_TIMEOUT_MS, mapRowToProduct, PRODUCT_COLUMNS, ProductRow } from "./products";
import { ProductRefInputSchema } from "./schemas";

export const MAX_ALTERNATIVES = 3;

export type FindAlternativesResult =
  | { found: true; source: Product; alternatives: Product[] }
  | { found: false; ref: string };

// Same-model dominance: 100 deliberately exceeds every other bonus combined (10+10+3+2=25),
// so a same-model candidate structurally always outranks any non-same-model candidate.
function scoreCandidate(source: ProductRow, candidate: ProductRow): number {
  let score = 0;
  if (candidate.model === source.model) score += 100;
  if (candidate.color === source.color) score += 10;
  if (candidate.size === source.size) score += 10;
  if (candidate.material === source.material) score += 3;
  if (candidate.season === source.season) score += 2;
  return score;
}

// The one hard business rule, expressed once and reused by both the SQL WHERE
// clause and this defensive in-memory filter (intentional duplication).
function isEligible(source: ProductRow, candidate: ProductRow): boolean {
  return (
    candidate.family === source.family &&
    candidate.gender === source.gender &&
    candidate.stock > 0 &&
    candidate.ref !== source.ref
  );
}

// Pure, DB-free, side-effect-free. Defense-in-depth: re-applies isEligible itself so
// it can never return an ineligible row (wrong family/gender, stock<=0, or the source
// itself) even if one is accidentally passed in. Never mutates its inputs.
export function rankAlternatives(source: ProductRow, candidates: ProductRow[]): ProductRow[] {
  return [...candidates]
    .filter((candidate) => isEligible(source, candidate))
    .sort((a, b) => {
      const scoreDiff = scoreCandidate(source, b) - scoreCandidate(source, a);
      if (scoreDiff !== 0) {
        return scoreDiff;
      }

      const priceDistanceA = Math.abs(a.price_cents - source.price_cents);
      const priceDistanceB = Math.abs(b.price_cents - source.price_cents);
      if (priceDistanceA !== priceDistanceB) {
        return priceDistanceA - priceDistanceB;
      }

      if (a.stock !== b.stock) {
        return b.stock - a.stock;
      }

      // Plain code-unit comparison: deterministic, not locale-dependent (unlike
      // localeCompare), sufficient since refs are simple ASCII identifiers.
      if (a.ref < b.ref) return -1;
      if (a.ref > b.ref) return 1;
      return 0;
    })
    .slice(0, MAX_ALTERNATIVES);
}

export async function findAlternatives(rawRef: unknown): Promise<FindAlternativesResult> {
  const ref = ProductRefInputSchema.parse(rawRef);

  const sourceResult = await withTimeout(
    postgresPool.query<ProductRow>(`SELECT ${PRODUCT_COLUMNS} FROM products WHERE ref = $1`, [ref]),
    CATALOGUE_QUERY_TIMEOUT_MS,
    "findAlternatives:source",
  );
  if (sourceResult.rows.length === 0) {
    return { found: false, ref };
  }
  const source = sourceResult.rows[0] as ProductRow;

  // No SQL LIMIT/ORDER BY here: the complete eligible set is ranked in JS before slicing.
  const candidatesResult = await withTimeout(
    postgresPool.query<ProductRow>(
      "SELECT " +
        PRODUCT_COLUMNS +
        " FROM products WHERE family = $1 AND gender = $2 AND stock > 0 AND ref <> $3",
      [source.family, source.gender, source.ref],
    ),
    CATALOGUE_QUERY_TIMEOUT_MS,
    "findAlternatives:candidates",
  );

  const alternatives = rankAlternatives(source, candidatesResult.rows);

  return {
    found: true,
    source: mapRowToProduct(source),
    alternatives: alternatives.map(mapRowToProduct),
  };
}
