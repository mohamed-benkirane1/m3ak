import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../llm/reasoningClient", () => ({
  reasoningChat: vi.fn(),
}));

import { reasoningChat } from "../llm/reasoningClient";
import { LlmError } from "../llm/transport";
import { AllowedActionSchema, OrchestratorError, OrchestratorPlanSchema, planNextActions } from "./orchestrator";
import type { M3AKState } from "./state";

const mockedReasoningChat = vi.mocked(reasoningChat);

const baseState: M3AKState = {
  threadId: "thread-019",
  conversationId: null,
  customerId: null,
  customerMemory: null,
  messages: [],
  summary: null,
  language: "french",
  intent: "product_search",
  extraction: {
    productQuery: "veste", family: null, color: "noir", size: "M", quantity: 1,
    city: null, address: null, paymentMethod: null, confirmation: null,
  },
  cart: null,
  promotion: null,
  delivery: null,
  cartTotalCents: null,
  nextAction: null,
  activePlan: [],
  executedSteps: ["SEARCH_PRODUCTS"],
  iterationCount: 0,
  lastResult: { found: true },
  lastError: null,
  authorized: null,
  clarificationNeeded: false,
  humanInterventionNeeded: false,
  guardrailReasons: [],
  orderId: null,
  escalationId: null,
  followupId: null,
};

function resolvePlan(plan: unknown, extra: Record<string, unknown> = {}) {
  mockedReasoningChat.mockResolvedValueOnce(JSON.stringify({ plan, ...extra }));
}

afterEach(() => {
  vi.resetAllMocks();
});

describe("planNextActions — valid plans (1-4, 11)", () => {
  it("1: accepts a valid multi-step plan", async () => {
    resolvePlan(["SEARCH_PRODUCTS", "CHECK_STOCK", "RESPOND"]);

    const result = await planNextActions(baseState);

    expect(result).toEqual({ plan: ["SEARCH_PRODUCTS", "CHECK_STOCK", "RESPOND"] });
  });

  it("2: accepts a plan containing FIND_ALTERNATIVES", async () => {
    resolvePlan(["CHECK_STOCK", "FIND_ALTERNATIVES", "RESPOND"]);

    const result = await planNextActions(baseState);

    expect(result.plan).toEqual(["CHECK_STOCK", "FIND_ALTERNATIVES", "RESPOND"]);
  });

  it("3: accepts an empty plan", async () => {
    resolvePlan([]);

    const result = await planNextActions(baseState);

    expect(result).toEqual({ plan: [] });
  });

  it("4: accepts duplicate actions", async () => {
    resolvePlan(["CHECK_STOCK", "CHECK_STOCK"]);

    const result = await planNextActions(baseState);

    expect(result.plan).toEqual(["CHECK_STOCK", "CHECK_STOCK"]);
  });

  it("11: accepts a valid terminal action as the last element", async () => {
    resolvePlan(["CHECK_STOCK", "RESPOND"]);

    const result = await planNextActions(baseState);

    expect(result.plan).toEqual(["CHECK_STOCK", "RESPOND"]);
  });

  it("accepts a plan containing CREATE_CART", async () => {
    resolvePlan(["CREATE_CART", "ADD_TO_CART", "CREATE_ORDER"]);

    const result = await planNextActions(baseState);

    expect(result.plan).toEqual(["CREATE_CART", "ADD_TO_CART", "CREATE_ORDER"]);
  });
});

describe("planNextActions — malformed/invalid responses (5-7)", () => {
  it("5: malformed JSON -> invalid_json", async () => {
    mockedReasoningChat.mockResolvedValueOnce("{not valid json");

    await expect(planNextActions(baseState)).rejects.toMatchObject({
      name: "OrchestratorError",
      category: "invalid_json",
    });
  });

  it("6: unknown action -> schema_mismatch", async () => {
    resolvePlan(["FLY_TO_MOON"]);

    await expect(planNextActions(baseState)).rejects.toMatchObject({
      name: "OrchestratorError",
      category: "schema_mismatch",
    });
  });

  it("7: extra output field -> schema_mismatch", async () => {
    resolvePlan([], { reason: "because the customer asked" });

    await expect(planNextActions(baseState)).rejects.toMatchObject({
      name: "OrchestratorError",
      category: "schema_mismatch",
    });
  });
});

describe("planNextActions — terminal action ordering (8-10)", () => {
  it("8: RESPOND before another action -> invalid_plan", async () => {
    resolvePlan(["RESPOND", "CHECK_STOCK"]);

    await expect(planNextActions(baseState)).rejects.toMatchObject({
      name: "OrchestratorError",
      category: "invalid_plan",
    });
  });

  it("9: ESCALATE before another action -> invalid_plan", async () => {
    resolvePlan(["ESCALATE", "CHECK_STOCK"]);

    await expect(planNextActions(baseState)).rejects.toMatchObject({
      name: "OrchestratorError",
      category: "invalid_plan",
    });
  });

  it("10: both terminal actions -> invalid_plan", async () => {
    resolvePlan(["ESCALATE", "RESPOND"]);

    await expect(planNextActions(baseState)).rejects.toMatchObject({
      name: "OrchestratorError",
      category: "invalid_plan",
    });
  });
});

describe("planNextActions — transport error propagation (12)", () => {
  it("12: an LlmError thrown by reasoningChat propagates as-is, never wrapped in OrchestratorError", async () => {
    mockedReasoningChat.mockRejectedValueOnce(new LlmError("rate_limited", "LLM request failed with HTTP 429 Too Many Requests"));

    let caught: unknown;
    try {
      await planNextActions(baseState);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(LlmError);
    expect(caught).not.toBeInstanceOf(OrchestratorError);
    expect((caught as LlmError).category).toBe("rate_limited");
  });
});

describe("planNextActions — no retry (13)", () => {
  it("13a: exactly one reasoningChat call on success", async () => {
    resolvePlan(["RESPOND"]);
    await planNextActions(baseState);
    expect(mockedReasoningChat).toHaveBeenCalledTimes(1);
  });

  it("13b: exactly one reasoningChat call on malformed JSON", async () => {
    mockedReasoningChat.mockResolvedValueOnce("{not valid json");
    await expect(planNextActions(baseState)).rejects.toThrow();
    expect(mockedReasoningChat).toHaveBeenCalledTimes(1);
  });

  it("13c: exactly one reasoningChat call on schema mismatch", async () => {
    resolvePlan(["FLY_TO_MOON"]);
    await expect(planNextActions(baseState)).rejects.toThrow();
    expect(mockedReasoningChat).toHaveBeenCalledTimes(1);
  });
});

describe("planNextActions — planner payload contract (14)", () => {
  it("14: user payload contains EXACTLY language, intent, extraction, executedSteps, lastOutcomeOk, remainingPlan, customerMemory", async () => {
    resolvePlan(["RESPOND"]);

    await planNextActions(baseState);

    const messages = mockedReasoningChat.mock.calls[0]?.[0];
    const userMessage = messages?.[1];
    expect(userMessage?.role).toBe("user");
    const payload = JSON.parse(userMessage?.content ?? "{}") as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual([
      "customerMemory", "executedSteps", "extraction", "intent", "language", "lastOutcomeOk", "remainingPlan",
    ]);
    expect(payload.language).toBe(baseState.language);
    expect(payload.intent).toBe(baseState.intent);
    expect(payload.extraction).toEqual(baseState.extraction);
    expect(payload.executedSteps).toEqual(baseState.executedSteps);
    expect(payload.remainingPlan).toEqual(baseState.activePlan);
    expect(payload.customerMemory).toEqual(baseState.customerMemory);
  });

  it("customerMemory-a: null works normally — the payload key is still present, as null", async () => {
    resolvePlan(["RESPOND"]);

    await planNextActions({ ...baseState, customerMemory: null });

    const payload = JSON.parse(mockedReasoningChat.mock.calls[0]?.[0]?.[1]?.content ?? "{}") as Record<string, unknown>;
    expect(payload.customerMemory).toBeNull();
  });

  it("customerMemory-b: a populated customerMemory is passed through exactly, with only its authorized fields", async () => {
    resolvePlan(["RESPOND"]);
    const memory = {
      city: "Casablanca",
      preferredLanguage: "darija" as const,
      totalKnownOrders: 3,
      latestOrderDate: "2026-08-01T00:00:00.000Z",
      recentProducts: ["REF-001", "REF-002"],
    };

    await planNextActions({ ...baseState, customerMemory: memory });

    const payload = JSON.parse(mockedReasoningChat.mock.calls[0]?.[0]?.[1]?.content ?? "{}") as Record<string, unknown>;
    expect(payload.customerMemory).toEqual(memory);
    expect(Object.keys(payload.customerMemory as object).sort()).toEqual([
      "city", "latestOrderDate", "preferredLanguage", "recentProducts", "totalKnownOrders",
    ]);
  });

  it("customerMemory-c: the system prompt states customerMemory cannot replace live business checks or explicit confirmation", async () => {
    resolvePlan(["RESPOND"]);

    await planNextActions(baseState);

    const systemMessage = mockedReasoningChat.mock.calls[0]?.[0]?.[0];
    expect(systemMessage?.role).toBe("system");
    expect(systemMessage?.content).toMatch(/customerMemory/);
    expect(systemMessage?.content).toMatch(/never substitutes for a real CHECK_STOCK/i);
    expect(systemMessage?.content).toMatch(/never by itself authorizes CREATE_ORDER/i);
    expect(systemMessage?.content).toMatch(/never replaces the customer's explicit confirmation/i);
  });

  it("14b: no business/internal fields (messages, cart, lastResult, IDs) leak into the payload", async () => {
    resolvePlan(["RESPOND"]);

    await planNextActions(baseState);

    const messages = mockedReasoningChat.mock.calls[0]?.[0];
    const userContent = messages?.[1]?.content ?? "";
    expect(userContent).not.toContain("lastResult");
    expect(userContent).not.toContain("threadId");
    expect(userContent).not.toContain("cart");
    expect(userContent).not.toContain("orderId");
  });

  it("14c: lastOutcomeOk is null when lastResult carries no boolean ok", async () => {
    resolvePlan(["RESPOND"]);

    await planNextActions({ ...baseState, lastResult: { found: true } });

    const payload = JSON.parse(mockedReasoningChat.mock.calls[0]?.[0]?.[1]?.content ?? "{}") as Record<string, unknown>;
    expect(payload.lastOutcomeOk).toBeNull();
  });

  it.each([true, false])("14d: lastOutcomeOk is %s when lastResult.ok is %s", async (ok) => {
    resolvePlan(["RESPOND"]);

    await planNextActions({
      ...baseState,
      lastResult: { action: "CHECK_STOCK", ok, result: { found: true }, resolvedRef: "REF-001" },
    });

    const payload = JSON.parse(mockedReasoningChat.mock.calls[0]?.[0]?.[1]?.content ?? "{}") as Record<string, unknown>;
    expect(payload.lastOutcomeOk).toBe(ok);
  });

  it("14e: only the redacted lastOutcomeOk boolean is sent — raw business data from lastResult never leaks", async () => {
    resolvePlan(["RESPOND"]);

    await planNextActions({
      ...baseState,
      lastResult: { action: "CHECK_STOCK", ok: true, result: { found: true, stock: 42, priceCents: 199995 }, resolvedRef: "REF-001" },
    });

    const userContent = mockedReasoningChat.mock.calls[0]?.[0]?.[1]?.content ?? "";
    expect(userContent).not.toContain("42");
    expect(userContent).not.toContain("199995");
    expect(userContent).not.toContain("resolvedRef");
  });

  it("14f: remainingPlan reflects the current activePlan", async () => {
    resolvePlan(["RESPOND"]);

    await planNextActions({ ...baseState, activePlan: ["CHECK_STOCK", "RESPOND"] });

    const payload = JSON.parse(mockedReasoningChat.mock.calls[0]?.[0]?.[1]?.content ?? "{}") as Record<string, unknown>;
    expect(payload.remainingPlan).toEqual(["CHECK_STOCK", "RESPOND"]);
  });
});

describe("planNextActions — system prompt contract (15-17)", () => {
  it("15: system prompt lists all 10 exact allowed action values, including CREATE_CART", async () => {
    resolvePlan(["RESPOND"]);

    await planNextActions(baseState);

    const systemContent = mockedReasoningChat.mock.calls[0]?.[0]?.[0]?.content ?? "";
    expect(AllowedActionSchema.options).toHaveLength(10);
    expect(AllowedActionSchema.options).toContain("CREATE_CART");
    for (const action of AllowedActionSchema.options) {
      expect(systemContent).toContain(action);
    }
  });

  it("16: system prompt forbids inventing business truth", async () => {
    resolvePlan(["RESPOND"]);

    await planNextActions(baseState);

    const systemContent = mockedReasoningChat.mock.calls[0]?.[0]?.[0]?.content ?? "";
    expect(systemContent).toMatch(/never invent/i);
    expect(systemContent).toMatch(/price/i);
    expect(systemContent).toMatch(/stock/i);
    expect(systemContent).toMatch(/delivery/i);
    expect(systemContent).toMatch(/deterministic tools/i);
  });

  it("17: system prompt requires raw JSON only, no markdown", async () => {
    resolvePlan(["RESPOND"]);

    await planNextActions(baseState);

    const systemContent = mockedReasoningChat.mock.calls[0]?.[0]?.[0]?.content ?? "";
    expect(systemContent).toMatch(/raw JSON/i);
    expect(systemContent).toMatch(/no Markdown/i);
    expect(systemContent).toContain('"plan"');
  });
});

describe("OrchestratorPlanSchema exported and directly usable", () => {
  it("accepts a valid plan object", () => {
    expect(OrchestratorPlanSchema.safeParse({ plan: ["RESPOND"] }).success).toBe(true);
  });

  it("rejects an unknown extra key (strict)", () => {
    expect(OrchestratorPlanSchema.safeParse({ plan: [], extra: true }).success).toBe(false);
  });

  it("rejects an unknown action", () => {
    expect(OrchestratorPlanSchema.safeParse({ plan: ["NOT_AN_ACTION"] }).success).toBe(false);
  });
});
