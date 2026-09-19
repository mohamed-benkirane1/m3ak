import { describe, expect, it } from "vitest";
import {
  DEMO_PERSONAS,
  UNKNOWN_SERVER_ERROR_MESSAGE,
  buildChatWebSocketUrl,
  buildOutgoingMessage,
  getSafeErrorMessage,
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
