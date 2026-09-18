import { describe, expect, it, vi } from "vitest";
import { buildSalesGraph, compileSalesGraph, invokeSalesGraph } from "./graph";
import type { M3AKState } from "./state";

const initialState: M3AKState = {
  threadId: "thread-fixture-018",
  conversationId: null,
  customerId: null,
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
const populatedState: M3AKState = {
  ...initialState,
  conversationId: "conversation-018",
  customerId: "customer-018",
  messages: [
    { role: "customer", content: "Bghit veste k7la" },
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
  cart: { id: "cart-018", version: 3, items: [item] },
  promotion: { id: "promotion-018", productRef: "REF-001", promoPrice: 199.95 },
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
  orderId: "order-018",
  escalationId: "escalation-018",
  followupId: "followup-018",
};

const EXPECTED_NODE_NAMES = [
  "__start__", "loadContext", "conversation", "router", "tool", "guardrail", "response", "persist", "__end__",
];

const EXPECTED_EDGES = [
  ["__start__", "loadContext"],
  ["loadContext", "conversation"],
  ["conversation", "router"],
  ["router", "tool"],
  ["tool", "guardrail"],
  ["guardrail", "response"],
  ["response", "persist"],
  ["persist", "__end__"],
];

describe("buildSalesGraph / compileSalesGraph", () => {
  it("builds an uncompiled StateGraph exposing the builder API", () => {
    const builder = buildSalesGraph();
    expect(typeof builder.addNode).toBe("function");
    expect(typeof builder.addEdge).toBe("function");
    expect(typeof builder.compile).toBe("function");
  });

  it("compiles without a checkpointer", () => {
    const compiled = compileSalesGraph();
    expect(typeof compiled.invoke).toBe("function");
  });
});

describe("graph topology", () => {
  it("exposes exactly the expected node names via getGraphAsync()", async () => {
    const compiled = compileSalesGraph();
    const drawable = await compiled.getGraphAsync();
    const nodeNames = new Set(Object.keys(drawable.nodes));
    expect(nodeNames).toEqual(new Set(EXPECTED_NODE_NAMES));
  });

  it("wires exactly the required linear edge sequence via getGraphAsync()", async () => {
    const compiled = compileSalesGraph();
    const drawable = await compiled.getGraphAsync();
    const edges = new Set(drawable.edges.map((edge) => `${edge.source}->${edge.target}`));
    expect(edges).toEqual(new Set(EXPECTED_EDGES.map(([from, to]) => `${from}->${to}`)));
  });
});

describe("invokeSalesGraph — safe full traversal", () => {
  it("returns the validated initial state unchanged", async () => {
    const result = await invokeSalesGraph(initialState);
    expect(result).toEqual(initialState);
  });

  it("returns a fully populated state unchanged, with no reducer/overwrite drift", async () => {
    const result = await invokeSalesGraph(populatedState);
    expect(result).toEqual(populatedState);
  });
});

describe("invokeSalesGraph — outer JSON-safety boundary preserved", () => {
  it("rejects a root-level getter on a required field without invoking it", async () => {
    const accessor = vi.fn(() => "thread-from-getter");
    const stateWithGetter: Record<string, unknown> = { ...initialState };
    delete stateWithGetter.threadId;
    Object.defineProperty(stateWithGetter, "threadId", {
      enumerable: true,
      get: accessor,
    });

    await expect(invokeSalesGraph(stateWithGetter)).rejects.toThrow();
    expect(accessor).not.toHaveBeenCalled();
  });

  it("rejects a cyclic lastResult before it ever reaches the graph", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const stateWithCyclicResult = { ...initialState, lastResult: cyclic };
    await expect(invokeSalesGraph(stateWithCyclicResult)).rejects.toThrow();
  });
});
