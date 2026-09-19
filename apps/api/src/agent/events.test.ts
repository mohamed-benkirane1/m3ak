import { afterEach, describe, expect, it, vi } from "vitest";
import { postgresPool } from "../infrastructure/postgres";
import {
  AgentGuardrailEventSchema,
  AgentStatusEventSchema,
  AgentStatusSchema,
  AgentToolEventSchema,
  createGuardrailEvent,
  emitAgentActivity,
  persistAgentEvents,
  PUBLIC_TOOL_BY_ACTION,
  PublicAgentEventSchema,
  toDurableAgentEventRecords,
  toPublicAgentEvent,
  type SanitizedAgentActivity,
} from "./events";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("public event schemas", () => {
  it("allows exactly the four contracted statuses and rejects arbitrary fields", () => {
    expect(AgentStatusSchema.options).toEqual([
      "loading_context",
      "planning",
      "escalating_to_human",
      "saving_conversation",
    ]);
    for (const status of AgentStatusSchema.options) {
      expect(AgentStatusEventSchema.parse({ type: "agent.status", status })).toEqual({ type: "agent.status", status });
    }
    expect(() => AgentStatusEventSchema.parse({ type: "agent.status", status: "thinking" })).toThrow();
    expect(() => AgentStatusEventSchema.parse({ type: "agent.status", status: "planning", state: {} })).toThrow();
  });

  it("maps all eight executable actions to the exact public tool allowlist", () => {
    expect(PUBLIC_TOOL_BY_ACTION).toEqual({
      SEARCH_PRODUCTS: "searchProducts",
      CHECK_STOCK: "getAvailability",
      FIND_ALTERNATIVES: "findAlternatives",
      CHECK_PROMOTION: "getApplicablePromotion",
      CHECK_DELIVERY: "getDeliveryOptions",
      CREATE_CART: "createCart",
      ADD_TO_CART: "addCartItem",
      CREATE_ORDER: "createOrder",
    });
    expect(PUBLIC_TOOL_BY_ACTION).not.toHaveProperty("ESCALATE");
  });

  it.each([
    { type: "agent.tool", tool: "searchProducts", status: "started" },
    { type: "agent.tool", tool: "getAvailability", status: "completed", outcome: "positive" },
    { type: "agent.tool", tool: "findAlternatives", status: "completed", outcome: "negative" },
    { type: "agent.tool", tool: "createOrder", status: "failed" },
  ])("accepts strict tool lifecycle event %#", (event) => {
    expect(AgentToolEventSchema.parse(event)).toEqual(event);
    expect(() => AgentToolEventSchema.parse({ ...event, result: { secret: true } })).toThrow();
    expect(() => AgentToolEventSchema.parse({ ...event, args: ["REF-001"] })).toThrow();
  });

  it("rejects unknown public event types and arbitrary guardrail fields", () => {
    expect(() => PublicAgentEventSchema.parse({ type: "agent.trace", state: {} })).toThrow();
    expect(() => AgentGuardrailEventSchema.parse({
      type: "agent.guardrail", status: "allowed", categories: [], reasons: ["raw"],
    })).toThrow();
  });
});

describe("guardrail sanitization", () => {
  it.each([
    [{ authorized: true, clarificationNeeded: false, humanInterventionNeeded: false }, "allowed"],
    [{ authorized: false, clarificationNeeded: false, humanInterventionNeeded: false }, "blocked"],
    [{ authorized: true, clarificationNeeded: true, humanInterventionNeeded: false }, "clarification_required"],
    [{ authorized: true, clarificationNeeded: true, humanInterventionNeeded: true }, "escalation_required"],
    [{ authorized: null, clarificationNeeded: false, humanInterventionNeeded: false }, "not_applicable"],
  ] as const)("maps deterministic precedence %#", (decision, status) => {
    expect(createGuardrailEvent({ ...decision, reasons: [] })).toEqual({
      type: "agent.guardrail",
      status,
      categories: [],
    });
  });

  it("maps all seven known reasons and omits unknown internal reasons", () => {
    const event = createGuardrailEvent({
      authorized: false,
      clarificationNeeded: false,
      humanInterventionNeeded: false,
      reasons: [
        "ambiguous_product_reference",
        "missing_stock_evidence",
        "missing_promotion_evidence",
        "missing_delivery_evidence",
        "unsupported_restock_claim",
        "agent_step_limit_reached",
        "unverifiable_observation",
        "raw-private-policy-text",
      ],
    });

    expect(event.categories).toEqual([
      "ambiguous_product",
      "stock_unverified",
      "promotion_unverified",
      "delivery_unverified",
      "unsupported_restock",
      "automation_limit",
      "unverifiable_result",
    ]);
    expect(JSON.stringify(event)).not.toContain("raw-private-policy-text");
  });
});

describe("activity delivery and durable projection", () => {
  it("isolates a throwing synchronous sink from graph business code", () => {
    expect(() => emitAgentActivity(() => { throw new Error("delivery failed"); }, {
      kind: "public",
      event: { type: "agent.status", status: "planning" },
    })).not.toThrow();
  });

  it("projects public events and keeps escalation_created durable-only", () => {
    const publicActivity: SanitizedAgentActivity = {
      kind: "public",
      event: { type: "agent.status", status: "loading_context" },
    };
    expect(toPublicAgentEvent(publicActivity)).toEqual(publicActivity.event);
    expect(toPublicAgentEvent({ kind: "escalation_created" })).toBeNull();
  });

  it("projects status, tool, guardrail, escalation, and positive order audit rows", () => {
    expect(toDurableAgentEventRecords({
      kind: "public", event: { type: "agent.status", status: "planning" },
    })).toEqual([{ eventType: "node_started", payload: { stage: "planning" } }]);
    expect(toDurableAgentEventRecords({
      kind: "public", event: { type: "agent.tool", tool: "searchProducts", status: "started" },
    })).toEqual([{ eventType: "tool_called", payload: { tool: "searchProducts" } }]);
    expect(toDurableAgentEventRecords({
      kind: "public", event: { type: "agent.tool", tool: "searchProducts", status: "completed", outcome: "negative" },
    })).toEqual([{ eventType: "tool_succeeded", payload: { tool: "searchProducts", outcome: "negative" } }]);
    expect(toDurableAgentEventRecords({
      kind: "public", event: { type: "agent.tool", tool: "searchProducts", status: "failed" },
    })).toEqual([{ eventType: "tool_failed", payload: { tool: "searchProducts" } }]);
    expect(toDurableAgentEventRecords({
      kind: "public", event: { type: "agent.guardrail", status: "blocked", categories: ["stock_unverified"] },
    })).toEqual([{ eventType: "guardrail_blocked", payload: { status: "blocked", categories: ["stock_unverified"] } }]);
    expect(toDurableAgentEventRecords({
      kind: "public", event: { type: "agent.guardrail", status: "clarification_required", categories: ["ambiguous_product"] },
    })).toEqual([{ eventType: "clarification_requested", payload: { categories: ["ambiguous_product"] } }]);
    expect(toDurableAgentEventRecords({ kind: "escalation_created" })).toEqual([
      { eventType: "escalation_created", payload: {} },
    ]);
    expect(toDurableAgentEventRecords({
      kind: "public", event: { type: "agent.tool", tool: "createOrder", status: "completed", outcome: "positive" },
    })).toEqual([
      { eventType: "tool_succeeded", payload: { tool: "createOrder", outcome: "positive" } },
      { eventType: "order_created", payload: {} },
    ]);
  });

  it("allowed and not-applicable guardrails do not fabricate durable rows", () => {
    for (const status of ["allowed", "not_applicable"] as const) {
      expect(toDurableAgentEventRecords({
        kind: "public", event: { type: "agent.guardrail", status, categories: [] },
      })).toEqual([]);
    }
  });
});

describe("persistAgentEvents", () => {
  it("does nothing for an empty collection", async () => {
    const query = vi.spyOn(postgresPool, "query");
    await persistAgentEvents("11111111-1111-4111-8111-111111111111", []);
    expect(query).not.toHaveBeenCalled();
  });

  it("uses one parameterized bounded INSERT with NULL duration and sanitized JSON", async () => {
    const query = vi.spyOn(postgresPool, "query").mockResolvedValueOnce({ rows: [] });
    const records = [
      { eventType: "node_started" as const, payload: { stage: "planning" as const } },
      { eventType: "tool_called" as const, payload: { tool: "searchProducts" as const } },
      { eventType: "order_created" as const, payload: {} },
    ];

    await persistAgentEvents("11111111-1111-4111-8111-111111111111", records);

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("INSERT INTO agent_events (conversation_id, event_type, payload, duration_ms)");
    expect(sql.match(/NULL/g)).toHaveLength(3);
    expect(sql).not.toContain("planning");
    expect(sql).not.toContain("searchProducts");
    expect(values).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "node_started", JSON.stringify({ stage: "planning" }),
      "tool_called", JSON.stringify({ tool: "searchProducts" }),
      "order_created", JSON.stringify({}),
    ]);
  });

  it("rejects an over-cap batch before any database operation", async () => {
    const query = vi.spyOn(postgresPool, "query");
    const records = Array.from({ length: 129 }, () => ({
      eventType: "order_created" as const,
      payload: {},
    }));

    await expect(persistAgentEvents("11111111-1111-4111-8111-111111111111", records)).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
});

describe("privacy boundary", () => {
  it("serialized public and durable data contains no forbidden state keys", () => {
    const activities: SanitizedAgentActivity[] = [
      { kind: "public", event: { type: "agent.status", status: "loading_context" } },
      { kind: "public", event: { type: "agent.tool", tool: "getDeliveryOptions", status: "completed", outcome: "positive" } },
      { kind: "public", event: { type: "agent.guardrail", status: "escalation_required", categories: ["delivery_unverified"] } },
      { kind: "escalation_created" },
    ];
    const serialized = JSON.stringify({
      public: activities.map(toPublicAgentEvent),
      durable: activities.flatMap(toDurableAgentEventRecords),
    }).toLowerCase();
    for (const forbidden of [
      "activeplan", "executedsteps", "lastresult", "lasterror", "messages", "customermemory",
      "customerid", "conversationid", "threadid", "orderid", "prompt", "reasoning", "sql", "stack", "api key",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
