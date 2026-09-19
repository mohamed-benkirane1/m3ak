import { AllowedActionSchema } from "./orchestrator";
import type { M3AKState } from "./state";

export type GuardrailReason =
  | "unverifiable_observation"
  | "missing_stock_evidence"
  | "missing_promotion_evidence"
  | "missing_delivery_evidence"
  | "ambiguous_product_reference"
  | "unsupported_restock_claim"
  | "agent_step_limit_reached";

export interface GuardrailDecision {
  authorized: boolean | null;
  clarificationNeeded: boolean;
  humanInterventionNeeded: boolean;
  reasons: string[];
  promotionPatch?: M3AKState["promotion"];
  deliveryPatch?: M3AKState["delivery"];
}

// tool never executes RESPOND/ESCALATE (actionExecutor.ts throws on them), so
// neither may ever legitimately appear as lastResult.action.
const RECOGNIZED_OBSERVATION_ACTIONS = new Set(
  AllowedActionSchema.options.filter((action) => action !== "RESPOND" && action !== "ESCALATE"),
);
type RecognizedObservationAction = Exclude<(typeof AllowedActionSchema.options)[number], "RESPOND" | "ESCALATE">;

const BASE_DECISION: GuardrailDecision = {
  authorized: null,
  clarificationNeeded: false,
  humanInterventionNeeded: false,
  reasons: [],
};

// Discount protection is structural, not an active check here: validateDiscount()
// needs a requestedPriceCents argument that has no grounded source anywhere in
// M3AKState (no orchestrator action produces or carries one), so no lastResult
// this guardrail ever sees can legitimately represent discount authorization.
// Nothing below authorizes a discount value; a malformed attempt to smuggle one
// in fails the ordinary provenance/shape checks like any other bad observation.

// "small defensive recursive-or-shallow-safe scan": lastResult has already
// passed the outer M3AKStateSchema JSON-safety boundary by the time this runs
// (invokeSalesGraph), so it is guaranteed acyclic — safe to recurse plainly.
const FORBIDDEN_RESTOCK_KEYS = new Set(["restockDate", "restockDays", "restockAt", "expectedRestock"]);

function containsForbiddenRestockKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsForbiddenRestockKey);
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, nested] of Object.entries(value)) {
      if (FORBIDDEN_RESTOCK_KEYS.has(key)) return true;
      if (containsForbiddenRestockKey(nested)) return true;
    }
  }
  return false;
}

// The one controlled, provenance-valid marker actionExecutor.ts may return for
// ANY action when required inputs were absent (never a thrown error).
function isMissingInputMarker(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    !Array.isArray(result) &&
    Object.keys(result).length === 1 &&
    (result as Record<string, unknown>).reason === "missing_required_input"
  );
}

function hasValidResultShape(action: RecognizedObservationAction, result: unknown): boolean {
  if (isMissingInputMarker(result)) return true;
  if (action === "SEARCH_PRODUCTS") {
    return Array.isArray(result);
  }
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return false;
  }
  const record = result as Record<string, unknown>;
  switch (action) {
    case "CHECK_STOCK":
    case "FIND_ALTERNATIVES":
    case "CHECK_PROMOTION":
    case "CHECK_DELIVERY":
      return typeof record.found === "boolean";
    case "CREATE_CART":
    case "CREATE_ORDER":
      return typeof record.created === "boolean";
    case "ADD_TO_CART":
    case "UPDATE_CART_ITEM":
      return typeof record.ok === "boolean";
    case "REMOVE_CART_ITEM":
      return typeof record.removed === "boolean";
    default:
      return false;
  }
}

// Precondition: called only when lastResult !== null.
function isMalformedLastResult(lastResult: NonNullable<M3AKState["lastResult"]>): boolean {
  if (typeof lastResult !== "object" || Array.isArray(lastResult)) {
    return true;
  }
  const record = lastResult as Record<string, unknown>;
  const action = record.action;
  if (typeof action !== "string" || !RECOGNIZED_OBSERVATION_ACTIONS.has(action as RecognizedObservationAction)) {
    return true;
  }
  return !hasValidResultShape(action as RecognizedObservationAction, record.result);
}

function evaluateSearchProducts(result: unknown, resolvedRef: unknown, nextAction: string | null): Partial<GuardrailDecision> {
  if (isMissingInputMarker(result)) {
    return { authorized: false, clarificationNeeded: true, reasons: ["ambiguous_product_reference"] };
  }
  const hasResolvedRef = typeof resolvedRef === "string" && resolvedRef.length > 0;
  if (hasResolvedRef) {
    return { authorized: true, reasons: [] };
  }
  if (nextAction === "RESPOND") {
    return { authorized: false, clarificationNeeded: true, reasons: ["ambiguous_product_reference"] };
  }
  // Ambiguous but nothing is being finalized yet — no claim to authorize.
  return { authorized: null, reasons: [] };
}

function evaluateFoundBasedAction(result: unknown, missingReason: GuardrailReason): Partial<GuardrailDecision> {
  if (isMissingInputMarker(result)) {
    return { authorized: false, reasons: [missingReason] };
  }
  const record = result as Record<string, unknown>;
  if (record.found === true) {
    return { authorized: true, reasons: [] };
  }
  return { authorized: false, reasons: [missingReason] };
}

function evaluateCheckPromotion(result: unknown): Partial<GuardrailDecision> {
  if (isMissingInputMarker(result)) {
    return { authorized: false, reasons: ["missing_promotion_evidence"] };
  }
  const record = result as Record<string, unknown>;
  if (record.found !== true) {
    return { authorized: false, reasons: ["missing_promotion_evidence"] };
  }
  const promotion = record.promotion;
  if (promotion === null) {
    return { authorized: true, reasons: [], promotionPatch: null };
  }
  if (typeof promotion === "object") {
    const p = promotion as Record<string, unknown>;
    if (typeof p.id === "string" && typeof p.productRef === "string" && typeof p.promoPrice === "number") {
      return { authorized: true, reasons: [], promotionPatch: { id: p.id, productRef: p.productRef, promoPrice: p.promoPrice } };
    }
  }
  return { authorized: false, reasons: ["missing_promotion_evidence"] };
}

function evaluateCheckDelivery(result: unknown): Partial<GuardrailDecision> {
  if (isMissingInputMarker(result)) {
    return { authorized: false, clarificationNeeded: true, reasons: ["missing_delivery_evidence"] };
  }
  const record = result as Record<string, unknown>;
  if (record.found !== true) {
    return { authorized: false, clarificationNeeded: true, reasons: ["missing_delivery_evidence"] };
  }
  const zone = record.zone;
  const feeCents = record.feeCents;
  if (typeof zone === "object" && zone !== null) {
    const z = zone as Record<string, unknown>;
    if (
      typeof z.city === "string" &&
      typeof z.delayHours === "number" &&
      typeof z.cashOnDelivery === "boolean" &&
      typeof z.storePickup === "boolean" &&
      typeof feeCents === "number"
    ) {
      return {
        authorized: true,
        reasons: [],
        deliveryPatch: { city: z.city, feeCents, delayHours: z.delayHours, cashOnDelivery: z.cashOnDelivery, storePickup: z.storePickup },
      };
    }
  }
  return { authorized: false, clarificationNeeded: true, reasons: ["missing_delivery_evidence"] };
}

// CREATE_CART / ADD_TO_CART / CREATE_ORDER: both a real success and an honest
// typed negative outcome are safe, provenance-verified observations. Cart/
// orderId promotion is TASK-020's job, not this guardrail's — never touched
// here.
function evaluateSimpleDeterministic(): Partial<GuardrailDecision> {
  return { authorized: true, reasons: [] };
}

function evaluatePerAction(
  action: RecognizedObservationAction,
  result: unknown,
  resolvedRef: unknown,
  nextAction: string | null,
): Partial<GuardrailDecision> {
  switch (action) {
    case "SEARCH_PRODUCTS":
      return evaluateSearchProducts(result, resolvedRef, nextAction);
    case "CHECK_STOCK":
    case "FIND_ALTERNATIVES":
      return evaluateFoundBasedAction(result, "missing_stock_evidence");
    case "CHECK_PROMOTION":
      return evaluateCheckPromotion(result);
    case "CHECK_DELIVERY":
      return evaluateCheckDelivery(result);
    case "CREATE_CART":
    case "ADD_TO_CART":
    case "UPDATE_CART_ITEM":
    case "REMOVE_CART_ITEM":
    case "CREATE_ORDER":
      return evaluateSimpleDeterministic();
  }
}

// Pure, synchronous, deterministic: no DB, no Redis, no LLM, no network.
// Only ever reads state — never mutates it.
export function evaluateCommercialGuardrails(state: M3AKState): GuardrailDecision {
  if (state.lastError === "agent_step_limit_reached") {
    return { ...BASE_DECISION, authorized: false, humanInterventionNeeded: true, reasons: ["agent_step_limit_reached"] };
  }

  const lastResult = state.lastResult;

  if (lastResult !== null && isMalformedLastResult(lastResult)) {
    return { ...BASE_DECISION, authorized: false, humanInterventionNeeded: true, reasons: ["unverifiable_observation"] };
  }

  if (state.nextAction === "ESCALATE") {
    return { ...BASE_DECISION, authorized: null, clarificationNeeded: false, humanInterventionNeeded: true };
  }

  if (lastResult === null) {
    return { ...BASE_DECISION };
  }

  const record = lastResult as Record<string, unknown>;
  const action = record.action as RecognizedObservationAction; // provenance-validated above
  const perAction = evaluatePerAction(action, record.result, record.resolvedRef, state.nextAction);

  const decision: GuardrailDecision = {
    ...BASE_DECISION,
    ...perAction,
    reasons: perAction.reasons ?? [],
  };

  // Restock override wins over any per-action authorization, and strips any
  // patch that would otherwise ride along with an unauthorized decision.
  if (containsForbiddenRestockKey(record.result)) {
    decision.authorized = false;
    if (!decision.reasons.includes("unsupported_restock_claim")) {
      decision.reasons = [...decision.reasons, "unsupported_restock_claim"];
    }
    delete decision.promotionPatch;
    delete decision.deliveryPatch;
  }

  return decision;
}
