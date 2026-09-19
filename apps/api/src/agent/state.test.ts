import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { M3AKStateSchema, type M3AKState } from "./state";

const initialState: M3AKState = {
  threadId: "thread-fixture-017",
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

const item = { productRef: "REF-001", quantity: 2, unitPrice: 199.95 };
const populatedState = {
  ...initialState,
  conversationId: "conversation-017",
  customerId: "customer-017",
  messages: [
    { role: "customer", content: "  Bghit veste k7la  " },
    { role: "assistant", content: "Quelle taille ?" },
    { role: "merchant", content: "Je reprends la conversation." },
  ],
  summary: "Le client souhaite deux vestes.",
  language: "mixed",
  intent: "product_search",
  extraction: {
    productQuery: "veste", family: "vestes", color: "noir", size: "M", quantity: 2,
    city: "Casablanca", address: "12 rue Exemple", paymentMethod: "cash_on_delivery", confirmation: true,
  },
  cart: { id: "cart-017", version: 3, items: [item] },
  promotion: { id: "promotion-017", productRef: "REF-001", promoPrice: 199.95 },
  delivery: { city: "Casablanca", feeCents: 2500, delayHours: 24, cashOnDelivery: true, storePickup: false },
  cartTotalCents: 39990,
  nextAction: "RESPOND",
  activePlan: ["RESPOND"],
  executedSteps: ["SEARCH_PRODUCTS", "CHECK_STOCK", "CHECK_STOCK"],
  iterationCount: 4,
  lastResult: { found: true, products: [{ ref: "REF-001", stock: 5 }], note: null },
  lastError: "Previous lookup failed",
  authorized: false,
  clarificationNeeded: true,
  humanInterventionNeeded: true,
  guardrailReasons: ["Merchant review requested"],
  orderId: "order-017",
  escalationId: "escalation-017",
  followupId: "followup-017",
} satisfies M3AKState;

function accepts(patch: Record<string, unknown>): boolean {
  return M3AKStateSchema.safeParse({ ...initialState, ...patch }).success;
}

describe("M3AKStateSchema — complete state", () => {
  it.each([initialState, populatedState])("accepts and round-trips a complete fixture (%#)", (fixture) => {
    const parsed: M3AKState = M3AKStateSchema.parse(fixture);
    expect(parsed).toEqual(fixture);
    expect(M3AKStateSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it.each(Object.keys(initialState))("requires %s, even when nullable", (key) => {
    const missing: Record<string, unknown> = { ...initialState };
    delete missing[key];
    expect(M3AKStateSchema.safeParse(missing).success).toBe(false);
    expect(accepts({ [key]: undefined })).toBe(false);
  });

  it("keeps the inferred state required and lastResult precisely JSON-typed", () => {
    type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
    expectTypeOf<M3AKState>().toEqualTypeOf<Required<M3AKState>>();
    expectTypeOf<M3AKState["lastResult"]>().toEqualTypeOf<JsonValue>();
    expectTypeOf<M3AKState["authorized"]>().toEqualTypeOf<boolean | null>();
    expectTypeOf<M3AKState["activePlan"]>().toEqualTypeOf<string[]>();
    expectTypeOf<M3AKState["messages"][number]["role"]>().toEqualTypeOf<"customer" | "assistant" | "merchant">();
  });

  it("trims the specified text fields while preserving message content and MAD snapshots", () => {
    const parsed = M3AKStateSchema.parse({
      ...populatedState, summary: " summary ", intent: " intent ", nextAction: " NEXT ",
      activePlan: [" NEXT "], executedSteps: [" DONE "], lastError: " error ", guardrailReasons: [" reason "],
    });
    expect([parsed.summary, parsed.intent, parsed.nextAction, parsed.lastError]).toEqual(["summary", "intent", "NEXT", "error"]);
    expect([parsed.activePlan, parsed.executedSteps, parsed.guardrailReasons]).toEqual([["NEXT"], ["DONE"], ["reason"]]);
    expect(parsed.messages[0]?.content).toBe("  Bghit veste k7la  ");
    expect(parsed.cart?.items[0]?.unitPrice).toBe(199.95);
    expect(parsed.promotion?.promoPrice).toBe(199.95);
  });
});

describe("strict projections", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["root", { extra: true }],
    ["identity wrapper", { identity: { threadId: "thread-017" } }],
    ["message id", { messages: [{ role: "customer", content: "hello", id: "message-017" }] }],
    ["message timestamp", { messages: [{ role: "customer", content: "hello", createdAt: "2026-09-18T10:00:00Z" }] }],
    ...["extra", "language", "intent"].map((key): [string, Record<string, unknown>] =>
      [`extraction.${key}`, { extraction: { ...initialState.extraction, [key]: "unexpected" } }]),
    ...["conversationId", "status", "extra"].map((key): [string, Record<string, unknown>] =>
      [`cart.${key}`, { cart: { ...populatedState.cart, [key]: "unexpected" } }]),
    ["cart item metadata", { cart: { ...populatedState.cart, items: [{ ...item, id: "item-017" }] } }],
    ...["normalPrice", "startsAt", "endsAt", "condition", "extra"].map((key): [string, Record<string, unknown>] =>
      [`promotion.${key}`, { promotion: { ...populatedState.promotion, [key]: "unexpected" } }]),
    ["delivery fee", { delivery: { ...populatedState.delivery, fee: 25 } }],
    ["delivery metadata", { delivery: { ...populatedState.delivery, id: "zone-017" } }],
    ["decimal total", { total: 399.9 }],
    ["decimal cartTotal", { cartTotal: 399.9 }],
  ];
  it.each(cases)("rejects %s", (_name, patch) => expect(accepts(patch)).toBe(false));

  it("requires every nested projection key", () => {
    const projections = [
      [populatedState.messages[0], (value: unknown) => ({ messages: [value] })],
      [populatedState.extraction, (value: unknown) => ({ extraction: value })],
      [populatedState.cart, (value: unknown) => ({ cart: value })],
      [item, (value: unknown) => ({ cart: { ...populatedState.cart, items: [value] } })],
      [populatedState.promotion, (value: unknown) => ({ promotion: value })],
      [populatedState.delivery, (value: unknown) => ({ delivery: value })],
    ] as const;
    for (const [projection, wrap] of projections) {
      for (const key of Object.keys(projection ?? {})) {
        const missing: Record<string, unknown> = { ...projection };
        delete missing[key];
        expect(accepts(wrap(missing))).toBe(false);
        expect(accepts(wrap({ ...projection, [key]: undefined }))).toBe(false);
      }
    }
  });
});

describe("field constraints", () => {
  const invalid: Array<[string, Record<string, unknown>]> = [
    ["empty thread", { threadId: "" }], ["null thread", { threadId: null }],
    ["numeric customer", { customerId: 17 }], ["empty order ID", { orderId: "" }],
    ["language", { language: "english" }], ["null extraction", { extraction: null }],
    ["payment", { extraction: { ...initialState.extraction, paymentMethod: "crypto" } }],
    ["confirmation", { extraction: { ...initialState.extraction, confirmation: "true" } }],
    ["role", { messages: [{ role: "system", content: "hello" }] }],
    ["empty content", { messages: [{ role: "customer", content: "" }] }],
    ["clarification type", { clarificationNeeded: "false" }],
    ["intervention type", { humanInterventionNeeded: null }],
    ["authorization type", { authorized: 1 }],
    ["raw error", { lastError: new Error("failed") }],
    ["cart version", { cart: { ...populatedState.cart, version: -1 } }],
    ["unit price", { cart: { ...populatedState.cart, items: [{ ...item, unitPrice: -1 }] } }],
    ["promotion price", { promotion: { ...populatedState.promotion, promoPrice: -1 } }],
    ["delivery delay", { delivery: { ...populatedState.delivery, delayHours: 0 } }],
    ["delivery flag", { delivery: { ...populatedState.delivery, cashOnDelivery: "true" } }],
  ];
  it.each(invalid)("rejects invalid %s", (_name, patch) => expect(accepts(patch)).toBe(false));

  it.each(["summary", "intent", "nextAction", "lastError"])("rejects blank %s", (key) => {
    expect(accepts({ [key]: " \t " })).toBe(false);
  });
  it.each(["activePlan", "executedSteps", "guardrailReasons"])("rejects blank entries in %s", (key) => {
    expect(accepts({ [key]: [" "] })).toBe(false);
  });
  it.each(["productQuery", "family", "color", "size", "city", "address"])("rejects blank extraction.%s", (key) => {
    expect(accepts({ extraction: { ...initialState.extraction, [key]: " " } })).toBe(false);
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, "2"])("rejects quantity %s", (quantity) => {
    expect(accepts({ extraction: { ...initialState.extraction, quantity } })).toBe(false);
    expect(accepts({ cart: { ...populatedState.cart, items: [{ ...item, quantity }] } })).toBe(false);
  });
  it.each([NaN, Infinity, -Infinity])("rejects nonfinite snapshot values %s", (value) => {
    expect(accepts({ cart: { ...populatedState.cart, items: [{ ...item, unitPrice: value }] } })).toBe(false);
    expect(accepts({ promotion: { ...populatedState.promotion, promoPrice: value } })).toBe(false);
    expect(accepts({ delivery: { ...populatedState.delivery, delayHours: value } })).toBe(false);
  });
});

describe("planning, guardrails and cents", () => {
  it("accepts empty planning and repeated completed actions independently of iterations", () => {
    expect(accepts({ nextAction: null, activePlan: [], executedSteps: [], iterationCount: 0 })).toBe(true);
    expect(accepts({ activePlan: ["NEXT"], executedSteps: ["DONE", "DONE"], iterationCount: 5 })).toBe(true);
  });
  it.each(["activePlan", "executedSteps"])("rejects planner objects in %s", (key) => {
    expect(accepts({ [key]: [{ action: "NEXT", reason: "example" }] })).toBe(false);
  });
  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, "1"])("rejects iteration count %s", (iterationCount) => {
    expect(accepts({ iterationCount })).toBe(false);
  });
  it.each([null, false, true])("preserves authorization verdict %s", (authorized) => {
    const parsed = M3AKStateSchema.parse({ ...initialState, authorized });
    expect(parsed.authorized).toBe(authorized);
    expect(parsed.clarificationNeeded).toBe(false);
    expect(parsed.humanInterventionNeeded).toBe(false);
    expect(parsed.guardrailReasons).toEqual([]);
  });
  it.each([0, 1, 10001, Number.MAX_SAFE_INTEGER])("accepts safe centime amount %s", (value) => {
    expect(accepts({ cartTotalCents: value })).toBe(true);
    expect(accepts({ delivery: { ...populatedState.delivery, feeCents: value } })).toBe(true);
  });
  it.each([-1, 0.1, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, -Infinity, "100"])("rejects invalid cents %s", (value) => {
    expect(accepts({ cartTotalCents: value })).toBe(false);
    expect(accepts({ delivery: { ...populatedState.delivery, feeCents: value } })).toBe(false);
  });
});

describe("JSON observations and serialization safety", () => {
  it.each([
    ["object", { arbitrary: "value", constructor: "ordinary data" }],
    ["array", [1, "two", false, null]], ["string", ""], ["number", 1.25],
    ["boolean", false], ["null", null], ["nested", { list: [{ value: true }] }],
  ])("accepts %s", (_name, lastResult) => expect(accepts({ lastResult })).toBe(true));

  class RuntimeValue { value = 1; }
  const unsupported: Array<[string, unknown]> = [
    ["Date", new Date("2026-09-18T00:00:00Z")], ["Map", new Map()], ["Set", new Set()],
    ["function", () => 1], ["class", new RuntimeValue()], ["Error", new Error("failed")],
    ["bigint", 1n], ["symbol", Symbol("value")], ["undefined", undefined],
    ["NaN", NaN], ["Infinity", Infinity], ["-Infinity", -Infinity],
  ];
  it.each(unsupported)("rejects %s directly and nested", (_name, value) => {
    for (const lastResult of [value, { value }, [value]]) expect(accepts({ lastResult })).toBe(false);
  });

  it("rejects object, array and indirect cycles without throwing", () => {
    const object: Record<string, unknown> = {};
    object.self = object;
    const array: unknown[] = [];
    array.push(array);
    const indirect: Record<string, unknown> = {};
    indirect.child = [{ parent: indirect }];
    for (const lastResult of [object, array, indirect]) {
      expect(() => M3AKStateSchema.safeParse({ ...initialState, lastResult })).not.toThrow();
      expect(accepts({ lastResult })).toBe(false);
    }
  });

  it("accepts repeated noncyclic references and null-prototype JSON objects", () => {
    const shared = { value: 1 };
    const plain: Record<string, unknown> = Object.create(null);
    plain.value = shared;
    const lastResult = { left: shared, right: shared, list: [shared], plain };
    const parsed = M3AKStateSchema.parse({ ...initialState, lastResult });
    expect(parsed.lastResult).toEqual(lastResult);
    expect(M3AKStateSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it("preserves ordinary JSON string keys without silently dropping data", () => {
    const lastResult: unknown = JSON.parse('{"nested":{"__proto__":{"value":1},"constructor":"data"}}');
    const parsed = M3AKStateSchema.parse({ ...initialState, lastResult });
    expect(parsed.lastResult).toEqual(lastResult);
    expect(M3AKStateSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    expect(accepts(JSON.parse('{"__proto__":"unexpected root key"}'))).toBe(false);
  });

  it("rejects getters and setters without invoking them, including outside lastResult", () => {
    const accessor = vi.fn(() => { throw new Error("must not run"); });
    const object = Object.defineProperty({}, "value", { enumerable: true, get: accessor });
    const array = Object.defineProperty([1], "0", { enumerable: true, get: accessor });
    const setter = Object.defineProperty({}, "value", { enumerable: true, set: accessor });
    const state = Object.defineProperty({ ...initialState }, "summary", { enumerable: true, get: accessor });
    for (const lastResult of [object, array, setter, { nested: object }]) expect(accepts({ lastResult })).toBe(false);
    expect(M3AKStateSchema.safeParse(state).success).toBe(false);
    expect(accessor).not.toHaveBeenCalled();
  });

  it("rejects symbol keys, hidden data, sparse arrays and extra array properties", () => {
    const hidden = Object.defineProperty({}, "value", { value: 1 });
    const extra = Object.assign([1], { extra: true });
    for (const lastResult of [{ [Symbol("key")]: 1 }, hidden, new Array(1), extra]) {
      expect(accepts({ lastResult })).toBe(false);
    }
  });

  it("never calls custom toJSON methods", () => {
    const toJSON = vi.fn(() => ({ value: 1 }));
    expect(accepts({ lastResult: { toJSON } })).toBe(false);
    expect(accepts({ lastResult: Object.defineProperty({}, "toJSON", { value: toJSON }) })).toBe(false);
    expect(toJSON).not.toHaveBeenCalled();
  });

  it("rejects runtime snapshot instances instead of repairing their serialization", () => {
    class CartSnapshot {
      id = "cart-017";
      version = 0;
      items = [];
    }
    expect(accepts({ cart: new CartSnapshot() })).toBe(false);
  });
});
