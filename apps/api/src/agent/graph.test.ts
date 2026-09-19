import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./orchestrator", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./orchestrator")>();
  return {
    ...actual,
    planNextActions: vi.fn(),
  };
});

import { LlmError } from "../llm/reasoningClient";
import { buildSalesGraph, compileSalesGraph, invokeSalesGraph } from "./graph";
import { OrchestratorError, planNextActions } from "./orchestrator";
import type { M3AKState } from "./state";

const mockedPlanNextActions = vi.mocked(planNextActions);

afterEach(() => {
  vi.resetAllMocks();
});

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

describe("graph topology — unchanged from TASK-018", () => {
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

describe("router — successful plan", () => {
  it("stores the plan, sets nextAction to the first step, clears lastError, and leaves every other field unchanged", async () => {
    mockedPlanNextActions.mockResolvedValueOnce({ plan: ["SEARCH_PRODUCTS", "CHECK_STOCK", "RESPOND"] });

    const result = await invokeSalesGraph(initialState);

    expect(result.activePlan).toEqual(["SEARCH_PRODUCTS", "CHECK_STOCK", "RESPOND"]);
    expect(result.nextAction).toBe("SEARCH_PRODUCTS");
    expect(result.lastError).toBeNull();

    const { activePlan, nextAction, lastError, ...rest } = result;
    const { activePlan: _ap, nextAction: _na, lastError: _le, ...restInitial } = initialState;
    expect(rest).toEqual(restInitial);
    expect(mockedPlanNextActions).toHaveBeenCalledTimes(1);
  });
});

describe("router — empty plan", () => {
  it("sets activePlan to [] and nextAction to null, and the state round-trips unchanged", async () => {
    mockedPlanNextActions.mockResolvedValueOnce({ plan: [] });

    const result = await invokeSalesGraph(initialState);

    expect(result.activePlan).toEqual([]);
    expect(result.nextAction).toBeNull();
    expect(result.lastError).toBeNull();
    expect(result).toEqual(initialState);
  });
});

describe("router — orchestrator validation error", () => {
  it("resolves the graph with a safe lastError instead of crashing", async () => {
    mockedPlanNextActions.mockRejectedValueOnce(
      new OrchestratorError("schema_mismatch", "Planner response did not match the orchestrator plan schema"),
    );

    const result = await invokeSalesGraph(initialState);

    expect(result.activePlan).toEqual([]);
    expect(result.nextAction).toBeNull();
    expect(result.lastError).toBe("orchestrator_planning_failed: schema_mismatch");
  });

  it("never contains raw model output or secrets in lastError", async () => {
    mockedPlanNextActions.mockRejectedValueOnce(new OrchestratorError("invalid_json", "Planner response was not valid JSON"));

    const result = await invokeSalesGraph(initialState);

    expect(result.lastError).toBe("orchestrator_planning_failed: invalid_json");
  });
});

describe("router — recognized LLM transport error", () => {
  it("resolves the graph with a safe category-based lastError instead of crashing", async () => {
    mockedPlanNextActions.mockRejectedValueOnce(new LlmError("timeout_error", "LLM request timed out after 60000ms"));

    const result = await invokeSalesGraph(initialState);

    expect(result.activePlan).toEqual([]);
    expect(result.nextAction).toBeNull();
    expect(result.lastError).toBe("orchestrator_planning_failed: timeout_error");
  });
});

describe("router — unexpected errors are not swallowed", () => {
  it("propagates a programmer bug instead of returning a fake success", async () => {
    mockedPlanNextActions.mockRejectedValueOnce(new TypeError("unexpected programming error"));

    await expect(invokeSalesGraph(initialState)).rejects.toThrow();
  });
});

describe("router — unrelated state fields survive success and failure alike", () => {
  it("leaves executedSteps, iterationCount, lastResult and guardrail fields untouched on success", async () => {
    mockedPlanNextActions.mockResolvedValueOnce({ plan: ["CHECK_DELIVERY"] });

    const result = await invokeSalesGraph(populatedState);

    expect(result.executedSteps).toEqual(populatedState.executedSteps);
    expect(result.iterationCount).toBe(populatedState.iterationCount);
    expect(result.lastResult).toEqual(populatedState.lastResult);
    expect(result.authorized).toBe(populatedState.authorized);
    expect(result.clarificationNeeded).toBe(populatedState.clarificationNeeded);
    expect(result.humanInterventionNeeded).toBe(populatedState.humanInterventionNeeded);
    expect(result.guardrailReasons).toEqual(populatedState.guardrailReasons);
    expect(result.cart).toEqual(populatedState.cart);
    expect(result.orderId).toBe(populatedState.orderId);
    expect(result.escalationId).toBe(populatedState.escalationId);
    expect(result.followupId).toBe(populatedState.followupId);
  });

  it("leaves executedSteps, iterationCount, lastResult and guardrail fields untouched on planning failure", async () => {
    mockedPlanNextActions.mockRejectedValueOnce(new OrchestratorError("invalid_plan", "A terminal action must be last"));

    const result = await invokeSalesGraph(populatedState);

    expect(result.executedSteps).toEqual(populatedState.executedSteps);
    expect(result.iterationCount).toBe(populatedState.iterationCount);
    expect(result.lastResult).toEqual(populatedState.lastResult);
    expect(result.authorized).toBe(populatedState.authorized);
    expect(result.clarificationNeeded).toBe(populatedState.clarificationNeeded);
    expect(result.humanInterventionNeeded).toBe(populatedState.humanInterventionNeeded);
    expect(result.guardrailReasons).toEqual(populatedState.guardrailReasons);
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
    expect(mockedPlanNextActions).not.toHaveBeenCalled();
  });

  it("rejects a cyclic lastResult before it ever reaches the graph", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const stateWithCyclicResult = { ...initialState, lastResult: cyclic };
    await expect(invokeSalesGraph(stateWithCyclicResult)).rejects.toThrow();
    expect(mockedPlanNextActions).not.toHaveBeenCalled();
  });
});
