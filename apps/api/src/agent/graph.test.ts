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

vi.mock("../escalation/escalation", () => ({
  createEscalation: vi.fn(),
}));

vi.mock("../conversation/conversation", () => ({
  loadConversationContext: vi.fn(),
  persistConversation: vi.fn(),
}));

// Partial mock: defaults to the REAL guardrail logic (via vi.fn(actual...)) so
// every existing TASK-021 integration test keeps exercising real behavior;
// only the one test that needs to prove escalation's own join-logic in
// isolation overrides it with mockReturnValueOnce (TASK-022A §28 explicitly
// allows selective mocking here).
vi.mock("./guardrails", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./guardrails")>();
  return {
    ...actual,
    evaluateCommercialGuardrails: vi.fn(actual.evaluateCommercialGuardrails),
  };
});

import { loadConversationContext, persistConversation } from "../conversation/conversation";
import { LlmError } from "../llm/reasoningClient";
import { createEscalation } from "../escalation/escalation";
import { executeAction } from "./actionExecutor";
import { buildSalesGraph, compileSalesGraph, invokeSalesGraph } from "./graph";
import { evaluateCommercialGuardrails } from "./guardrails";
import { OrchestratorError, planNextActions } from "./orchestrator";
import type { M3AKState } from "./state";

const mockedPlanNextActions = vi.mocked(planNextActions);
const mockedExecuteAction = vi.mocked(executeAction);
const mockedCreateEscalation = vi.mocked(createEscalation);
const mockedEvaluateCommercialGuardrails = vi.mocked(evaluateCommercialGuardrails);
const mockedLoadConversationContext = vi.mocked(loadConversationContext);
const mockedPersistConversation = vi.mocked(persistConversation);

const DEFAULT_PERSISTED_CONVERSATION = {
  id: "default-conversation",
  customerId: "default-customer",
  status: "active" as const,
  language: "unknown" as const,
  createdAt: "2026-09-19T00:00:00.000Z",
  updatedAt: "2026-09-19T00:00:00.000Z",
};

let originalMaxAgentSteps: string | undefined;

beforeEach(() => {
  originalMaxAgentSteps = process.env.MAX_AGENT_STEPS;
  // Sensible defaults for every pre-existing test that never mentions
  // conversation persistence: no conversation found on load (a safe {}
  // no-op), successful persist on write (also {} — never touches lastError).
  mockedLoadConversationContext.mockResolvedValue({ found: false });
  mockedPersistConversation.mockResolvedValue({
    persisted: true,
    conversation: DEFAULT_PERSISTED_CONVERSATION,
    newMessageCount: 0,
  });
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
  "__start__", "loadContext", "conversation", "router", "tool", "guardrail", "escalation", "response", "persist", "__end__",
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

  it("keeps the fixed prefix edges unchanged", async () => {
    const compiled = compileSalesGraph();
    const drawable = await compiled.getGraphAsync();
    const edges = drawable.edges.map((edge) => `${edge.source}->${edge.target}`);

    expect(edges).toContain("__start__->loadContext");
    expect(edges).toContain("loadContext->conversation");
    expect(edges).toContain("conversation->router");
  });

  it("wires guardrail->escalation, guardrail->response, escalation->response, response->persist, persist->END", async () => {
    const compiled = compileSalesGraph();
    const drawable = await compiled.getGraphAsync();
    const edges = drawable.edges.map((edge) => `${edge.source}->${edge.target}`);

    expect(edges).toContain("guardrail->escalation");
    expect(edges).toContain("guardrail->response");
    expect(edges).toContain("escalation->response");
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
    // The step limit sets humanInterventionNeeded:true, which now routes
    // through the (mocked) TASK-022 escalation node before reaching guardrail's
    // downstream state — a successful escalation never touches lastError.
    mockedCreateEscalation.mockResolvedValueOnce({
      created: true, replayed: false,
      escalation: {
        id: "escalation-step-limit", conversationId: "conversation-abc", reason: "agent_step_limit_reached",
        contextSummary: "x", status: "open", createdAt: "2026-09-19T00:00:00.000Z",
      },
    });

    const result = await invokeSalesGraph({ ...stateWithRef, conversationId: "conversation-abc" });

    expect(mockedExecuteAction).toHaveBeenCalledTimes(2);
    expect(mockedPlanNextActions).toHaveBeenCalledTimes(1);
    expect(result.iterationCount).toBe(2);
    expect(result.nextAction).toBeNull();
    expect(result.lastError).toBe("agent_step_limit_reached");
    expect(result.activePlan).toEqual(["CHECK_STOCK"]);
    expect(result.escalationId).toBe("escalation-step-limit");
  });

  it("defaults to 6 when MAX_AGENT_STEPS is unset", async () => {
    delete process.env.MAX_AGENT_STEPS;
    mockedPlanNextActions.mockResolvedValueOnce({
      plan: ["CHECK_STOCK", "CHECK_STOCK", "CHECK_STOCK", "CHECK_STOCK", "CHECK_STOCK", "CHECK_STOCK", "CHECK_STOCK"],
    });
    mockedExecuteAction.mockResolvedValue({ ok: true, result: { found: true, available: true }, resolvedRef: "REF-001" });
    mockedCreateEscalation.mockResolvedValueOnce({
      created: true, replayed: false,
      escalation: {
        id: "escalation-default-limit", conversationId: "conversation-abc", reason: "agent_step_limit_reached",
        contextSummary: "x", status: "open", createdAt: "2026-09-19T00:00:00.000Z",
      },
    });

    const result = await invokeSalesGraph({ ...stateWithRef, conversationId: "conversation-abc" });

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

    // TASK-023B: persist runs last but must never overwrite an already-set
    // lastError, so initialState (conversationId: null) exercises the real
    // precedence rule instead of needing a fake conversationId to dodge it.
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

describe("loop — fields outside the guardrail's write scope remain untouched (20)", () => {
  it("guardrail never writes activePlan/nextAction/executedSteps/iterationCount/lastResult/cart/orderId/escalationId/followupId", async () => {
    // activePlan/nextAction start empty so router calls the (mocked) planner
    // instead of deterministically continuing populatedState's own preset
    // plan — this isolates guardrail's effect from the loop's own mechanics.
    const stateAtGuardrail: M3AKState = { ...populatedState, activePlan: [], nextAction: null };
    mockedPlanNextActions.mockResolvedValueOnce({ plan: [] });

    const result = await invokeSalesGraph(stateAtGuardrail);

    expect(result.executedSteps).toEqual(stateAtGuardrail.executedSteps);
    expect(result.iterationCount).toBe(stateAtGuardrail.iterationCount);
    expect(result.lastResult).toEqual(stateAtGuardrail.lastResult);
    expect(result.cart).toEqual(stateAtGuardrail.cart);
    expect(result.orderId).toBe(stateAtGuardrail.orderId);
    expect(result.escalationId).toBe(stateAtGuardrail.escalationId);
    expect(result.followupId).toBe(stateAtGuardrail.followupId);
    expect(mockedExecuteAction).not.toHaveBeenCalled();
  });
});

describe("guardrail — TASK-021 integration (real evaluateCommercialGuardrails, no mocking)", () => {
  it("1: a verified observation reaches the final state with authorized:true, correct reasons, flags false", async () => {
    mockedPlanNextActions.mockResolvedValueOnce({ plan: ["CHECK_STOCK", "RESPOND"] });
    mockedExecuteAction.mockResolvedValueOnce({ ok: true, result: { found: true, available: true, stock: 5 }, resolvedRef: "REF-001" });

    const result = await invokeSalesGraph(stateWithRef);

    expect(result.authorized).toBe(true);
    expect(result.clarificationNeeded).toBe(false);
    expect(result.humanInterventionNeeded).toBe(false);
    expect(result.guardrailReasons).toEqual([]);
  });

  it("2: unknown delivery city yields authorized:false, clarificationNeeded:true, with a reason", async () => {
    // CHECK_DELIVERY's ok:false triggers TASK-020's own revision mechanism,
    // so a second planner call happens before the loop reaches guardrail.
    mockedPlanNextActions
      .mockResolvedValueOnce({ plan: ["CHECK_DELIVERY"] })
      .mockResolvedValueOnce({ plan: ["RESPOND"] });
    mockedExecuteAction.mockResolvedValueOnce({
      ok: false, result: { found: false, city: "Nowhere", reason: "city_not_in_delivery_grid" }, resolvedRef: null,
    });

    const result = await invokeSalesGraph(initialState);

    expect(result.authorized).toBe(false);
    expect(result.clarificationNeeded).toBe(true);
    expect(result.guardrailReasons).toEqual(["missing_delivery_evidence"]);
  });

  it("3: a malformed observation yields authorized:false and humanInterventionNeeded:true", async () => {
    mockedPlanNextActions.mockResolvedValueOnce({ plan: [] });

    const stateWithMalformedResult = { ...initialState, lastResult: "not-an-object" as never };
    const result = await invokeSalesGraph(stateWithMalformedResult);

    expect(result.authorized).toBe(false);
    expect(result.humanInterventionNeeded).toBe(true);
    expect(result.guardrailReasons).toEqual(["unverifiable_observation"]);
    expect(mockedExecuteAction).not.toHaveBeenCalled();
  });

  it("4: ESCALATE sets humanInterventionNeeded:true without ever calling executeAction", async () => {
    mockedPlanNextActions.mockResolvedValueOnce({ plan: ["ESCALATE"] });

    const result = await invokeSalesGraph(initialState);

    expect(mockedExecuteAction).not.toHaveBeenCalled();
    expect(result.humanInterventionNeeded).toBe(true);
    expect(result.authorized).toBeNull();
  });

  it("5: step limit yields authorized:false, humanInterventionNeeded:true, reason agent_step_limit_reached", async () => {
    process.env.MAX_AGENT_STEPS = "1";
    mockedPlanNextActions.mockResolvedValueOnce({ plan: ["CHECK_STOCK", "CHECK_STOCK"] });
    mockedExecuteAction.mockResolvedValue({ ok: true, result: { found: true, available: true }, resolvedRef: "REF-001" });

    const result = await invokeSalesGraph(stateWithRef);

    expect(result.authorized).toBe(false);
    expect(result.humanInterventionNeeded).toBe(true);
    expect(result.guardrailReasons).toEqual(["agent_step_limit_reached"]);
  });

  it("6: a verified promotion patch survives the graph merge", async () => {
    mockedPlanNextActions.mockResolvedValueOnce({ plan: ["CHECK_PROMOTION", "RESPOND"] });
    mockedExecuteAction.mockResolvedValueOnce({
      ok: true,
      result: { found: true, product: { ref: "REF-001" }, promotion: { id: "promo-1", productRef: "REF-001", promoPrice: 149.99 } },
      resolvedRef: "REF-001",
    });

    const result = await invokeSalesGraph(stateWithRef);

    expect(result.promotion).toEqual({ id: "promo-1", productRef: "REF-001", promoPrice: 149.99 });
  });

  it("7: a verified NO-promotion patch explicitly sets state.promotion to null, overriding a prior value", async () => {
    mockedPlanNextActions.mockResolvedValueOnce({ plan: ["CHECK_PROMOTION", "RESPOND"] });
    mockedExecuteAction.mockResolvedValueOnce({
      ok: true, result: { found: true, product: { ref: "REF-001" }, promotion: null }, resolvedRef: "REF-001",
    });

    const startingState: M3AKState = { ...stateWithRef, promotion: { id: "old-promo", productRef: "REF-001", promoPrice: 999 } };
    const result = await invokeSalesGraph(startingState);

    expect(result.promotion).toBeNull();
  });

  it("8: a verified delivery patch survives the graph merge", async () => {
    mockedPlanNextActions.mockResolvedValueOnce({ plan: ["CHECK_DELIVERY", "RESPOND"] });
    mockedExecuteAction.mockResolvedValueOnce({
      ok: true,
      result: { found: true, zone: { city: "Casablanca", fee: 25, delayHours: 24, cashOnDelivery: true, storePickup: false }, feeCents: 2500 },
      resolvedRef: null,
    });

    const result = await invokeSalesGraph(initialState);

    expect(result.delivery).toEqual({ city: "Casablanca", feeCents: 2500, delayHours: 24, cashOnDelivery: true, storePickup: false });
  });

  it("9: TASK-020 router/tool loop mechanics are unaffected by a real guardrail", async () => {
    mockedPlanNextActions.mockResolvedValueOnce({ plan: ["SEARCH_PRODUCTS", "CHECK_STOCK", "RESPOND"] });
    mockedExecuteAction
      .mockResolvedValueOnce({ ok: true, result: [{ ref: "REF-001" }], resolvedRef: "REF-001" })
      .mockResolvedValueOnce({ ok: true, result: { found: true, available: true }, resolvedRef: "REF-001" });

    const result = await invokeSalesGraph(initialState);

    expect(mockedPlanNextActions).toHaveBeenCalledTimes(1);
    expect(mockedExecuteAction).toHaveBeenCalledTimes(2);
    expect(result.executedSteps).toEqual(["SEARCH_PRODUCTS", "CHECK_STOCK"]);
    expect(result.iterationCount).toBe(2);
  });

  it("10: no escalation record or persistence side effect occurs (state-only signal)", async () => {
    mockedPlanNextActions.mockResolvedValueOnce({ plan: ["ESCALATE"] });

    const result = await invokeSalesGraph(initialState);

    expect(result.escalationId).toBeNull();
    expect(result.followupId).toBeNull();
  });
});

describe("escalation — TASK-022 integration", () => {
  const CONVERSATION_ID = "conversation-abc";

  function fakeEscalation(overrides: Record<string, unknown> = {}) {
    return {
      id: "escalation-1",
      conversationId: CONVERSATION_ID,
      reason: "orchestrator_requested_escalation",
      contextSummary: "intent=unknown; executedSteps=[]; guardrailReasons=[]; lastError=none",
      status: "open" as const,
      createdAt: "2026-09-19T00:00:00.000Z",
      ...overrides,
    };
  }

  it("1: no human intervention -> createEscalation is never called", async () => {
    mockedPlanNextActions.mockResolvedValueOnce({ plan: ["CHECK_STOCK", "RESPOND"] });
    mockedExecuteAction.mockResolvedValueOnce({ ok: true, result: { found: true, available: true }, resolvedRef: "REF-001" });

    await invokeSalesGraph(stateWithRef);

    expect(mockedCreateEscalation).not.toHaveBeenCalled();
  });

  it("2: explicit ESCALATE calls createEscalation once with the fallback reason", async () => {
    mockedPlanNextActions.mockResolvedValueOnce({ plan: ["ESCALATE"] });
    mockedCreateEscalation.mockResolvedValueOnce({ created: true, replayed: false, escalation: fakeEscalation() });

    const result = await invokeSalesGraph({ ...initialState, conversationId: CONVERSATION_ID });

    expect(mockedCreateEscalation).toHaveBeenCalledTimes(1);
    expect(mockedCreateEscalation.mock.calls[0]?.[1]).toBe("orchestrator_requested_escalation");
    expect(result.escalationId).toBe("escalation-1");
  });

  it("3: a malformed observation produces reason 'unverifiable_observation'", async () => {
    mockedPlanNextActions.mockResolvedValueOnce({ plan: [] });
    mockedCreateEscalation.mockResolvedValueOnce({
      created: true, replayed: false, escalation: fakeEscalation({ reason: "unverifiable_observation" }),
    });

    const stateWithMalformed = { ...initialState, conversationId: CONVERSATION_ID, lastResult: "not-an-object" as never };
    await invokeSalesGraph(stateWithMalformed);

    expect(mockedCreateEscalation.mock.calls[0]?.[1]).toBe("unverifiable_observation");
  });

  it("4: agent step limit produces reason 'agent_step_limit_reached'", async () => {
    process.env.MAX_AGENT_STEPS = "1";
    mockedPlanNextActions.mockResolvedValueOnce({ plan: ["CHECK_STOCK", "CHECK_STOCK"] });
    mockedExecuteAction.mockResolvedValue({ ok: true, result: { found: true, available: true }, resolvedRef: "REF-001" });
    mockedCreateEscalation.mockResolvedValueOnce({
      created: true, replayed: false, escalation: fakeEscalation({ reason: "agent_step_limit_reached" }),
    });

    await invokeSalesGraph({ ...stateWithRef, conversationId: CONVERSATION_ID });

    expect(mockedCreateEscalation.mock.calls[0]?.[1]).toBe("agent_step_limit_reached");
  });

  it("5: successful new creation lands the real escalation ID in state.escalationId", async () => {
    mockedPlanNextActions.mockResolvedValueOnce({ plan: ["ESCALATE"] });
    mockedCreateEscalation.mockResolvedValueOnce({
      created: true, replayed: false, escalation: fakeEscalation({ id: "real-escalation-id" }),
    });

    const result = await invokeSalesGraph({ ...initialState, conversationId: CONVERSATION_ID });

    expect(result.escalationId).toBe("real-escalation-id");
  });

  it("6: a replayed existing escalation lands the same real ID, with no special duplicate state", async () => {
    mockedPlanNextActions.mockResolvedValueOnce({ plan: ["ESCALATE"] });
    mockedCreateEscalation.mockResolvedValueOnce({
      created: true, replayed: true, escalation: fakeEscalation({ id: "existing-escalation-id" }),
    });

    const result = await invokeSalesGraph({ ...initialState, conversationId: CONVERSATION_ID });

    expect(result.escalationId).toBe("existing-escalation-id");
  });

  it("7: conversationId null -> createEscalation never called, escalationId stays null, exact lastError", async () => {
    mockedPlanNextActions.mockResolvedValueOnce({ plan: ["ESCALATE"] });

    const result = await invokeSalesGraph(initialState); // conversationId: null

    expect(mockedCreateEscalation).not.toHaveBeenCalled();
    expect(result.escalationId).toBeNull();
    // TASK-023B: escalation's own error has precedence. persist runs
    // afterward (escalation -> response -> persist), also detects the same
    // missing conversationId, but must never overwrite an already-set
    // lastError — the true earlier failure survives unchanged.
    expect(result.lastError).toBe("escalation_creation_failed: missing_conversation_id");
    expect(mockedPersistConversation).not.toHaveBeenCalled();
  });

  it("8: conversation_not_found -> escalationId stays null, controlled lastError", async () => {
    mockedPlanNextActions.mockResolvedValueOnce({ plan: ["ESCALATE"] });
    mockedCreateEscalation.mockResolvedValueOnce({ created: false, reason: "conversation_not_found" });

    const result = await invokeSalesGraph({ ...initialState, conversationId: CONVERSATION_ID });

    expect(result.escalationId).toBeNull();
    expect(result.lastError).toBe("escalation_creation_failed: conversation_not_found");
  });

  it("9: an unexpected createEscalation throw rejects invokeSalesGraph, not swallowed", async () => {
    mockedPlanNextActions.mockResolvedValueOnce({ plan: ["ESCALATE"] });
    mockedCreateEscalation.mockRejectedValueOnce(new Error("DB connection lost"));

    await expect(invokeSalesGraph({ ...initialState, conversationId: CONVERSATION_ID })).rejects.toThrow("DB connection lost");
  });

  it("10: the deterministic context summary exactly matches the contract", async () => {
    mockedPlanNextActions.mockResolvedValueOnce({ plan: ["ESCALATE"] });
    mockedCreateEscalation.mockResolvedValueOnce({ created: true, replayed: false, escalation: fakeEscalation() });

    const stateForSummary: M3AKState = {
      ...initialState,
      conversationId: CONVERSATION_ID,
      intent: "product_search",
      executedSteps: ["SEARCH_PRODUCTS", "CHECK_STOCK"],
      guardrailReasons: [],
      lastError: null,
    };
    await invokeSalesGraph(stateForSummary);

    expect(mockedCreateEscalation.mock.calls[0]?.[2]).toBe(
      "intent=product_search; executedSteps=[SEARCH_PRODUCTS,CHECK_STOCK]; guardrailReasons=[]; lastError=none",
    );
  });

  it("11: multiple guardrail reasons are joined with ', '", async () => {
    // Real evaluateCommercialGuardrails never currently produces >1 reason
    // alongside humanInterventionNeeded:true — this proves the escalation
    // node's own join logic in isolation (TASK-022A §28 explicitly allows
    // selective guardrail mocking for exactly this case).
    mockedPlanNextActions.mockResolvedValueOnce({ plan: [] });
    mockedEvaluateCommercialGuardrails.mockReturnValueOnce({
      authorized: false, clarificationNeeded: false, humanInterventionNeeded: true,
      reasons: ["missing_stock_evidence", "unsupported_restock_claim"],
    });
    mockedCreateEscalation.mockResolvedValueOnce({
      created: true, replayed: false,
      escalation: fakeEscalation({ reason: "missing_stock_evidence, unsupported_restock_claim" }),
    });

    await invokeSalesGraph({ ...initialState, conversationId: CONVERSATION_ID });

    expect(mockedCreateEscalation.mock.calls[0]?.[1]).toBe("missing_stock_evidence, unsupported_restock_claim");
  });

  it("12/13: TASK-020 loop and TASK-021 guardrail behavior are unaffected by escalation wiring", async () => {
    mockedPlanNextActions.mockResolvedValueOnce({ plan: ["SEARCH_PRODUCTS", "CHECK_STOCK", "RESPOND"] });
    mockedExecuteAction
      .mockResolvedValueOnce({ ok: true, result: [{ ref: "REF-001" }], resolvedRef: "REF-001" })
      .mockResolvedValueOnce({ ok: true, result: { found: true, available: true }, resolvedRef: "REF-001" });

    const result = await invokeSalesGraph(initialState);

    expect(result.executedSteps).toEqual(["SEARCH_PRODUCTS", "CHECK_STOCK"]);
    expect(result.authorized).toBe(true);
    expect(mockedCreateEscalation).not.toHaveBeenCalled();
  });

  it("14/15: response and persist remain no-op even on the escalation path", async () => {
    mockedPlanNextActions.mockResolvedValueOnce({ plan: ["ESCALATE"] });
    mockedCreateEscalation.mockResolvedValueOnce({ created: true, replayed: false, escalation: fakeEscalation() });

    const stateForNoop: M3AKState = {
      ...initialState,
      conversationId: CONVERSATION_ID,
      messages: [{ role: "customer", content: "hello" }],
    };
    const result = await invokeSalesGraph(stateForNoop);

    expect(result.messages).toEqual(stateForNoop.messages);
    expect(result.summary).toBe(stateForNoop.summary);
    expect(result.threadId).toBe(stateForNoop.threadId);
  });
});

describe("loadContext — TASK-023 integration", () => {
  const FOUND_CONVERSATION = {
    id: "conversation-loaded",
    customerId: "customer-loaded",
    status: "active" as const,
    language: "darija" as const,
    createdAt: "2026-09-18T10:00:00.000Z",
    updatedAt: "2026-09-19T09:00:00.000Z",
  };

  it("1: a found conversation populates conversationId/customerId/language/cart/escalationId", async () => {
    mockedLoadConversationContext.mockResolvedValueOnce({
      found: true,
      conversation: FOUND_CONVERSATION,
      messages: [],
      cart: { id: "cart-loaded", version: 1, items: [] },
      escalationId: "escalation-loaded",
    });
    mockedPlanNextActions.mockResolvedValueOnce({ plan: [] });

    const result = await invokeSalesGraph(initialState);

    expect(result.conversationId).toBe("conversation-loaded");
    expect(result.customerId).toBe("customer-loaded");
    expect(result.language).toBe("darija");
    expect(result.cart).toEqual({ id: "cart-loaded", version: 1, items: [] });
    expect(result.escalationId).toBe("escalation-loaded");
  });

  it("2: persisted messages are prepended to incoming current-invocation messages", async () => {
    mockedLoadConversationContext.mockResolvedValueOnce({
      found: true,
      conversation: FOUND_CONVERSATION,
      messages: [
        {
          id: "m1", conversationId: "conversation-loaded", role: "customer",
          content: "old message", createdAt: "2026-09-18T10:00:00.000Z",
        },
      ],
      cart: null,
      escalationId: null,
    });
    mockedPlanNextActions.mockResolvedValueOnce({ plan: [] });

    const stateWithIncoming: M3AKState = {
      ...initialState,
      messages: [{ role: "customer", content: "new message this turn" }],
    };
    const result = await invokeSalesGraph(stateWithIncoming);

    expect(result.messages).toEqual([
      { role: "customer", content: "old message" },
      { role: "customer", content: "new message this turn" },
    ]);
  });

  it("3: unknown thread leaves initial values unchanged", async () => {
    mockedLoadConversationContext.mockResolvedValueOnce({ found: false });
    mockedPlanNextActions.mockResolvedValueOnce({ plan: [] });

    const result = await invokeSalesGraph(initialState);

    expect(result.conversationId).toBeNull();
    expect(result.customerId).toBeNull();
    expect(result.language).toBe("unknown");
    expect(result.cart).toBeNull();
    expect(result.escalationId).toBeNull();
    expect(result.messages).toEqual([]);
  });

  it("4: a load DB exception propagates, not swallowed", async () => {
    mockedLoadConversationContext.mockRejectedValueOnce(new Error("connection lost"));

    await expect(invokeSalesGraph(initialState)).rejects.toThrow("connection lost");
  });

  it("5: no customer-memory side effects — only the six owned fields ever change", async () => {
    mockedLoadConversationContext.mockResolvedValueOnce({
      found: true, conversation: FOUND_CONVERSATION, messages: [], cart: null, escalationId: null,
    });
    mockedPlanNextActions.mockResolvedValueOnce({ plan: [] });

    const result = await invokeSalesGraph(initialState);

    expect(result.orderId).toBeNull();
    expect(result.followupId).toBeNull();
    expect(result.authorized).toBeNull();
    expect(result.activePlan).toEqual([]);
    expect(result.executedSteps).toEqual([]);
  });
});

describe("persist — TASK-023 integration", () => {
  it("1: the normal terminal path calls persistConversation", async () => {
    mockedPlanNextActions.mockResolvedValueOnce({ plan: ["RESPOND"] });

    await invokeSalesGraph({ ...initialState, conversationId: "conversation-abc" });

    expect(mockedPersistConversation).toHaveBeenCalledTimes(1);
  });

  it("2: the explicit ESCALATE path calls persist after escalation", async () => {
    mockedPlanNextActions.mockResolvedValueOnce({ plan: ["ESCALATE"] });
    mockedCreateEscalation.mockResolvedValueOnce({
      created: true, replayed: false,
      escalation: {
        id: "escalation-x", conversationId: "conversation-abc", reason: "orchestrator_requested_escalation",
        contextSummary: "x", status: "open", createdAt: "2026-09-19T00:00:00.000Z",
      },
    });

    await invokeSalesGraph({ ...initialState, conversationId: "conversation-abc" });

    expect(mockedPersistConversation).toHaveBeenCalledTimes(1);
  });

  it("3: the step-limit escalation path also calls persist", async () => {
    process.env.MAX_AGENT_STEPS = "1";
    mockedPlanNextActions.mockResolvedValueOnce({ plan: ["CHECK_STOCK", "CHECK_STOCK"] });
    mockedExecuteAction.mockResolvedValue({ ok: true, result: { found: true, available: true }, resolvedRef: "REF-001" });
    mockedCreateEscalation.mockResolvedValueOnce({
      created: true, replayed: false,
      escalation: {
        id: "escalation-y", conversationId: "conversation-abc", reason: "agent_step_limit_reached",
        contextSummary: "x", status: "open", createdAt: "2026-09-19T00:00:00.000Z",
      },
    });

    await invokeSalesGraph({ ...stateWithRef, conversationId: "conversation-abc" });

    expect(mockedPersistConversation).toHaveBeenCalledTimes(1);
  });

  it("4: hasOpenEscalation is derived only from escalationId !== null (true case)", async () => {
    mockedPlanNextActions.mockResolvedValueOnce({ plan: [] });

    await invokeSalesGraph({ ...initialState, conversationId: "conversation-abc", escalationId: "pre-existing-escalation" });

    expect(mockedPersistConversation.mock.calls[0]?.[2]).toBe(true);
  });

  it("4b: hasOpenEscalation is false when escalationId is null", async () => {
    mockedPlanNextActions.mockResolvedValueOnce({ plan: [] });

    await invokeSalesGraph({ ...initialState, conversationId: "conversation-abc" });

    expect(mockedPersistConversation.mock.calls[0]?.[2]).toBe(false);
  });

  it("5/6: the exact state language and cumulative messages are passed through", async () => {
    mockedPlanNextActions.mockResolvedValueOnce({ plan: [] });

    const stateForPersist: M3AKState = {
      ...initialState, conversationId: "conversation-abc", language: "darija",
      messages: [{ role: "customer", content: "hello" }],
    };
    await invokeSalesGraph(stateForPersist);

    expect(mockedPersistConversation.mock.calls[0]?.[1]).toBe("darija");
    expect(mockedPersistConversation.mock.calls[0]?.[3]).toEqual([{ role: "customer", content: "hello" }]);
  });

  it("7: missing conversationId -> no domain call, controlled skipped lastError", async () => {
    mockedPlanNextActions.mockResolvedValueOnce({ plan: [] });

    const result = await invokeSalesGraph(initialState);

    expect(mockedPersistConversation).not.toHaveBeenCalled();
    expect(result.lastError).toBe("conversation_persistence_skipped: missing_conversation_id");
  });

  it("8: conversation_not_found -> controlled failed lastError", async () => {
    mockedPlanNextActions.mockResolvedValueOnce({ plan: [] });
    mockedPersistConversation.mockResolvedValueOnce({ persisted: false, reason: "conversation_not_found" });

    const result = await invokeSalesGraph({ ...initialState, conversationId: "conversation-abc" });

    expect(result.lastError).toBe("conversation_persistence_failed: conversation_not_found");
  });

  it("TASK-023B/E: conversation_not_found with a pre-existing lastError preserves the prior error, even though the domain call still happens", async () => {
    process.env.MAX_AGENT_STEPS = "1";
    mockedPlanNextActions.mockResolvedValueOnce({ plan: ["CHECK_STOCK", "CHECK_STOCK"] });
    mockedExecuteAction.mockResolvedValue({ ok: true, result: { found: true, available: true }, resolvedRef: "REF-001" });
    mockedCreateEscalation.mockResolvedValueOnce({
      created: true, replayed: false,
      escalation: {
        id: "escalation-z", conversationId: "conversation-abc", reason: "agent_step_limit_reached",
        contextSummary: "x", status: "open", createdAt: "2026-09-19T00:00:00.000Z",
      },
    });
    mockedPersistConversation.mockResolvedValueOnce({ persisted: false, reason: "conversation_not_found" });

    // Router hits the step limit (lastError: "agent_step_limit_reached"), then
    // escalation succeeds (no lastError key -> the router's message survives),
    // so persist must find lastError already non-null and preserve it exactly,
    // despite calling persistConversation and getting a controlled failure.
    const result = await invokeSalesGraph({ ...stateWithRef, conversationId: "conversation-abc" });

    expect(mockedPersistConversation).toHaveBeenCalledTimes(1);
    expect(result.lastError).toBe("agent_step_limit_reached");
  });

  it("9: a successful persist returns no other state mutation", async () => {
    mockedPlanNextActions.mockResolvedValueOnce({ plan: [] });

    const result = await invokeSalesGraph({ ...initialState, conversationId: "conversation-abc" });

    expect(result.lastError).toBeNull();
  });

  it("TASK-023B: a successful persist never clears a pre-existing lastError", async () => {
    process.env.MAX_AGENT_STEPS = "1";
    mockedPlanNextActions.mockResolvedValueOnce({ plan: ["CHECK_STOCK", "CHECK_STOCK"] });
    mockedExecuteAction.mockResolvedValue({ ok: true, result: { found: true, available: true }, resolvedRef: "REF-001" });
    mockedCreateEscalation.mockResolvedValueOnce({
      created: true, replayed: false,
      escalation: {
        id: "escalation-w", conversationId: "conversation-abc", reason: "agent_step_limit_reached",
        contextSummary: "x", status: "open", createdAt: "2026-09-19T00:00:00.000Z",
      },
    });
    // Default beforeEach mock: persistConversation resolves persisted:true.

    const result = await invokeSalesGraph({ ...stateWithRef, conversationId: "conversation-abc" });

    expect(mockedPersistConversation).toHaveBeenCalledTimes(1);
    expect(result.lastError).toBe("agent_step_limit_reached");
  });

  it("10: a thrown DB error from persistConversation rejects invokeSalesGraph, not swallowed", async () => {
    mockedPlanNextActions.mockResolvedValueOnce({ plan: [] });
    mockedPersistConversation.mockRejectedValueOnce(new Error("DB connection lost"));

    await expect(invokeSalesGraph({ ...initialState, conversationId: "conversation-abc" })).rejects.toThrow(
      "DB connection lost",
    );
  });

  it("11-15: TASK-020/021/022 behavior, response no-op, and checkpointing remain unaffected", async () => {
    mockedPlanNextActions.mockResolvedValueOnce({ plan: ["SEARCH_PRODUCTS", "CHECK_STOCK", "RESPOND"] });
    mockedExecuteAction
      .mockResolvedValueOnce({ ok: true, result: [{ ref: "REF-001" }], resolvedRef: "REF-001" })
      .mockResolvedValueOnce({ ok: true, result: { found: true, available: true }, resolvedRef: "REF-001" });

    const result = await invokeSalesGraph({ ...initialState, conversationId: "conversation-abc" });

    expect(result.executedSteps).toEqual(["SEARCH_PRODUCTS", "CHECK_STOCK"]);
    expect(result.authorized).toBe(true);
    expect(mockedCreateEscalation).not.toHaveBeenCalled();
    expect(mockedPersistConversation).toHaveBeenCalledTimes(1);
    // response remains no-op: nothing beyond the loop's own approved fields changed.
    expect(result.messages).toEqual([]);
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
