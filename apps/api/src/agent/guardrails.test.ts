import { describe, expect, it } from "vitest";
import { evaluateCommercialGuardrails, type GuardrailReason } from "./guardrails";
import type { M3AKState } from "./state";

const ALL_REASON_CODES: GuardrailReason[] = [
  "unverifiable_observation",
  "missing_stock_evidence",
  "missing_promotion_evidence",
  "missing_delivery_evidence",
  "ambiguous_product_reference",
  "unsupported_restock_claim",
  "agent_step_limit_reached",
];

const baseState: M3AKState = {
  threadId: "thread-021",
  conversationId: null,
  customerId: null,
  customerMemory: null,
  messages: [],
  summary: null,
  language: "unknown",
  intent: "unknown",
  extraction: {
    productQuery: null, family: null, color: null, size: null, quantity: null,
    city: null, address: null, paymentMethod: null, confirmation: null,
  },
  cart: null,
  promotion: null,
  delivery: null,
  alternatives: [],
  cartTotalCents: null,
  nextAction: null,
  activePlan: [],
  executedSteps: [],
  iterationCount: 0,
  lastResult: null,
  lastError: null,
  authorized: null,
  clarificationNeeded: false,
  humanInterventionNeeded: false,
  guardrailReasons: [],
  orderId: null,
  escalationId: null,
  followupId: null,
};

function withState(overrides: Partial<M3AKState>): M3AKState {
  return { ...baseState, ...overrides };
}

function assertOnlyKnownReasons(reasons: string[]) {
  for (const reason of reasons) {
    expect(ALL_REASON_CODES).toContain(reason);
  }
}

describe("evaluateCommercialGuardrails — base cases (1, 2, 3)", () => {
  it("1: neutral decision when lastResult is null", () => {
    const decision = evaluateCommercialGuardrails(withState({ lastResult: null }));
    expect(decision).toEqual({ authorized: null, clarificationNeeded: false, humanInterventionNeeded: false, reasons: [] });
  });

  it("2: step-limit override takes priority and is not a normal neutral end state", () => {
    const decision = evaluateCommercialGuardrails(
      withState({ lastError: "agent_step_limit_reached", lastResult: null, nextAction: null }),
    );
    expect(decision).toEqual({
      authorized: false, clarificationNeeded: false, humanInterventionNeeded: true, reasons: ["agent_step_limit_reached"],
    });
  });

  it("2b: step-limit override wins even over a well-formed observation", () => {
    const decision = evaluateCommercialGuardrails(
      withState({
        lastError: "agent_step_limit_reached",
        lastResult: { action: "CHECK_STOCK", ok: true, result: { found: true, available: true }, resolvedRef: "REF-001" },
      }),
    );
    expect(decision.authorized).toBe(false);
    expect(decision.humanInterventionNeeded).toBe(true);
    expect(decision.reasons).toEqual(["agent_step_limit_reached"]);
  });

  it("3: ESCALATE terminal signals human intervention without persisting anything", () => {
    const decision = evaluateCommercialGuardrails(withState({ nextAction: "ESCALATE", lastResult: null }));
    expect(decision).toEqual({ authorized: null, clarificationNeeded: false, humanInterventionNeeded: true, reasons: [] });
  });

  it("3b: ESCALATE with a well-formed prior observation still escalates", () => {
    const decision = evaluateCommercialGuardrails(
      withState({
        nextAction: "ESCALATE",
        lastResult: { action: "CHECK_DELIVERY", ok: true, result: { found: false, city: "X", reason: "city_not_in_delivery_grid" }, resolvedRef: null },
      }),
    );
    expect(decision.authorized).toBeNull();
    expect(decision.humanInterventionNeeded).toBe(true);
  });

  it("3c: a malformed observation takes priority over the ESCALATE rule", () => {
    const decision = evaluateCommercialGuardrails(withState({ nextAction: "ESCALATE", lastResult: "not-an-object" as never }));
    expect(decision.reasons).toEqual(["unverifiable_observation"]);
    expect(decision.humanInterventionNeeded).toBe(true);
  });
});

describe("evaluateCommercialGuardrails — malformed observations (4-9)", () => {
  const malformedCases: Array<[string, unknown]> = [
    ["4: primitive string", "not-an-object"],
    ["4b: primitive number", 42],
    ["5: array", [1, 2, 3]],
    ["6: object missing action", { ok: true, result: {}, resolvedRef: null }],
    ["7: unknown action", { action: "FLY_TO_MOON", ok: true, result: {}, resolvedRef: null }],
    ["8a: RESPOND as action", { action: "RESPOND", ok: true, result: {}, resolvedRef: null }],
    ["8b: ESCALATE as action", { action: "ESCALATE", ok: true, result: {}, resolvedRef: null }],
    ["9: recognized action, wrong result shape", { action: "CHECK_STOCK", ok: true, result: { stock: 5 }, resolvedRef: null }],
  ];

  it.each(malformedCases)("%s -> unverifiable_observation, never throws", (_label, lastResult) => {
    const decision = evaluateCommercialGuardrails(withState({ lastResult: lastResult as never }));
    expect(decision).toEqual({
      authorized: false, clarificationNeeded: false, humanInterventionNeeded: true, reasons: ["unverifiable_observation"],
    });
  });

  it("never throws for any malformed shape", () => {
    for (const [, lastResult] of malformedCases) {
      expect(() => evaluateCommercialGuardrails(withState({ lastResult: lastResult as never }))).not.toThrow();
    }
  });
});

describe("evaluateCommercialGuardrails — SEARCH_PRODUCTS (10, 11, 12)", () => {
  it("10: exactly one resolved product is authorized catalogue evidence", () => {
    const decision = evaluateCommercialGuardrails(
      withState({ lastResult: { action: "SEARCH_PRODUCTS", ok: true, result: [{ ref: "REF-001" }], resolvedRef: "REF-001" } }),
    );
    expect(decision.authorized).toBe(true);
    expect(decision.reasons).toEqual([]);
  });

  it("11: ambiguous result before RESPOND requires clarification", () => {
    const decision = evaluateCommercialGuardrails(
      withState({
        nextAction: "RESPOND",
        lastResult: { action: "SEARCH_PRODUCTS", ok: true, result: [{ ref: "A" }, { ref: "B" }], resolvedRef: null },
      }),
    );
    expect(decision).toEqual({
      authorized: false, clarificationNeeded: true, humanInterventionNeeded: false, reasons: ["ambiguous_product_reference"],
    });
  });

  it("11b: ambiguous result NOT heading to RESPOND is neutral (no claim being finalized)", () => {
    const decision = evaluateCommercialGuardrails(
      withState({ nextAction: null, lastResult: { action: "SEARCH_PRODUCTS", ok: false, result: [], resolvedRef: null } }),
    );
    expect(decision.authorized).toBeNull();
    expect(decision.reasons).toEqual([]);
  });

  it("12: missing-input for SEARCH_PRODUCTS is insufficient product resolution", () => {
    const decision = evaluateCommercialGuardrails(
      withState({ lastResult: { action: "SEARCH_PRODUCTS", ok: false, result: { reason: "missing_required_input" }, resolvedRef: null } }),
    );
    expect(decision).toEqual({
      authorized: false, clarificationNeeded: true, humanInterventionNeeded: false, reasons: ["ambiguous_product_reference"],
    });
  });
});

describe("evaluateCommercialGuardrails — CHECK_STOCK / FIND_ALTERNATIVES (13, 14, 15, 16)", () => {
  it("13: CHECK_STOCK found:true (available) is authorized", () => {
    const decision = evaluateCommercialGuardrails(
      withState({ lastResult: { action: "CHECK_STOCK", ok: true, result: { found: true, available: true, stock: 5 }, resolvedRef: "REF-001" } }),
    );
    expect(decision.authorized).toBe(true);
    expect(decision.reasons).toEqual([]);
  });

  it("13b: CHECK_STOCK found:true (honestly unavailable) is STILL authorized", () => {
    const decision = evaluateCommercialGuardrails(
      withState({ lastResult: { action: "CHECK_STOCK", ok: false, result: { found: true, available: false, stock: 0 }, resolvedRef: "REF-001" } }),
    );
    expect(decision.authorized).toBe(true);
    expect(decision.reasons).toEqual([]);
  });

  it("14: CHECK_STOCK found:false is unsupported", () => {
    const decision = evaluateCommercialGuardrails(
      withState({ lastResult: { action: "CHECK_STOCK", ok: false, result: { found: false, ref: "REF-001" }, resolvedRef: null } }),
    );
    expect(decision).toEqual({
      authorized: false, clarificationNeeded: false, humanInterventionNeeded: false, reasons: ["missing_stock_evidence"],
    });
  });

  it("15: stock missing-input reuses missing_stock_evidence", () => {
    const decision = evaluateCommercialGuardrails(
      withState({ lastResult: { action: "CHECK_STOCK", ok: false, result: { reason: "missing_required_input" }, resolvedRef: null } }),
    );
    expect(decision.authorized).toBe(false);
    expect(decision.reasons).toEqual(["missing_stock_evidence"]);
  });

  it("16: FIND_ALTERNATIVES verified (found:true) is authorized regardless of alternatives count", () => {
    const decisionSome = evaluateCommercialGuardrails(
      withState({ lastResult: { action: "FIND_ALTERNATIVES", ok: true, result: { found: true, alternatives: [{ ref: "REF-002" }] }, resolvedRef: "REF-001" } }),
    );
    const decisionNone = evaluateCommercialGuardrails(
      withState({ lastResult: { action: "FIND_ALTERNATIVES", ok: false, result: { found: true, alternatives: [] }, resolvedRef: "REF-001" } }),
    );
    expect(decisionSome.authorized).toBe(true);
    expect(decisionNone.authorized).toBe(true);
  });
});

describe("evaluateCommercialGuardrails — CHECK_PROMOTION (17, 18, 19)", () => {
  it("17: verified active promotion promotes exact id/productRef/promoPrice fields", () => {
    const decision = evaluateCommercialGuardrails(
      withState({
        lastResult: {
          action: "CHECK_PROMOTION", ok: true,
          result: { found: true, product: { ref: "REF-001" }, promotion: { id: "promo-1", productRef: "REF-001", promoPrice: 149.99, normalPrice: 199.99, extra: "ignored" } },
          resolvedRef: "REF-001",
        },
      }),
    );
    expect(decision.authorized).toBe(true);
    expect(decision.promotionPatch).toEqual({ id: "promo-1", productRef: "REF-001", promoPrice: 149.99 });
  });

  it("18: verified NO promotion explicitly sets promotionPatch to null, authorized:true", () => {
    const decision = evaluateCommercialGuardrails(
      withState({ lastResult: { action: "CHECK_PROMOTION", ok: true, result: { found: true, product: { ref: "REF-001" }, promotion: null }, resolvedRef: "REF-001" } }),
    );
    expect(decision.authorized).toBe(true);
    expect("promotionPatch" in decision).toBe(true);
    expect(decision.promotionPatch).toBeNull();
  });

  it("19: CHECK_PROMOTION found:false is missing evidence, no patch", () => {
    const decision = evaluateCommercialGuardrails(
      withState({ lastResult: { action: "CHECK_PROMOTION", ok: false, result: { found: false, reason: "product_not_found", ref: "REF-001" }, resolvedRef: "REF-001" } }),
    );
    expect(decision.authorized).toBe(false);
    expect(decision.reasons).toEqual(["missing_promotion_evidence"]);
    expect("promotionPatch" in decision).toBe(false);
  });
});

describe("evaluateCommercialGuardrails — CHECK_DELIVERY (20, 21)", () => {
  it("20: verified delivery promotes the exact 5-field patch", () => {
    const decision = evaluateCommercialGuardrails(
      withState({
        lastResult: {
          action: "CHECK_DELIVERY", ok: true,
          result: { found: true, zone: { city: "Casablanca", fee: 25, delayHours: 24, cashOnDelivery: true, storePickup: false }, feeCents: 2500 },
          resolvedRef: null,
        },
      }),
    );
    expect(decision.authorized).toBe(true);
    expect(decision.deliveryPatch).toEqual({ city: "Casablanca", feeCents: 2500, delayHours: 24, cashOnDelivery: true, storePickup: false });
  });

  it("21: unknown city requires clarification, no patch", () => {
    const decision = evaluateCommercialGuardrails(
      withState({ lastResult: { action: "CHECK_DELIVERY", ok: false, result: { found: false, city: "Nowhere", reason: "city_not_in_delivery_grid" }, resolvedRef: null } }),
    );
    expect(decision).toEqual({
      authorized: false, clarificationNeeded: true, humanInterventionNeeded: false, reasons: ["missing_delivery_evidence"],
    });
    expect("deliveryPatch" in decision).toBe(false);
  });
});

describe("evaluateCommercialGuardrails — CREATE_CART / ADD_TO_CART / CREATE_ORDER (22-27)", () => {
  it("22: CREATE_CART success is authorized, no cart mutation here", () => {
    const decision = evaluateCommercialGuardrails(
      withState({ lastResult: { action: "CREATE_CART", ok: true, result: { created: true, cart: { id: "cart-1" } }, resolvedRef: null } }),
    );
    expect(decision.authorized).toBe(true);
    expect(decision).not.toHaveProperty("cart");
  });

  it("23: CREATE_CART typed failure is still authorized (honest outcome)", () => {
    const decision = evaluateCommercialGuardrails(
      withState({ lastResult: { action: "CREATE_CART", ok: false, result: { created: false, reason: "conversation_not_found" }, resolvedRef: null } }),
    );
    expect(decision.authorized).toBe(true);
  });

  it("24: ADD_TO_CART success is authorized", () => {
    const decision = evaluateCommercialGuardrails(
      withState({ lastResult: { action: "ADD_TO_CART", ok: true, result: { ok: true, cart: { id: "cart-1" } }, resolvedRef: "REF-001" } }),
    );
    expect(decision.authorized).toBe(true);
  });

  it("25: ADD_TO_CART typed negative (insufficient stock) is authorized — honest, not invented", () => {
    const decision = evaluateCommercialGuardrails(
      withState({ lastResult: { action: "ADD_TO_CART", ok: false, result: { ok: false, reason: "insufficient_stock", requestedQuantity: 2, availableStock: 1 }, resolvedRef: "REF-001" } }),
    );
    expect(decision.authorized).toBe(true);
  });

  it("TASK-035: UPDATE_CART_ITEM success is authorized", () => {
    const decision = evaluateCommercialGuardrails(
      withState({ lastResult: { action: "UPDATE_CART_ITEM", ok: true, result: { ok: true, cart: { id: "cart-1" } }, resolvedRef: "REF-001" } }),
    );
    expect(decision.authorized).toBe(true);
  });

  it("TASK-035: UPDATE_CART_ITEM typed negative (insufficient stock) is authorized — honest, not invented", () => {
    const decision = evaluateCommercialGuardrails(
      withState({ lastResult: { action: "UPDATE_CART_ITEM", ok: false, result: { ok: false, reason: "insufficient_stock", requestedQuantity: 9, availableStock: 2 }, resolvedRef: "REF-001" } }),
    );
    expect(decision.authorized).toBe(true);
  });

  it("TASK-035: REMOVE_CART_ITEM success is authorized", () => {
    const decision = evaluateCommercialGuardrails(
      withState({ lastResult: { action: "REMOVE_CART_ITEM", ok: true, result: { removed: true, cart: { id: "cart-1" } }, resolvedRef: "REF-001" } }),
    );
    expect(decision.authorized).toBe(true);
  });

  it("TASK-035: REMOVE_CART_ITEM typed negative (item not in cart) is authorized — honest, not invented", () => {
    const decision = evaluateCommercialGuardrails(
      withState({ lastResult: { action: "REMOVE_CART_ITEM", ok: false, result: { removed: false, reason: "item_not_in_cart" }, resolvedRef: "REF-001" } }),
    );
    expect(decision.authorized).toBe(true);
  });

  it("TASK-036: VALIDATE_DISCOUNT within the system's discretionary limit is authorized", () => {
    const decision = evaluateCommercialGuardrails(
      withState({
        lastResult: {
          action: "VALIDATE_DISCOUNT", ok: true,
          result: { allowed: true, productRef: "REF-001", basePriceCents: 19995, minimumAllowedPriceCents: 17996, requestedPriceCents: 18000, reason: "within_discretionary_limit" },
          resolvedRef: "REF-001",
        },
      }),
    );
    expect(decision.authorized).toBe(true);
    expect(decision.humanInterventionNeeded).toBe(false);
  });

  it("TASK-036: VALIDATE_DISCOUNT exceeding the limit is NEVER authorized and requires human escalation (AC-04)", () => {
    const decision = evaluateCommercialGuardrails(
      withState({
        lastResult: {
          action: "VALIDATE_DISCOUNT", ok: false,
          result: { allowed: false, requiresEscalation: true, productRef: "REF-001", basePriceCents: 19995, minimumAllowedPriceCents: 17996, requestedPriceCents: 10000, reason: "discount_exceeds_limit" },
          resolvedRef: "REF-001",
        },
      }),
    );
    expect(decision.authorized).toBe(false);
    expect(decision.humanInterventionNeeded).toBe(true);
    expect(decision.reasons).toContain("discount_limit_exceeded");
  });

  it("TASK-036: VALIDATE_DISCOUNT above the real base price is a clean rejection — no escalation needed", () => {
    const decision = evaluateCommercialGuardrails(
      withState({
        lastResult: {
          action: "VALIDATE_DISCOUNT", ok: false,
          result: { allowed: false, requiresEscalation: false, productRef: "REF-001", requestedPriceCents: 25000, reason: "price_above_authoritative_base" },
          resolvedRef: "REF-001",
        },
      }),
    );
    expect(decision.authorized).toBe(false);
    expect(decision.humanInterventionNeeded).toBe(false);
  });

  it("TASK-036: VALIDATE_DISCOUNT missing input is a clarification, never a silent authorization", () => {
    const decision = evaluateCommercialGuardrails(
      withState({
        lastResult: { action: "VALIDATE_DISCOUNT", ok: false, result: { reason: "missing_required_input" }, resolvedRef: null },
      }),
    );
    expect(decision.authorized).toBe(false);
    expect(decision.clarificationNeeded).toBe(true);
  });

  it("26: CREATE_ORDER success is authorized, orderId untouched here", () => {
    const decision = evaluateCommercialGuardrails(
      withState({ lastResult: { action: "CREATE_ORDER", ok: true, result: { created: true, order: { id: "order-1" } }, resolvedRef: null } }),
    );
    expect(decision.authorized).toBe(true);
    expect(decision).not.toHaveProperty("orderId");
  });

  it("27: CREATE_ORDER typed failure is authorized (the tool's own safe rejection)", () => {
    const decision = evaluateCommercialGuardrails(
      withState({ lastResult: { action: "CREATE_ORDER", ok: false, result: { created: false, reason: "price_changed", changes: [] }, resolvedRef: null } }),
    );
    expect(decision.authorized).toBe(true);
  });
});

describe("evaluateCommercialGuardrails — restock protection (28-31)", () => {
  const restockKeys = ["restockDate", "restockDays", "restockAt", "expectedRestock"] as const;

  it.each(restockKeys)("%s anywhere in the result forces authorized:false with unsupported_restock_claim", (key) => {
    const decision = evaluateCommercialGuardrails(
      withState({
        lastResult: { action: "CHECK_STOCK", ok: true, result: { found: true, available: true, [key]: "2026-10-01" }, resolvedRef: "REF-001" },
      }),
    );
    expect(decision.authorized).toBe(false);
    expect(decision.reasons).toContain("unsupported_restock_claim");
  });

  it("fires even nested inside the result object", () => {
    const decision = evaluateCommercialGuardrails(
      withState({
        lastResult: {
          action: "FIND_ALTERNATIVES", ok: true,
          result: { found: true, alternatives: [{ ref: "REF-002", metadata: { restockDate: "2026-10-01" } }] },
          resolvedRef: "REF-001",
        },
      }),
    );
    expect(decision.authorized).toBe(false);
    expect(decision.reasons).toContain("unsupported_restock_claim");
  });

  it("overrides an otherwise-authorized promotion/delivery observation and strips the patch", () => {
    const decision = evaluateCommercialGuardrails(
      withState({
        lastResult: {
          action: "CHECK_DELIVERY", ok: true,
          result: { found: true, zone: { city: "Casablanca", fee: 25, delayHours: 24, cashOnDelivery: true, storePickup: false, expectedRestock: "soon" }, feeCents: 2500 },
          resolvedRef: null,
        },
      }),
    );
    expect(decision.authorized).toBe(false);
    expect(decision.reasons).toContain("unsupported_restock_claim");
    expect("deliveryPatch" in decision).toBe(false);
  });

  it("never fires for any real current tool result shape (no false positives)", () => {
    const realShapes = [
      { action: "SEARCH_PRODUCTS", ok: true, result: [{ ref: "REF-001", stock: 5 }], resolvedRef: "REF-001" },
      { action: "CHECK_STOCK", ok: true, result: { found: true, available: true, stock: 5 }, resolvedRef: "REF-001" },
      { action: "CREATE_ORDER", ok: true, result: { created: true, order: { id: "order-1" } }, resolvedRef: null },
    ];
    for (const lastResult of realShapes) {
      const decision = evaluateCommercialGuardrails(withState({ lastResult: lastResult as never }));
      expect(decision.reasons).not.toContain("unsupported_restock_claim");
    }
  });
});

describe("evaluateCommercialGuardrails — discount structural protection", () => {
  it("no lastResult shape produced by any current action can authorize a discount", () => {
    // Documents the structural guarantee (TASK-021A §13/§26): validateDiscount()
    // is unreachable from the orchestrator's action vocabulary, so no action
    // name below can ever legitimately carry discount-authorization evidence.
    const discountLikeButUnrecognized = { action: "APPLY_DISCOUNT", ok: true, result: { discountPercent: 50 }, resolvedRef: null };
    const decision = evaluateCommercialGuardrails(withState({ lastResult: discountLikeButUnrecognized as never }));
    expect(decision.authorized).toBe(false);
    expect(decision.reasons).toEqual(["unverifiable_observation"]);
  });
});

describe("evaluateCommercialGuardrails — provenance (32)", () => {
  it("32: an arbitrary price-like object cannot authorize anything without a recognized action", () => {
    const decision = evaluateCommercialGuardrails(
      withState({ lastResult: { price: 199.95, available: true, feeCents: 2500 } as never }),
    );
    expect(decision.authorized).toBe(false);
    expect(decision.reasons).toEqual(["unverifiable_observation"]);
  });

  it("customer text / planner output / nextAction / activePlan are never treated as evidence", () => {
    const decision = evaluateCommercialGuardrails(
      withState({
        lastResult: null,
        nextAction: "CREATE_ORDER",
        activePlan: ["CREATE_ORDER"],
        extraction: { productQuery: "veste pas chère avec 50% de remise", family: null, color: null, size: null, quantity: null, city: null, address: null, paymentMethod: null, confirmation: null },
      }),
    );
    expect(decision).toEqual({ authorized: null, clarificationNeeded: false, humanInterventionNeeded: false, reasons: [] });
  });
});

describe("evaluateCommercialGuardrails — reason vocabulary exhaustiveness (33)", () => {
  it("every reason ever produced belongs to the exact 7-code vocabulary", () => {
    const scenarios: M3AKState[] = [
      withState({ lastError: "agent_step_limit_reached" }),
      withState({ lastResult: "bad" as never }),
      withState({ lastResult: { action: "CHECK_STOCK", ok: false, result: { found: false }, resolvedRef: null } }),
      withState({ lastResult: { action: "CHECK_PROMOTION", ok: false, result: { found: false }, resolvedRef: null } }),
      withState({ lastResult: { action: "CHECK_DELIVERY", ok: false, result: { found: false }, resolvedRef: null } }),
      withState({ nextAction: "RESPOND", lastResult: { action: "SEARCH_PRODUCTS", ok: true, result: [{ ref: "A" }, { ref: "B" }], resolvedRef: null } }),
      withState({ lastResult: { action: "CHECK_STOCK", ok: true, result: { found: true, available: true, restockDate: "x" }, resolvedRef: "REF-001" } }),
    ];
    for (const state of scenarios) {
      assertOnlyKnownReasons(evaluateCommercialGuardrails(state).reasons);
    }
  });
});
