import { Pool, PoolClient } from "pg";
import { IsoDateSchema, Product, Promotion, PromotionSchema } from "@m3ak/shared";
import { centimesToMad } from "../infrastructure/money";
import { postgresPool } from "../infrastructure/postgres";
import { withTimeout } from "../infrastructure/timeout";
import { CATALOGUE_QUERY_TIMEOUT_MS, mapRowToProduct, PRODUCT_COLUMNS, ProductRow } from "./products";
import { ProductRefInputSchema } from "./schemas";

// Accepts either the shared pool or a single checked-out transaction client
// (same pattern already established in cart.ts/delivery.ts). useClientTimeout
// defaults to true so every existing 2-argument caller keeps its exact current
// behavior; TASK-012's createOrder passes { executor: client, useClientTimeout:
// false } to read on its own transaction without racing a client-side timer
// against a query already governed by that transaction's own server-side
// statement_timeout.
interface PricingExecutionOptions {
  executor?: Pool | PoolClient;
  useClientTimeout?: boolean;
}

// The only condition string audited across all 12 real Kenza promotions
// (TASK-009B). It requires no context beyond product ref + as-of date: it is
// standard "while stocks last" boilerplate, and stock is already part of the
// same product row this module fetches. Any other condition text is unknown
// territory and must fail loudly rather than be silently honored.
const STOCK_AVAILABLE_CONDITION = "dans la limite des stocks disponibles";

// M3AK's autonomous/discretionary discount ceiling. Not independently
// verifiable from an official policy document in this repository (TASK-009A);
// implemented per explicit HACK-CTRL instruction.
const DISCRETIONARY_DISCOUNT_PERCENT = 10;

interface PromotionRow {
  id: string;
  product_ref: string;
  normal_price_cents: number;
  promo_price_cents: number;
  starts_at: string;
  ends_at: string;
  condition: string;
}

export type ApplicablePromotionResult =
  | { found: false; reason: "product_not_found"; ref: string }
  | { found: true; product: Product; promotion: null }
  | { found: true; product: Product; promotion: Promotion };

export type ValidateDiscountResult =
  | {
      allowed: true;
      productRef: string;
      basePriceCents: number;
      minimumAllowedPriceCents: number;
      requestedPriceCents: number;
      reason: "no_discount_requested" | "within_discretionary_limit" | "active_promotion_price";
    }
  | {
      allowed: false;
      requiresEscalation: true;
      productRef: string;
      basePriceCents: number;
      minimumAllowedPriceCents: number;
      requestedPriceCents: number;
      reason: "discount_exceeds_limit" | "active_promotion_no_further_discount";
    }
  | {
      allowed: false;
      requiresEscalation: false;
      productRef: string;
      requestedPriceCents: number;
      reason: "price_above_authoritative_base";
    }
  | {
      allowed: false;
      requiresEscalation: false;
      productRef: string;
      reason: "product_not_found";
    };

function mapRowToPromotion(row: PromotionRow): Promotion {
  return PromotionSchema.parse({
    id: row.id,
    productRef: row.product_ref,
    normalPrice: centimesToMad(row.normal_price_cents),
    promoPrice: centimesToMad(row.promo_price_cents),
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    condition: row.condition,
  });
}

// Exact-integer ceiling-division: the minimum price after at most a 10%
// autonomous discount, i.e. ceil(basePriceCents * 90 / 100), computed with
// only integer multiplication/addition/floor-division — no floating-point
// step anywhere in this authorization path.
function minimumAutonomousPriceCents(basePriceCents: number): number {
  return Math.floor((basePriceCents * (100 - DISCRETIONARY_DISCOUNT_PERCENT) + 99) / 100);
}

function assertValidRequestedPriceCents(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`requestedPriceCents must be a finite number, got ${String(value)}`);
  }
  if (!Number.isInteger(value)) {
    throw new Error(`requestedPriceCents must be an integer, got ${value}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new Error(`requestedPriceCents must be a safe integer, got ${value}`);
  }
  if (value <= 0) {
    throw new Error(`requestedPriceCents must be a positive number, got ${value}`);
  }
  return value;
}

type ResolvedPromotionContext =
  | { found: false }
  | { found: true; productRow: ProductRow; promotionRow: PromotionRow | null };

// Single authoritative resolution path shared by getApplicablePromotion and
// validateDiscount: both public functions must apply IDENTICAL condition/
// stock/price-integrity rules, and validateDiscount needs the raw integer
// cents values (never the MAD-converted, floating-point Product/Promotion
// shape) for its authoritative arithmetic — a cents -> MAD -> cents round
// trip through centimesToMad would reintroduce exactly the floating-point
// risk this module exists to avoid, even though it happens to be lossless
// for realistic prices. Sharing this resolver keeps both functions using the
// exact same DB queries and business rules, deliberately not exported.
async function resolvePromotionContext(
  ref: string,
  asOfDate: string,
  options: PricingExecutionOptions = {},
): Promise<ResolvedPromotionContext> {
  const { executor = postgresPool, useClientTimeout = true } = options;

  const productSql = `SELECT ${PRODUCT_COLUMNS} FROM products WHERE ref = $1`;
  const productResult = useClientTimeout
    ? await withTimeout(executor.query<ProductRow>(productSql, [ref]), CATALOGUE_QUERY_TIMEOUT_MS, "promotions:product")
    : await executor.query<ProductRow>(productSql, [ref]);
  if (productResult.rows.length === 0) {
    return { found: false };
  }
  const productRow = productResult.rows[0] as ProductRow;

  // starts_at::text / ends_at::text: pg's default DATE type parsing returns JS
  // Date objects (verified empirically in TASK-009A), which would fail
  // IsoDateSchema/PromotionSchema validation and risk timezone bugs if ever
  // reformatted via getDate()/toLocaleDateString(). Casting to text in SQL
  // sidesteps this entirely — the value is a plain 'YYYY-MM-DD' string the
  // moment it reaches JS, never a Date object.
  const promotionSql = `SELECT id, product_ref, normal_price_cents, promo_price_cents,
              starts_at::text AS starts_at, ends_at::text AS ends_at, condition
       FROM promotions
       WHERE product_ref = $1 AND starts_at <= $2::date AND ends_at >= $2::date`;
  const promotionResult = useClientTimeout
    ? await withTimeout(
        executor.query<PromotionRow>(promotionSql, [ref, asOfDate]),
        CATALOGUE_QUERY_TIMEOUT_MS,
        "promotions:activePromotion",
      )
    : await executor.query<PromotionRow>(promotionSql, [ref, asOfDate]);

  if (promotionResult.rows.length === 0) {
    return { found: true, productRow, promotionRow: null };
  }
  if (promotionResult.rows.length > 1) {
    throw new Error(
      `Integrity error: ${promotionResult.rows.length} active promotions found for product "${ref}" as of ${asOfDate} (expected at most 1)`,
    );
  }

  const promotionRow = promotionResult.rows[0] as PromotionRow;

  if (promotionRow.condition !== STOCK_AVAILABLE_CONDITION) {
    throw new Error(`Unsupported promotion condition for product "${ref}": "${promotionRow.condition}"`);
  }

  // The known condition means the promotion applies while stock is available;
  // stock=0 already makes the product unsellable at any price via the
  // existing availability/cart guardrails, so the promotion is reported as
  // absent here rather than exposed as a moot active row.
  if (productRow.stock <= 0) {
    return { found: true, productRow, promotionRow: null };
  }

  if (promotionRow.normal_price_cents !== productRow.price_cents) {
    throw new Error(
      `Integrity error: promotion normal_price_cents (${promotionRow.normal_price_cents}) does not match product price_cents (${productRow.price_cents}) for "${ref}"`,
    );
  }

  return { found: true, productRow, promotionRow };
}

export type ProductPricingContextResult =
  | { found: false; ref: string }
  | {
      found: true;
      ref: string;
      stock: number;
      cataloguePriceCents: number;
      effectivePriceCents: number;
      promotionActive: boolean;
    };

// Narrow, cents-safe public surface onto resolvePromotionContext for callers
// (TASK-011's cart) that need authoritative stock + price without either
// exposing the private raw DB row shapes or round-tripping through the
// MAD-converted Product/Promotion contracts (see resolvePromotionContext's own
// comment on why that round trip is deliberately avoided). Inherits every
// existing integrity/condition/stock rule unchanged: a stock=0 "while stocks
// last" promotion still resolves here as promotionActive:false, catalogue
// price — addCartItem's own stock check is what rejects that case, not this
// function pretending the promotion is inactive for any other reason.
export async function getProductPricingContext(
  rawRef: unknown,
  rawAsOfDate: unknown,
  options: PricingExecutionOptions = {},
): Promise<ProductPricingContextResult> {
  const ref = ProductRefInputSchema.parse(rawRef);
  const asOfDate = IsoDateSchema.parse(rawAsOfDate);

  const context = await resolvePromotionContext(ref, asOfDate, options);
  if (!context.found) {
    return { found: false, ref };
  }

  const { productRow, promotionRow } = context;
  return {
    found: true,
    ref,
    stock: productRow.stock,
    cataloguePriceCents: productRow.price_cents,
    effectivePriceCents: promotionRow ? promotionRow.promo_price_cents : productRow.price_cents,
    promotionActive: promotionRow !== null,
  };
}

export async function getApplicablePromotion(
  rawRef: unknown,
  rawAsOfDate: unknown,
): Promise<ApplicablePromotionResult> {
  const ref = ProductRefInputSchema.parse(rawRef);
  const asOfDate = IsoDateSchema.parse(rawAsOfDate);

  const context = await resolvePromotionContext(ref, asOfDate);
  if (!context.found) {
    return { found: false, reason: "product_not_found", ref };
  }

  return {
    found: true,
    product: mapRowToProduct(context.productRow),
    promotion: context.promotionRow ? mapRowToPromotion(context.promotionRow) : null,
  };
}

export async function validateDiscount(
  rawProductRef: unknown,
  rawRequestedPriceCents: unknown,
  rawAsOfDate: unknown,
): Promise<ValidateDiscountResult> {
  const productRef = ProductRefInputSchema.parse(rawProductRef);
  const requestedPriceCents = assertValidRequestedPriceCents(rawRequestedPriceCents);
  const asOfDate = IsoDateSchema.parse(rawAsOfDate);

  const context = await resolvePromotionContext(productRef, asOfDate);
  if (!context.found) {
    return { allowed: false, requiresEscalation: false, productRef, reason: "product_not_found" };
  }

  const activePromotion = context.promotionRow;
  // Active promotion: promo price is authoritative for both base and floor —
  // no autonomous discount stacks below it (M3AK safety policy, not a source
  // fact — see TASK-009A). No promotion: catalogue price is the base, and the
  // 10% ceiling formula computes the floor.
  const basePriceCents = activePromotion ? activePromotion.promo_price_cents : context.productRow.price_cents;
  const minimumAllowedPriceCents = activePromotion
    ? activePromotion.promo_price_cents
    : minimumAutonomousPriceCents(basePriceCents);

  if (requestedPriceCents > basePriceCents) {
    return {
      allowed: false,
      requiresEscalation: false,
      productRef,
      requestedPriceCents,
      reason: "price_above_authoritative_base",
    };
  }

  if (requestedPriceCents === basePriceCents) {
    return {
      allowed: true,
      productRef,
      basePriceCents,
      minimumAllowedPriceCents,
      requestedPriceCents,
      reason: activePromotion ? "active_promotion_price" : "no_discount_requested",
    };
  }

  // requestedPriceCents < basePriceCents from here on. While a promotion is
  // active, minimumAllowedPriceCents === basePriceCents, so this branch is
  // structurally unreachable in that state — any request below the promo
  // price always falls through to the final, escalation branch below.
  if (requestedPriceCents >= minimumAllowedPriceCents) {
    return {
      allowed: true,
      productRef,
      basePriceCents,
      minimumAllowedPriceCents,
      requestedPriceCents,
      reason: "within_discretionary_limit",
    };
  }

  return {
    allowed: false,
    requiresEscalation: true,
    productRef,
    basePriceCents,
    minimumAllowedPriceCents,
    requestedPriceCents,
    reason: activePromotion ? "active_promotion_no_further_discount" : "discount_exceeds_limit",
  };
}
