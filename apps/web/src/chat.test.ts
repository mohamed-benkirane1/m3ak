import { describe, expect, it } from "vitest";
import {
  DEMO_PERSONAS,
  UNKNOWN_SERVER_ERROR_MESSAGE,
  applyActivityFrame,
  buildChatWebSocketUrl,
  buildOutgoingMessage,
  getActivityStateLabel,
  getActivityStatusLabel,
  getGuardrailCategoryLabel,
  getGuardrailStatusLabel,
  getSafeErrorMessage,
  getToolLabel,
  parseServerFrame,
} from "./chat";

describe("demo personas", () => {
  it("contains exactly the three approved seeded personas and no private fields", () => {
    expect(DEMO_PERSONAS).toEqual([
      { label: "Persona français", customerRef: "CLI-0001" },
      { label: "Persona Darija", customerRef: "CLI-0004" },
      { label: "Persona arabe", customerRef: "CLI-0022" },
    ]);
    for (const persona of DEMO_PERSONAS) {
      expect(Object.keys(persona).sort()).toEqual(["customerRef", "label"]);
      expect(JSON.stringify(persona)).not.toMatch(/name|phone|city|address|customerId|memory|uuid/i);
    }
  });
});

describe("WebSocket URL construction", () => {
  it("uses a trimmed VITE_WS_URL override", () => {
    expect(buildChatWebSocketUrl("CLI-0001", "  wss://demo.example:9443/base  ", {
      protocol: "http:",
      hostname: "ignored.example",
    })).toBe("wss://demo.example:9443/ws/chat?customerRef=CLI-0001");
  });

  it.each([
    ["http:", "ws://shop.local:3001/ws/chat?customerRef=CLI-0004"],
    ["https:", "wss://shop.local:3001/ws/chat?customerRef=CLI-0004"],
  ])("derives the browser fallback for %s", (protocol, expected) => {
    expect(buildChatWebSocketUrl("CLI-0004", "  ", { protocol, hostname: "shop.local" })).toBe(expected);
  });

  it("encodes customerRef with URL.searchParams", () => {
    const url = buildChatWebSocketUrl("CLIENT +?/ar", undefined, { protocol: "http:", hostname: "localhost" });
    expect(url).toBe("ws://localhost:3001/ws/chat?customerRef=CLIENT+%2B%3F%2Far");
    expect(new URL(url).searchParams.get("customerRef")).toBe("CLIENT +?/ar");
  });
});

describe("outgoing message", () => {
  it("builds only the exact trimmed client contract", () => {
    const message = buildOutgoingMessage("  Salam  ");
    expect(message).toEqual({ type: "message", content: "Salam" });
    expect(Object.keys(message ?? {}).sort()).toEqual(["content", "type"]);
    expect(JSON.stringify(message)).not.toMatch(/threadId|conversationId|customerId|cart|intent|language|order|promotion|delivery|guardrail/i);
  });

  it("rejects empty and over-limit content", () => {
    expect(buildOutgoingMessage("   ")).toBeNull();
    expect(buildOutgoingMessage("x".repeat(4_001))).toBeNull();
  });
});

describe("strict server-frame parsing", () => {
  it("parses a valid agent.message", () => {
    expect(parseServerFrame('{"type":"agent.message","content":"Marhba!"}')).toEqual({
      type: "agent.message",
      content: "Marhba!",
    });
  });

  it.each([
    "invalid_payload",
    "customer_not_found",
    "busy",
    "graph_error",
    "no_assistant_response",
    "session_error",
  ])("parses agent.error code %s", (code) => {
    expect(parseServerFrame(JSON.stringify({ type: "agent.error", code, message: "ignored raw copy" }))).toEqual({
      type: "agent.error",
      code,
      message: "ignored raw copy",
    });
  });

  it.each([
    { type: "agent.status", status: "loading_context" },
    { type: "agent.status", status: "planning" },
    { type: "agent.status", status: "escalating_to_human" },
    { type: "agent.status", status: "saving_conversation" },
    { type: "agent.tool", tool: "searchProducts", status: "started" },
    { type: "agent.tool", tool: "getAvailability", status: "completed", outcome: "positive" },
    { type: "agent.tool", tool: "findAlternatives", status: "completed", outcome: "negative" },
    { type: "agent.tool", tool: "getApplicablePromotion", status: "failed" },
    { type: "agent.tool", tool: "getDeliveryOptions", status: "started" },
    { type: "agent.tool", tool: "createCart", status: "started" },
    { type: "agent.tool", tool: "addCartItem", status: "started" },
    { type: "agent.tool", tool: "createOrder", status: "started" },
    { type: "agent.guardrail", status: "allowed", categories: ["ambiguous_product"] },
    { type: "agent.guardrail", status: "blocked", categories: ["stock_unverified"] },
    { type: "agent.guardrail", status: "clarification_required", categories: ["promotion_unverified"] },
    { type: "agent.guardrail", status: "escalation_required", categories: ["delivery_unverified"] },
    {
      type: "agent.guardrail",
      status: "not_applicable",
      categories: ["unsupported_restock", "automation_limit", "unverifiable_result"],
    },
  ])("recognizes TASK-030 activity frame %#", (frame) => {
    expect(parseServerFrame(JSON.stringify(frame))).toEqual(frame);
  });

  it("rejects malformed JSON, unknown event types, and dangerous extra fields", () => {
    expect(parseServerFrame("not-json")).toBeNull();
    expect(parseServerFrame('{"type":"agent.trace","state":{}}')).toBeNull();
    expect(parseServerFrame(JSON.stringify({
      type: "agent.message",
      content: "safe",
      conversationId: "private",
    }))).toBeNull();
    expect(parseServerFrame(JSON.stringify({
      type: "agent.tool",
      tool: "searchProducts",
      status: "completed",
      outcome: "positive",
      result: { private: true },
    }))).toBeNull();
    expect(parseServerFrame(JSON.stringify({
      type: "agent.guardrail",
      status: "blocked",
      categories: ["raw_internal_reason"],
    }))).toBeNull();
  });
});

describe("safe frontend error copy", () => {
  it.each([
    "invalid_payload",
    "customer_not_found",
    "busy",
    "graph_error",
    "no_assistant_response",
    "session_error",
  ])("maps %s to fixed French copy", (code) => {
    const message = getSafeErrorMessage(code);
    expect(message.length).toBeGreaterThan(10);
    expect(message).not.toContain(code);
  });

  it("uses generic copy for unknown codes and never needs raw server content", () => {
    const rawSecret = "database stack and private server details";
    expect(getSafeErrorMessage("unknown_code")).toBe(UNKNOWN_SERVER_ERROR_MESSAGE);
    expect(getSafeErrorMessage("graph_error")).not.toContain(rawSecret);
  });
});

describe("TASK-032 activity labels", () => {
  it.each([
    ["loading_context", "Chargement du contexte client"],
    ["planning", "Planification de la prochaine action"],
    ["escalating_to_human", "Escalade vers un conseiller humain"],
    ["saving_conversation", "Enregistrement de la conversation"],
  ] as const)("maps status %s", (status, label) => {
    expect(getActivityStatusLabel(status)).toBe(label);
  });

  it.each([
    ["searchProducts", "Recherche dans le catalogue"],
    ["getAvailability", "Vérification du stock"],
    ["findAlternatives", "Recherche d’alternatives"],
    ["getApplicablePromotion", "Vérification des promotions"],
    ["getDeliveryOptions", "Calcul des options de livraison"],
    ["createCart", "Création du panier"],
    ["addCartItem", "Ajout au panier"],
    ["createOrder", "Création de la commande"],
  ] as const)("maps tool %s", (tool, label) => {
    expect(getToolLabel(tool)).toBe(label);
  });

  it.each([
    ["running", "En cours"],
    ["positive", "Terminé — résultat positif"],
    ["negative", "Terminé — résultat négatif"],
    ["failed", "Erreur technique"],
  ] as const)("maps tool lifecycle state %s", (state, label) => {
    expect(getActivityStateLabel(state)).toBe(label);
  });

  it.each([
    ["allowed", "Contrôle autorisé"],
    ["blocked", "Action bloquée"],
    ["clarification_required", "Clarification nécessaire"],
    ["escalation_required", "Intervention humaine requise"],
    ["not_applicable", "Aucun contrôle applicable"],
  ] as const)("maps guardrail status %s", (status, label) => {
    expect(getGuardrailStatusLabel(status)).toBe(label);
  });

  it.each([
    ["ambiguous_product", "Produit ambigu"],
    ["stock_unverified", "Stock non vérifié"],
    ["promotion_unverified", "Promotion non vérifiée"],
    ["delivery_unverified", "Livraison non vérifiée"],
    ["unsupported_restock", "Réassort non vérifiable"],
    ["automation_limit", "Limite d’automatisation atteinte"],
    ["unverifiable_result", "Résultat non vérifiable"],
  ] as const)("maps guardrail category %s", (category, label) => {
    expect(getGuardrailCategoryLabel(category)).toBe(label);
  });
});

describe("TASK-032 activity projection", () => {
  it("projects each real status as a separate ordered item", () => {
    const first = applyActivityFrame([], { type: "agent.status", status: "planning" }, 1, 1);
    const second = applyActivityFrame(first, { type: "agent.status", status: "planning" }, 1, 2);

    expect(second).toEqual([
      { id: 1, turnId: 1, kind: "status", label: "Planification de la prochaine action", state: "info" },
      { id: 2, turnId: 1, kind: "status", label: "Planification de la prochaine action", state: "info" },
    ]);
  });

  it("projects a guardrail with only mapped public details", () => {
    expect(applyActivityFrame([], {
      type: "agent.guardrail",
      status: "clarification_required",
      categories: ["ambiguous_product", "stock_unverified"],
    }, 3, 7)).toEqual([{
      id: 7,
      turnId: 3,
      kind: "guardrail",
      label: "Clarification nécessaire",
      state: "clarification",
      details: ["Produit ambigu", "Stock non vérifié"],
    }]);
  });

  it.each([
    ["allowed", "allowed"],
    ["blocked", "blocked"],
    ["clarification_required", "clarification"],
    ["escalation_required", "escalation"],
    ["not_applicable", "neutral"],
  ] as const)("projects guardrail status %s to UI state %s", (status, state) => {
    const [item] = applyActivityFrame([], {
      type: "agent.guardrail",
      status,
      categories: [],
    }, 1, 1);

    expect(item?.state).toBe(state);
    expect(item?.label).toBe(getGuardrailStatusLabel(status));
  });

  it("creates a running item from a real tool start", () => {
    expect(applyActivityFrame([], {
      type: "agent.tool",
      tool: "searchProducts",
      status: "started",
    }, 1, 1)).toEqual([{
      id: 1,
      turnId: 1,
      kind: "tool",
      label: "Recherche dans le catalogue",
      state: "running",
      toolKey: "searchProducts",
    }]);
  });

  it.each([
    [{ type: "agent.tool", tool: "searchProducts", status: "completed", outcome: "positive" }, "positive"],
    [{ type: "agent.tool", tool: "searchProducts", status: "completed", outcome: "negative" }, "negative"],
    [{ type: "agent.tool", tool: "searchProducts", status: "failed" }, "failed"],
  ] as const)("updates a matching running tool to %s", (terminalFrame, state) => {
    const started = applyActivityFrame([], {
      type: "agent.tool",
      tool: "searchProducts",
      status: "started",
    }, 2, 10);

    const completed = applyActivityFrame(started, terminalFrame, 2, 11);

    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ id: 10, turnId: 2, state });
  });

  it("keeps a negative outcome distinct from a technical failure", () => {
    const negative = applyActivityFrame([], {
      type: "agent.tool",
      tool: "getAvailability",
      status: "completed",
      outcome: "negative",
    }, 1, 1);
    const failed = applyActivityFrame([], {
      type: "agent.tool",
      tool: "getAvailability",
      status: "failed",
    }, 1, 2);

    expect(negative[0]?.state).toBe("negative");
    expect(failed[0]?.state).toBe("failed");
  });

  it("matches the latest running occurrence of the same tool in the same turn", () => {
    const earlierTurn = applyActivityFrame([], {
      type: "agent.tool", tool: "searchProducts", status: "started",
    }, 1, 1);
    const currentTurn = applyActivityFrame(earlierTurn, {
      type: "agent.tool", tool: "searchProducts", status: "started",
    }, 2, 2);
    const withOtherTool = applyActivityFrame(currentTurn, {
      type: "agent.tool", tool: "getAvailability", status: "started",
    }, 2, 3);

    const completed = applyActivityFrame(withOtherTool, {
      type: "agent.tool", tool: "searchProducts", status: "completed", outcome: "positive",
    }, 2, 4);

    expect(completed.map((item) => [item.id, item.turnId, item.state])).toEqual([
      [1, 1, "running"],
      [2, 2, "positive"],
      [3, 2, "running"],
    ]);
  });

  it("appends a terminal tool event when no matching start exists", () => {
    expect(applyActivityFrame([], {
      type: "agent.tool",
      tool: "createOrder",
      status: "completed",
      outcome: "positive",
    }, 4, 9)).toEqual([{
      id: 9,
      turnId: 4,
      kind: "tool",
      label: "Création de la commande",
      state: "positive",
      toolKey: "createOrder",
    }]);
  });

  it("preserves arrival order and local turn IDs across different tools", () => {
    const first = applyActivityFrame([], {
      type: "agent.tool", tool: "searchProducts", status: "started",
    }, 4, 20);
    const second = applyActivityFrame(first, {
      type: "agent.tool", tool: "getAvailability", status: "started",
    }, 5, 21);

    expect(second.map(({ id, turnId, label }) => ({ id, turnId, label }))).toEqual([
      { id: 20, turnId: 4, label: "Recherche dans le catalogue" },
      { id: 21, turnId: 5, label: "Vérification du stock" },
    ]);
  });

  it("does not project agent.message or agent.error into activity", () => {
    const existing = applyActivityFrame([], { type: "agent.status", status: "loading_context" }, 1, 1);

    expect(applyActivityFrame(existing, { type: "agent.message", content: "Bonjour" }, 1, 2)).toEqual(existing);
    expect(applyActivityFrame(existing, {
      type: "agent.error", code: "graph_error", message: "private raw error",
    }, 1, 3)).toEqual(existing);
  });

  it("retains no raw event or private backend fields in projected items", () => {
    const activity = applyActivityFrame([], {
      type: "agent.guardrail",
      status: "blocked",
      categories: ["delivery_unverified"],
    }, 8, 12);
    const serialized = JSON.stringify(activity);

    expect(Object.keys(activity[0] ?? {}).sort()).toEqual(["details", "id", "kind", "label", "state", "turnId"]);
    expect(serialized).not.toMatch(/activePlan|executedSteps|lastResult|lastError|args|result|customerId|conversationId|threadId|prompt|reasoning|sql|stack|secret/i);
  });
});
