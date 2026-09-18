import { Product, ProductSchema } from "@m3ak/shared";
import { centimesToMad } from "../infrastructure/money";
import { postgresPool } from "../infrastructure/postgres";
import { withTimeout } from "../infrastructure/timeout";
import { ProductRefInputSchema, SearchProductsInputSchema } from "./schemas";

export const CATALOGUE_QUERY_TIMEOUT_MS = 3_000;

export const PRODUCT_COLUMNS =
  "ref, model, family, gender, color, size, material, season, price_cents, stock, barcode, weight_grams";

export interface ProductRow {
  ref: string;
  model: string;
  family: string;
  gender: string;
  color: string;
  size: string;
  material: string;
  season: string;
  price_cents: number;
  stock: number;
  barcode: string;
  weight_grams: number;
}

export type GetProductResult = { found: true; product: Product } | { found: false };

export type AvailabilityResult =
  | { found: true; ref: string; stock: number; available: boolean }
  | { found: false; ref: string };

// M3AK decision: Product.weight means grams (DB weight_grams maps 1:1, no conversion).
// restock_delay_days / imported_at are never selected here at all: not merely hidden,
// structurally absent from the query, so there is nothing to leak later.
export function mapRowToProduct(row: ProductRow): Product {
  return ProductSchema.parse({
    ref: row.ref,
    model: row.model,
    family: row.family,
    gender: row.gender,
    color: row.color,
    size: row.size,
    material: row.material,
    season: row.season,
    price: centimesToMad(row.price_cents),
    stock: row.stock,
    barcode: row.barcode,
    weight: row.weight_grams,
  });
}

// Neutralizes LIKE/ILIKE wildcard characters in a user-supplied substring so it is
// matched as literal text. Order matters: escape the escape character itself first,
// so the backslashes inserted for % and _ are not re-escaped afterwards.
function escapeLikePattern(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export async function searchProducts(rawInput: unknown): Promise<Product[]> {
  const input = SearchProductsInputSchema.parse(rawInput);

  const conditions: string[] = [];
  const params: unknown[] = [];
  let i = 1;

  // ref is exact and exclusive of every other field (enforced by the input schema).
  if (input.ref !== undefined) {
    conditions.push(`ref = $${i++}`);
    params.push(input.ref);
  }
  // model is the only partial/substring field: the user's own text is escaped, the
  // wrapping "%...%" wildcards are ours, not user-controlled.
  if (input.model !== undefined) {
    conditions.push(`model ILIKE $${i++} ESCAPE '\\'`);
    params.push(`%${escapeLikePattern(input.model)}%`);
  }
  // family/gender/color/size/material/season are exact, case-insensitive matches.
  // lower(x) = lower($n) is used instead of ILIKE here specifically because plain
  // equality never treats % or _ specially, so no escaping is needed for an exact match.
  if (input.family !== undefined) {
    conditions.push(`lower(family) = lower($${i++})`);
    params.push(input.family);
  }
  if (input.gender !== undefined) {
    conditions.push(`lower(gender) = lower($${i++})`);
    params.push(input.gender);
  }
  if (input.color !== undefined) {
    conditions.push(`lower(color) = lower($${i++})`);
    params.push(input.color);
  }
  if (input.size !== undefined) {
    conditions.push(`lower(size) = lower($${i++})`);
    params.push(input.size);
  }
  if (input.material !== undefined) {
    conditions.push(`lower(material) = lower($${i++})`);
    params.push(input.material);
  }
  if (input.season !== undefined) {
    conditions.push(`lower(season) = lower($${i++})`);
    params.push(input.season);
  }

  // At least one condition is guaranteed by the input schema's refine — never an
  // unfiltered "return the whole table". No LIMIT: the full candidate set is
  // returned so ambiguity is never silently hidden.
  const sql = `SELECT ${PRODUCT_COLUMNS} FROM products WHERE ${conditions.join(" AND ")} ORDER BY ref`;

  const { rows } = await withTimeout(
    postgresPool.query<ProductRow>(sql, params),
    CATALOGUE_QUERY_TIMEOUT_MS,
    "searchProducts",
  );
  return rows.map(mapRowToProduct);
}

export async function getProduct(rawRef: unknown): Promise<GetProductResult> {
  const ref = ProductRefInputSchema.parse(rawRef);

  const sql = `SELECT ${PRODUCT_COLUMNS} FROM products WHERE ref = $1`;
  const { rows } = await withTimeout(
    postgresPool.query<ProductRow>(sql, [ref]),
    CATALOGUE_QUERY_TIMEOUT_MS,
    "getProduct",
  );

  if (rows.length === 0) {
    return { found: false };
  }
  return { found: true, product: mapRowToProduct(rows[0] as ProductRow) };
}

export async function getAvailability(rawRef: unknown): Promise<AvailabilityResult> {
  const ref = ProductRefInputSchema.parse(rawRef);

  const sql = "SELECT stock FROM products WHERE ref = $1";
  const { rows } = await withTimeout(
    postgresPool.query<{ stock: number }>(sql, [ref]),
    CATALOGUE_QUERY_TIMEOUT_MS,
    "getAvailability",
  );

  if (rows.length === 0) {
    return { found: false, ref };
  }
  const stock = (rows[0] as { stock: number }).stock;
  return { found: true, ref, stock, available: stock > 0 };
}
