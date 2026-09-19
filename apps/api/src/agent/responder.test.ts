import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../llm/fastClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../llm/fastClient")>();
  return { ...actual, fastChat: vi.fn() };
});

import { fastChat, LlmError } from "../llm/fastClient";
import { generateResponse } from "./responder";
import type { M3AKState } from "./state";

const mockedFastChat = vi.mocked(fastChat);

afterEach(() => {
  vi.resetAllMocks();
});

const baseState: M3AKState = {
  threadId: "thread-responder",
  conversationId: "conversation-responder",
  customerId: "customer-responder",
  customerMemory: null,
  messages: [{ role: "customer", content: "Bghit veste k7la taille M" }],
  summary: null,
  language: "french",
  intent: "product_search",
  extraction: {
    productQuery: "veste", family: "vestes", color: "noir", size: "M", quantity: 1,
    city: null, address: null, paymentMethod: null, confirmation: null,
  },
  cart: null,
  promotion: null,
  delivery: null,
  alternatives: [],
  cartTotalCents: null,
  nextAction: null,
  activePlan: [],
  executedSteps: ["SEARCH_PRODUCTS", "CHECK_STOCK"],
  iterationCount: 2,
  lastResult: { action: "CHECK_STOCK", ok: true, result: { found: true, available: true, stock: 5 }, resolvedRef: "REF-001" },
  lastError: null,
  authorized: true,
  clarificationNeeded: false,
  humanInterventionNeeded: false,
  guardrailReasons: [],
  orderId: null,
  escalationId: null,
  followupId: null,
};

function capturedUserPayload(): Record<string, unknown> {
  const call = mockedFastChat.mock.calls[0]?.[0];
  const userMessage = call?.find((message) => message.role === "user");
  return JSON.parse(userMessage?.content ?? "{}") as Record<string, unknown>;
}

describe("generateResponse — grounded mode (A, B)", () => {
  it("A: calls fastChat exactly once when authorized and not requiring clarification/escalation", async () => {
    mockedFastChat.mockResolvedValueOnce("Ce produit est disponible en taille M.");

    const result = await generateResponse(baseState);

    expect(mockedFastChat).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ content: "Ce produit est disponible en taille M." });
  });

  it("B: the supplied payload contains language, the latest customer message and mode", async () => {
    mockedFastChat.mockResolvedValueOnce("réponse");

    await generateResponse(baseState);

    const payload = capturedUserPayload();
    expect(payload.language).toBe("french");
    expect(payload.customerMessage).toBe("Bghit veste k7la taille M");
    expect(payload.mode).toBe("grounded");
  });

  it("uses the LAST customer-authored message, not merely the array's tail", async () => {
    mockedFastChat.mockResolvedValueOnce("réponse");
    const state: M3AKState = {
      ...baseState,
      messages: [
        { role: "customer", content: "Bghit veste k7la" },
        { role: "assistant", content: "Quelle taille ?" },
      ],
    };

    await generateResponse(state);

    expect(capturedUserPayload().customerMessage).toBe("Bghit veste k7la");
  });
});

describe("generateResponse — privacy boundary (C, D)", () => {
  it("C: raw internal identifiers never appear in the serialized payload", async () => {
    mockedFastChat.mockResolvedValueOnce("réponse");
    const state: M3AKState = {
      ...baseState,
      cart: { id: "cart-secret-id", version: 4, items: [{ productRef: "REF-001", quantity: 1, unitPrice: 199.95 }] },
      promotion: { id: "promotion-secret-id", productRef: "REF-001", promoPrice: 149.99 },
      orderId: "order-secret-id",
      escalationId: "escalation-secret-id",
      followupId: "followup-secret-id",
    };

    await generateResponse(state);

    const raw = JSON.stringify(mockedFastChat.mock.calls[0]?.[0]);
    expect(raw).not.toContain("conversation-responder");
    expect(raw).not.toContain("customer-responder");
    expect(raw).not.toContain("thread-responder");
    expect(raw).not.toContain("cart-secret-id");
    expect(raw).not.toContain("promotion-secret-id");
    expect(raw).not.toContain("order-secret-id");
    expect(raw).not.toContain("escalation-secret-id");
    expect(raw).not.toContain("followup-secret-id");
  });

  it("D: planner/internal control fields never appear in the serialized payload", async () => {
    mockedFastChat.mockResolvedValueOnce("réponse");
    const state: M3AKState = {
      ...baseState,
      activePlan: ["CHECK_DELIVERY", "RESPOND"],
      executedSteps: ["SEARCH_PRODUCTS", "CHECK_STOCK"],
      nextAction: "CHECK_DELIVERY",
      guardrailReasons: ["missing_delivery_evidence"],
      lastError: "orchestrator_planning_failed: timeout_error",
    };

    await generateResponse(state);

    const raw = JSON.stringify(mockedFastChat.mock.calls[0]?.[0]);
    expect(raw).not.toContain("CHECK_DELIVERY");
    expect(raw).not.toContain("activePlan");
    expect(raw).not.toContain("executedSteps");
    expect(raw).not.toContain("nextAction");
    expect(raw).not.toContain("missing_delivery_evidence");
    expect(raw).not.toContain("orchestrator_planning_failed");
  });

  it("the system prompt never leaks into the observation payload as business data", async () => {
    mockedFastChat.mockResolvedValueOnce("réponse");
    await generateResponse(baseState);
    const payload = capturedUserPayload();
    expect(JSON.stringify(payload)).not.toContain("SYSTEM_PROMPT");
    expect(Object.keys(payload).sort()).toEqual(
      [
        "language", "mode", "customerMessage", "lastAction", "observation",
        "cart", "promotion", "delivery", "alternatives", "orderConfirmed", "escalationCreated", "customerMemory",
      ].sort(),
    );
  });
});

describe("generateResponse — honest stock grounding (E, F)", () => {
  it("E: stock=0 / available:false survives sanitization as honest evidence", async () => {
    mockedFastChat.mockResolvedValueOnce("réponse");
    const state: M3AKState = {
      ...baseState,
      lastResult: { action: "CHECK_STOCK", ok: false, result: { found: true, available: false, stock: 0 }, resolvedRef: "REF-001" },
    };

    await generateResponse(state);

    const payload = capturedUserPayload();
    expect(payload.lastAction).toBe("CHECK_STOCK");
    expect(payload.observation).toEqual({ found: true, available: false, stock: 0 });
  });

  it("F: alternatives are included only when actually present in the real observation", async () => {
    mockedFastChat.mockResolvedValueOnce("réponse");
    const state: M3AKState = {
      ...baseState,
      lastResult: {
        action: "FIND_ALTERNATIVES", ok: true,
        result: { found: true, source: { ref: "REF-001" }, alternatives: [
          { ref: "REF-002", model: "Caftan", family: "Caftan", color: "beige", size: "L", price: 158, stock: 4 },
        ] },
        resolvedRef: "REF-001",
      },
    };

    await generateResponse(state);

    const payload = capturedUserPayload();
    expect(payload.observation).toEqual({
      found: true,
      alternatives: [{ ref: "REF-002", model: "Caftan", family: "Caftan", color: "beige", size: "L", price: 158, stock: 4 }],
    });
  });

  it("F: zero alternatives is represented as an empty array, never fabricated", async () => {
    mockedFastChat.mockResolvedValueOnce("réponse");
    const state: M3AKState = {
      ...baseState,
      lastResult: {
        action: "FIND_ALTERNATIVES", ok: false,
        result: { found: true, source: { ref: "REF-001" }, alternatives: [] },
        resolvedRef: "REF-001",
      },
    };

    await generateResponse(state);

    expect(capturedUserPayload().observation).toEqual({ found: true, alternatives: [] });
  });
});

describe("generateResponse — durable alternatives snapshot (TASK-034)", () => {
  it("grounds on state.alternatives even when lastResult is a later, unrelated action (real out-of-stock + real alternative scenario)", async () => {
    mockedFastChat.mockResolvedValueOnce("réponse");
    const state: M3AKState = {
      ...baseState,
      // The requested REF-0066 (Caftan noir, L) is still zero stock — this is
      // the MOST RECENT tool result, exactly as a redundant same-turn
      // CHECK_STOCK re-check would leave it (TASK-034's real reproduction).
      lastResult: {
        action: "CHECK_STOCK", ok: false,
        result: { found: true, ref: "REF-0066", stock: 0, available: false },
        resolvedRef: "REF-0066",
      },
      // Yet the real alternative found earlier this turn is still available
      // as a durable snapshot, independent of lastResult.
      alternatives: [
        { ref: "REF-0064", model: "Caftan noir", family: "Caftan", color: "noir", size: "S", price: 450, stock: 9 },
      ],
    };

    await generateResponse(state);

    const payload = capturedUserPayload();
    expect(payload.observation).toEqual({ found: true, available: false, stock: 0 });
    expect(payload.alternatives).toEqual([
      { ref: "REF-0064", model: "Caftan noir", family: "Caftan", color: "noir", size: "S", price: 450, stock: 9 },
    ]);
  });

  it("never carries a zero-stock or invented alternative — the snapshot only ever holds what the tool actually returned", async () => {
    mockedFastChat.mockResolvedValueOnce("réponse");
    const state: M3AKState = { ...baseState, alternatives: [] };

    await generateResponse(state);

    expect(capturedUserPayload().alternatives).toEqual([]);
  });
});

describe("generateResponse — discount evidence (TASK-036)", () => {
  it("an authorized discount is grounded in real MAD prices converted from the tool's cents", async () => {
    mockedFastChat.mockResolvedValueOnce("réponse");
    const state: M3AKState = {
      ...baseState,
      lastResult: {
        action: "VALIDATE_DISCOUNT", ok: true,
        result: {
          allowed: true, productRef: "REF-001", basePriceCents: 19995,
          minimumAllowedPriceCents: 17996, requestedPriceCents: 18000, reason: "within_discretionary_limit",
        },
        resolvedRef: "REF-001",
      },
    };

    await generateResponse(state);

    expect(capturedUserPayload().observation).toEqual({
      allowed: true, basePrice: 199.95, minimumAllowedPrice: 179.96, requestedPrice: 180,
    });
  });

  it("a discount exceeding the limit never surfaces as authorized, and the internal reason string never leaks", async () => {
    mockedFastChat.mockResolvedValueOnce("réponse");
    const state: M3AKState = {
      ...baseState,
      lastResult: {
        action: "VALIDATE_DISCOUNT", ok: false,
        result: {
          allowed: false, requiresEscalation: true, productRef: "REF-001", basePriceCents: 19995,
          minimumAllowedPriceCents: 17996, requestedPriceCents: 10000, reason: "discount_exceeds_limit",
        },
        resolvedRef: "REF-001",
      },
    };

    await generateResponse(state);

    const payload = capturedUserPayload();
    expect((payload.observation as { allowed: boolean }).allowed).toBe(false);
    expect(JSON.stringify(payload)).not.toContain("discount_exceeds_limit");
  });
});

describe("generateResponse — restock safety (G)", () => {
  it("G: a restockDate/restockDays/restockAt/expectedRestock key never reaches the payload", async () => {
    mockedFastChat.mockResolvedValueOnce("réponse");
    const state: M3AKState = {
      ...baseState,
      lastResult: {
        action: "CHECK_STOCK", ok: false,
        result: { found: true, available: false, stock: 0, restockDate: "2026-10-01", restockDays: 7, restockAt: "2026-10-01", expectedRestock: "soon" },
        resolvedRef: "REF-001",
      },
    };

    await generateResponse(state);

    const raw = JSON.stringify(mockedFastChat.mock.calls[0]?.[0]);
    expect(raw).not.toMatch(/restockDate|restockDays|restockAt|expectedRestock|2026-10-01/i);
    expect(capturedUserPayload().observation).toEqual({ found: true, available: false, stock: 0 });
  });

  it("G: an unrecognized action is never blindly serialized", async () => {
    mockedFastChat.mockResolvedValueOnce("réponse");
    const state: M3AKState = {
      ...baseState,
      lastResult: { action: "SOME_FUTURE_ACTION", ok: true, result: { secretInternalField: "leak-me" }, resolvedRef: null } as never,
    };

    await generateResponse(state);

    const raw = JSON.stringify(mockedFastChat.mock.calls[0]?.[0]);
    expect(raw).not.toContain("secretInternalField");
    expect(raw).not.toContain("leak-me");
    const payload = capturedUserPayload();
    expect(payload.lastAction).toBeNull();
    expect(payload.observation).toBeNull();
  });
});

describe("generateResponse — clarification mode (H)", () => {
  it("H: clarificationNeeded:true supplies mode 'clarification' and still calls fastChat", async () => {
    mockedFastChat.mockResolvedValueOnce("Quelle taille souhaitez-vous ?");
    const state: M3AKState = { ...baseState, authorized: false, clarificationNeeded: true };

    const result = await generateResponse(state);

    expect(mockedFastChat).toHaveBeenCalledTimes(1);
    expect(capturedUserPayload().mode).toBe("clarification");
    expect(result).toEqual({ content: "Quelle taille souhaitez-vous ?" });
  });

  it("H: authorized:false alone (no explicit clarificationNeeded) also yields clarification mode", async () => {
    mockedFastChat.mockResolvedValueOnce("réponse");
    const state: M3AKState = { ...baseState, authorized: false, clarificationNeeded: false };

    await generateResponse(state);

    expect(capturedUserPayload().mode).toBe("clarification");
  });
});

describe("generateResponse — escalation mode (I)", () => {
  it("I: humanInterventionNeeded:true never calls fastChat and returns a deterministic message", async () => {
    const state: M3AKState = { ...baseState, humanInterventionNeeded: true, guardrailReasons: ["agent_step_limit_reached"] };

    const result = await generateResponse(state);

    expect(mockedFastChat).not.toHaveBeenCalled();
    expect(result.content).toBeTruthy();
    expect(result.lastError).toBeUndefined();
  });

  it("I: the escalation message never exposes the escalation id or internal reason", async () => {
    const state: M3AKState = {
      ...baseState, humanInterventionNeeded: true, escalationId: "escalation-real-id",
      guardrailReasons: ["missing_stock_evidence"],
    };

    const result = await generateResponse(state);

    expect(result.content).not.toContain("escalation-real-id");
    expect(result.content).not.toContain("missing_stock_evidence");
    expect(result.content?.toLowerCase()).not.toMatch(/heure|minute|immédiat|disponible dans/);
  });

  it.each(["french", "arabic", "darija"] as const)("I: %s gets a distinct non-empty deterministic phrase", async (language) => {
    const result = await generateResponse({ ...baseState, language, humanInterventionNeeded: true });
    expect(result.content).toBeTruthy();
    expect(result.content?.trim().length).toBeGreaterThan(0);
  });

  it.each(["mixed", "unknown"] as const)("I: %s falls back to a neutral safe phrase", async (language) => {
    const result = await generateResponse({ ...baseState, language, humanInterventionNeeded: true });
    expect(result.content).toBeTruthy();
  });
});

describe("generateResponse — order confirmation (J)", () => {
  it("J: orderConfirmed is a boolean derived from orderId presence, never the raw UUID", async () => {
    mockedFastChat.mockResolvedValueOnce("réponse");
    const state: M3AKState = { ...baseState, orderId: "order-uuid-abc-123" };

    await generateResponse(state);

    const payload = capturedUserPayload();
    expect(payload.orderConfirmed).toBe(true);
    expect(JSON.stringify(payload)).not.toContain("order-uuid-abc-123");
  });

  it("J: orderConfirmed is false when no order exists yet", async () => {
    mockedFastChat.mockResolvedValueOnce("réponse");
    await generateResponse(baseState);
    expect(capturedUserPayload().orderConfirmed).toBe(false);
  });
});

describe("generateResponse — expected LLM failure (K)", () => {
  it("K: an expected LlmError yields a safe non-empty fallback and a bounded lastError category", async () => {
    mockedFastChat.mockRejectedValueOnce(new LlmError("timeout_error", "LLM request timed out after 15000ms — internal detail"));

    const result = await generateResponse(baseState);

    expect(result.content).toBeTruthy();
    expect(result.content).not.toContain("15000ms");
    expect(result.content).not.toContain("internal detail");
    expect(result.lastError).toBe("response_generation_failed: timeout_error");
  });

  it("K: a different LlmError category is reflected in the bounded lastError", async () => {
    mockedFastChat.mockRejectedValueOnce(new LlmError("config_error", "LLM_API_KEY is missing or empty"));

    const result = await generateResponse(baseState);

    expect(result.lastError).toBe("response_generation_failed: config_error");
    expect(result.content).not.toContain("LLM_API_KEY");
  });
});

describe("generateResponse — unexpected programmer error (L)", () => {
  it("L: a non-LlmError thrown by fastChat propagates, never swallowed", async () => {
    mockedFastChat.mockRejectedValueOnce(new TypeError("unexpected programming error"));

    await expect(generateResponse(baseState)).rejects.toThrow("unexpected programming error");
  });
});

describe("generateResponse — no customer message (M)", () => {
  it("M: no messages at all -> content null, fastChat never called", async () => {
    const result = await generateResponse({ ...baseState, messages: [] });

    expect(result).toEqual({ content: null });
    expect(mockedFastChat).not.toHaveBeenCalled();
  });

  it("M: only assistant/merchant messages, no customer message -> content null", async () => {
    const result = await generateResponse({
      ...baseState,
      messages: [{ role: "merchant", content: "note interne" }, { role: "assistant", content: "Bonjour" }],
    });

    expect(result).toEqual({ content: null });
    expect(mockedFastChat).not.toHaveBeenCalled();
  });

  it("M: a no-customer-message state never triggers escalation's deterministic path either", async () => {
    const result = await generateResponse({ ...baseState, messages: [], humanInterventionNeeded: true });
    expect(result).toEqual({ content: null });
  });
});

describe("generateResponse — success text hygiene (N)", () => {
  it("N: returned text is trimmed", async () => {
    mockedFastChat.mockResolvedValueOnce("   Ce produit est disponible.   \n");
    const result = await generateResponse(baseState);
    expect(result.content).toBe("Ce produit est disponible.");
  });

  it("N: whitespace-only output is never appended, falls back safely instead", async () => {
    mockedFastChat.mockResolvedValueOnce("   \n\t  ");
    const result = await generateResponse(baseState);
    expect(result.content).toBeTruthy();
    expect(result.content?.trim().length).toBeGreaterThan(0);
    expect(result.lastError).toBe("response_generation_failed: protocol_error");
  });
});
