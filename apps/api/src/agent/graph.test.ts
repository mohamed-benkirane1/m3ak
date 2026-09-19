import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./orchestrator", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./orchestrator")>();
  return {
    ...actual,
    planNextActions: vi.fn(),
  };
});

vi.mock("./actionExecutor", () => ({
  executeAction: vi.fn(),
}));

import { LlmError } from "../llm/reasoningClient";
import { executeAction } from "./actionExecutor";
import { buildSalesGraph, compileSalesGraph, invokeSalesGraph } from "./graph";
import { OrchestratorError, planNextActions } from "./orchestrator";
import type { M3AKState } from "./state";

const mockedPlanNextActions = vi.mocked(planNextActions);
const mockedExecuteAction = vi.mocked(executeAction);

let originalMaxAgentSteps: string | undefined;

beforeEach(() => {
  originalMaxAgentSteps = process.env.MAX_AGENT_STEPS;
});

afterEach(() => {
  vi.resetAllMocks();
  if (originalMaxAgentSteps === undefined) {
    delete process.env.MAX_AGENT_STEPS;
  } else {
    process.env.MAX_AGENT_STEPS = originalMaxAgentSteps;
  }
});

const initialState: M3AKState = {
  threadId: "thread-fixture-020",
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

const stateWithRef: M3AKState = {
  ...initialState,
  lastResult: { action: "SEARCH_PRODUCTS", ok: true, result: [], resolvedRef: "REF-001" },
};

const item = { productRef: "REF-001", quantity: 2, unitPrice: 199.95 };
const populatedState: M3AKState = {
  ...initialState,
  conversationId: "conversation-020",
  customerId: "customer-020",
  messages: [
    { role: "customer", content: "Bghit veste k7la" },
    { role: "assistant", content: "Quelle taille ?" },
  ],
  summary: "Le client souhaite deux vestes.",
  language: "mixed",
  intent: "product_search",
  extraction: {
    productQuery: "veste", family: "vestes", color: "noir", size: "M", quantity: 2,
    city: "Casablanca", address: "12 rue Exemple", paymentMethod: "cash_on_delivery", confirmation: true,
  },
  cart: { id: "cart-020", version: 3, items: [item] },
  promotion: { id: "promotion-020", productRef: "REF-001", promoPrice: 199.95 },
  delivery: { city: "Casablanca", feeCents: 2500, delayHours: 24, cashOnDelivery: true, storePickup: false },
  cartTotalCents: 39990,
  nextAction: "CHECK_DELIVERY",
  activePlan: ["CHECK_DELIVERY"],
  executedSteps: ["SEARCH_PRODUCTS", "CHECK_STOCK"],
  iterationCount: 2,
  lastResult: { action: "CHECK_STOCK", ok: true, result: { found: true, available: true }, resolvedRef: "REF-001" },
  lastError: null,
  authorized: false,
  clarificationNeeded: true,
  humanInterventionNeeded: true,
  guardrailReasons: ["Merchant review requested"],
  orderId: "order-020",
  escalationId: "escalation-020",
  followupId: "followup-020",
};

const EXPECTED_NODE_NAMES = [
  "__start__", "loadContext", "conversation", "router", "tool", "guardrail", "response", "persist", "__end__",
];

describe("buildSalesGraph / compileSalesGraph", () => {
  it("builds an uncompiled StateGraph exposing the builder API", () => {
    const builder = buildSalesGraph();
    expect(typeof builder.addNode).toBe("function");
    expect(typeof builder.addConditionalEdges).toBe("function");
    expect(typeof builder.compile).toBe("function");
  });

  it("compiles without a checkpointer", () => {
    const compiled = compileSalesGraph();
    expect(typeof compiled.invoke).toBe("function");
  });
});

describe("graph topology — loop-shaped after TASK-020", () => {
  it("exposes exactly the expected node names via getGraphAsync()", async () => {
    const compiled = compileSalesGraph();
    const drawable = await compiled.getGraphAsync();
    const nodeNames = new Set(Object.keys(drawable.nodes));
    expect(nodeNames).toEqual(new Set(EXPECTED_NODE_NAMES));
  });

  it("wires router->tool, router->guardrail and tool->router, but never tool->guardrail directly", async () => {
    const compiled = compileSalesGraph();
    const drawable = await compiled.getGraphAsync();
    const edges = drawable.edges.map((edge) => `${edge.source}->${edge.target}`);

    expect(edges).toContain("router->tool");
    expect(edges).toContain("router->guardrail");
    expect(edges).toContain("tool->router");
    expect(edges).not.toContain("tool->guardrail");
  });

  it("keeps the fixed prefix and suffix edges unchanged", async () => {
    const compiled = compileSalesGraph();
    const drawable = await compiled.getGraphAsync();
    const edges = drawable.edges.map((edge) => `${edge.source}->${edge.target}`);

    expect(edges).toContain("__start__->loadContext");
    expect(edges).toContain("loadContext->conversation");
    expect(edges).toContain("conversation->router");
    expect(edges).toContain("guardrail->response");
    expect(edges).toContain("response->persist");
    expect(edges).toContain("persist->__end__");
  });
});

describe("loop — multi-step deterministic continuation (1, 2, 6, 7, 8, 9)", () => {
  it("executes a multi-step plan deterministically without recalling the planner between successful steps", async () => {
    mockedPlanNextActions.mockResolvedValueOnce({ plan: ["SEARCH_PRODUCTS", "CHECK_STOCK", "RESPOND"] });
    mockedExecuteAction
      .mockResolvedValueOnce({ ok: true, result: [{ ref: "REF-001" }], resolvedRef: "REF-001" })
      .mockResolvedValueOnce({ ok: true, result: { found: true, available: true }, resolvedRef: "REF-001" });

    const result = await invokeSalesGraph(initialState);

    expect(mockedPlanNextActions).toHaveBeenCalledTimes(1);
    expect(mockedExecuteAction).toHaveBeenCalledTimes(2);
    expect(mockedExecuteAction).toHaveBeenNthCalledWith(1, "SEARCH_PRODUCTS", expect.objectContaining({ threadId: initialState.threadId }));
    expect(mockedExecuteAction).toHaveBeenNthCalledWith(2, "CHECK_STOCK", expect.objectContaining({ threadId: initialState.threadId }));
    expect(result.executedSteps).toEqual(["SEARCH_PRODUCTS", "CHECK_STOCK"]);
    expect(result.iterationCount).toBe(2);
    expect(result.nextAction).toBe("RESPOND");
    expect(result.activePlan).toEqual(["RESPOND"]);
    expect(result.lastResult).toEqual({
      action: "CHECK_STOCK", ok: true, result: { found: true, available: true }, resolvedRef: "REF-001",
    });
  });
});

describe("loop — revision on failure (3, 4, 16)", () => {
  it("a failed observation triggers a real planner revision, which is then executed to completion", async () => {
    mockedPlanNextActions
      .mockResolvedValueOnce({ plan: ["CHECK_STOCK", "RESPOND"] })
      .mockResolvedValueOnce({ plan: ["FIND_ALTERNATIVES", "RESPOND"] });
    mockedExecuteAction
      .mockResolvedValueOnce({ ok: false, result: { found: true, available: false }, resolvedRef: "REF-001" })
      .mockResolvedValueOnce({ ok: true, result: { found: true, alternatives: [] }, resolvedRef: "REF-001" });

    const result = await invokeSalesGraph(stateWithRef);

    expect(mockedPlanNextActions).toHaveBeenCalledTimes(2);
    expect(mockedExecuteAction).toHaveBeenCalledTimes(2);
    expect(mockedExecuteAction).toHaveBeenNthCalledWith(1, "CHECK_STOCK", expect.anything());
    expect(mockedExecuteAction).toHaveBeenNthCalledWith(2, "FIND_ALTERNATIVES", expect.anything());
    expect(result.executedSteps).toEqual(["CHECK_STOCK", "FIND_ALTERNATIVES"]);
    expect(result.nextAction).toBe("RESPOND");
  });

  it("the same stale failure does not cause a second replan without another tool attempt in between", async () => {
    mockedPlanNextActions
      .mockResolvedValueOnce({ plan: ["CHECK_STOCK"] })
      .mockResolvedValueOnce({ plan: ["FIND_ALTERNATIVES"] })
      .mockResolvedValueOnce({ plan: [] });
    mockedExecuteAction
      .mockResolvedValueOnce({ ok: false, result: { found: true, available: false }, resolvedRef: "REF-001" })
      .mockResolvedValueOnce({ ok: true, result: { found: true, alternatives: [] }, resolvedRef: "REF-001" });

    await invokeSalesGraph(stateWithRef);

    // Exactly 3 planner calls: initial, one revision from the failure, one
    // exhaustion-replan after FIND_ALTERNATIVES succeeds — never a second
    // revision from the SAME original failure.
    expect(mockedPlanNextActions).toHaveBeenCalledTimes(3);
    expect(mockedExecuteAction).toHaveBeenCalledTimes(2);
  });
});

describe("loop — replan on exhaustion, not only failure (5, 10)", () => {
  it("replans when the current plan is exhausted after a SUCCESSFUL step, and an empty revised plan terminates", async () => {
    mockedPlanNextActions
      .mockResolvedValueOnce({ plan: ["CHECK_DELIVERY"] })
      .mockResolvedValueOnce({ plan: [] });
    mockedExecuteAction.mockResolvedValueOnce({ ok: true, result: { found: true, feeCents: 2500 }, resolvedRef: null });

    const result = await invokeSalesGraph(initialState);

    expect(mockedPlanNextActions).toHaveBeenCalledTimes(2);
    expect(mockedExecuteAction).toHaveBeenCalledTimes(1);
    expect(result.activePlan).toEqual([]);
    expect(result.nextAction).toBeNull();
  });
});

describe("loop — terminal actions never dispatch to tool (11, 12)", () => {
  it("RESPOND terminates without ever calling executeAction", async () => {
    mockedPlanNextActions.mockResolvedValueOnce({ plan: ["RESPOND"] });

    const result = await invokeSalesGraph(initialState);

    expect(mockedExecuteAction).not.toHaveBeenCalled();
    expect(result.nextAction).toBe("RESPOND");
    expect(result.iterationCount).toBe(0);
    expect(result.executedSteps).toEqual([]);
  });

  it("ESCALATE terminates without ever calling executeAction", async () => {
    mockedPlanNextActions.mockResolvedValueOnce({ plan: ["ESCALATE"] });

    const result = await invokeSalesGraph(initialState);

    expect(mockedExecuteAction).not.toHaveBeenCalled();
    expect(result.nextAction).toBe("ESCALATE");
  });
});

describe("loop — MAX_AGENT_STEPS (13, 14)", () => {
  it("allows exactly N tool visits then stops, and never calls the planner again after the limit", async () => {
    process.env.MAX_AGENT_STEPS = "2";
    mockedPlanNextActions.mockResolvedValueOnce({ plan: ["CHECK_STOCK", "CHECK_STOCK", "CHECK_STOCK"] });
    mockedExecuteAction.mockResolvedValue({ ok: true, result: { found: true, available: true }, resolvedRef: "REF-001" });

    const result = await invokeSalesGraph(stateWithRef);

    expect(mockedExecuteAction).toHaveBeenCalledTimes(2);
    expect(mockedPlanNextActions).toHaveBeenCalledTimes(1);
    expect(result.iterationCount).toBe(2);
    expect(result.nextAction).toBeNull();
    expect(result.lastError).toBe("agent_step_limit_reached");
    expect(result.activePlan).toEqual(["CHECK_STOCK"]);
  });

  it("defaults to 6 when MAX_AGENT_STEPS is unset", async () => {
    delete process.env.MAX_AGENT_STEPS;
    mockedPlanNextActions.mockResolvedValueOnce({
      plan: ["CHECK_STOCK", "CHECK_STOCK", "CHECK_STOCK", "CHECK_STOCK", "CHECK_STOCK", "CHECK_STOCK", "CHECK_STOCK"],
    });
    mockedExecuteAction.mockResolvedValue({ ok: true, result: { found: true, available: true }, resolvedRef: "REF-001" });

    const result = await invokeSalesGraph(stateWithRef);

    expect(mockedExecuteAction).toHaveBeenCalledTimes(6);
    expect(result.lastError).toBe("agent_step_limit_reached");
  });

  it("rejects an invalid MAX_AGENT_STEPS instead of silently coercing it", async () => {
    process.env.MAX_AGENT_STEPS = "not-a-number";
    mockedPlanNextActions.mockResolvedValueOnce({ plan: ["CHECK_STOCK"] });

    await expect(invokeSalesGraph(stateWithRef)).rejects.toThrow(/Invalid MAX_AGENT_STEPS/);
  });
});

describe("loop — missing-input controlled failure (15)", () => {
  it("a missing-input controlled failure revises safely, exactly like a business-negative outcome", async () => {
    mockedPlanNextActions
      .mockResolvedValueOnce({ plan: ["CHECK_STOCK", "RESPOND"] })
      .mockResolvedValueOnce({ plan: ["RESPOND"] });
    mockedExecuteAction.mockResolvedValueOnce({ ok: false, result: { reason: "missing_required_input" }, resolvedRef: null });

    const result = await invokeSalesGraph(initialState);

    expect(mockedPlanNextActions).toHaveBeenCalledTimes(2);
    expect(result.nextAction).toBe("RESPOND");
  });
});

describe("loop — unexpected executor error propagates (17)", () => {
  it("an unexpected error thrown by executeAction rejects invokeSalesGraph, not swallowed", async () => {
    mockedPlanNextActions.mockResolvedValueOnce({ plan: ["CHECK_STOCK"] });
    mockedExecuteAction.mockRejectedValueOnce(new Error("DB connection lost"));

    await expect(invokeSalesGraph(stateWithRef)).rejects.toThrow("DB connection lost");
  });
});

describe("loop — recognized LLM transport error during revision", () => {
  it("resolves the graph with a safe category-based lastError instead of crashing", async () => {
    mockedPlanNextActions.mockRejectedValueOnce(new LlmError("timeout_error", "LLM request timed out after 60000ms"));

    const result = await invokeSalesGraph(initialState);

    expect(result.activePlan).toEqual([]);
    expect(result.nextAction).toBeNull();
    expect(result.lastError).toBe("orchestrator_planning_failed: timeout_error");
  });

  it("an orchestrator validation error also resolves gracefully", async () => {
    mockedPlanNextActions.mockRejectedValueOnce(
      new OrchestratorError("schema_mismatch", "Planner response did not match the orchestrator plan schema"),
    );

    const result = await invokeSalesGraph(initialState);

    expect(result.lastError).toBe("orchestrator_planning_failed: schema_mismatch");
  });

  it("an unexpected planner error is not swallowed", async () => {
    mockedPlanNextActions.mockRejectedValueOnce(new TypeError("unexpected programming error"));

    await expect(invokeSalesGraph(initialState)).rejects.toThrow();
  });
});

describe("loop — approved state patches survive the graph merge (18, 19)", () => {
  it("a cartPatch from executeAction survives into state.cart", async () => {
    mockedPlanNextActions
      .mockResolvedValueOnce({ plan: ["CREATE_CART"] })
      .mockResolvedValueOnce({ plan: [] });
    mockedExecuteAction.mockResolvedValueOnce({
      ok: true, result: { created: true }, resolvedRef: null,
      cartPatch: { id: "cart-1", version: 0, items: [] },
    });

    const result = await invokeSalesGraph(initialState);

    expect(result.cart).toEqual({ id: "cart-1", version: 0, items: [] });
  });

  it("an orderId from executeAction survives into state.orderId", async () => {
    mockedPlanNextActions
      .mockResolvedValueOnce({ plan: ["CREATE_ORDER"] })
      .mockResolvedValueOnce({ plan: [] });
    mockedExecuteAction.mockResolvedValueOnce({
      ok: true, result: { created: true }, resolvedRef: null, orderId: "order-1",
    });

    const result = await invokeSalesGraph(initialState);

    expect(result.orderId).toBe("order-1");
  });
});

describe("loop — TASK-021 guardrail fields remain untouched (20)", () => {
  it("leaves authorized/clarificationNeeded/humanInterventionNeeded/guardrailReasons untouched through a real loop iteration", async () => {
    mockedPlanNextActions.mockResolvedValueOnce({ plan: [] });
    mockedExecuteAction.mockResolvedValueOnce({ ok: true, result: { found: true }, resolvedRef: "REF-001" });

    const result = await invokeSalesGraph(populatedState);

    expect(result.authorized).toBe(populatedState.authorized);
    expect(result.clarificationNeeded).toBe(populatedState.clarificationNeeded);
    expect(result.humanInterventionNeeded).toBe(populatedState.humanInterventionNeeded);
    expect(result.guardrailReasons).toEqual(populatedState.guardrailReasons);
    expect(result.escalationId).toBe(populatedState.escalationId);
    expect(result.followupId).toBe(populatedState.followupId);
  });
});

describe("invokeSalesGraph — outer JSON-safety boundary preserved (21)", () => {
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
    expect(mockedExecuteAction).not.toHaveBeenCalled();
  });

  it("rejects a cyclic lastResult before it ever reaches the graph", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const stateWithCyclicResult = { ...initialState, lastResult: cyclic };
    await expect(invokeSalesGraph(stateWithCyclicResult)).rejects.toThrow();
    expect(mockedPlanNextActions).not.toHaveBeenCalled();
  });
});
