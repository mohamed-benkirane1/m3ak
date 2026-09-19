import { afterEach, describe, expect, it, vi } from "vitest";
import { postgresPool } from "../infrastructure/postgres";
import { createEscalation } from "./escalation";

const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
const ESCALATION_ID = "55555555-5555-4555-8555-555555555555";

interface FakeClient {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}

function makeFakeClient(): FakeClient {
  return { query: vi.fn(), release: vi.fn() };
}

function makeEscalationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ESCALATION_ID,
    conversation_id: CONVERSATION_ID,
    reason: "agent_step_limit_reached",
    context_summary: "intent=unknown; executedSteps=[]; guardrailReasons=[agent_step_limit_reached]; lastError=agent_step_limit_reached",
    status: "open",
    created_at: new Date("2026-09-19T12:00:00.000Z"),
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createEscalation — input validation (9, 10, 11)", () => {
  it("9: rejects a malformed conversation id before acquiring a client", async () => {
    const spy = vi.spyOn(postgresPool, "connect");
    await expect(createEscalation("not-a-uuid", "reason", "summary")).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });

  it("10: rejects a blank reason before acquiring a client", async () => {
    const spy = vi.spyOn(postgresPool, "connect");
    await expect(createEscalation(CONVERSATION_ID, "   ", "summary")).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });

  it("11: rejects a blank context summary before acquiring a client", async () => {
    const spy = vi.spyOn(postgresPool, "connect");
    await expect(createEscalation(CONVERSATION_ID, "reason", "   ")).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("createEscalation — successful creation (1, 2, 3, 6, 7, 8)", () => {
  it("1/2/3/6/7/8: begins a transaction, locks the conversation first, inserts with status open, maps through the domain schema with ISO createdAt", async () => {
    const client = makeFakeClient();
    vi.spyOn(postgresPool, "connect").mockResolvedValue(client as never);

    client.query.mockResolvedValueOnce({}); // BEGIN
    client.query.mockResolvedValueOnce({ rows: [{ id: CONVERSATION_ID }] }); // lock conversation
    client.query.mockResolvedValueOnce({ rows: [] }); // no existing open escalation
    client.query.mockResolvedValueOnce({ rows: [makeEscalationRow()] }); // INSERT ... RETURNING
    client.query.mockResolvedValueOnce({}); // COMMIT

    const result = await createEscalation(CONVERSATION_ID, "agent_step_limit_reached", makeEscalationRow().context_summary);

    expect(result).toEqual({
      created: true,
      replayed: false,
      escalation: {
        id: ESCALATION_ID,
        conversationId: CONVERSATION_ID,
        reason: "agent_step_limit_reached",
        contextSummary: makeEscalationRow().context_summary,
        status: "open",
        createdAt: "2026-09-19T12:00:00.000Z",
      },
    });

    // Exact call order: BEGIN, lock, existing-check, INSERT, COMMIT.
    expect(client.query.mock.calls[0]?.[0]).toBe("BEGIN");
    const lockSql = String(client.query.mock.calls[1]?.[0]);
    // Whitespace-tolerant, but requires a real `WHERE id = $1` clause — this
    // is the exact class of regression a bare .toContain("FOR UPDATE") +
    // .toContain("conversations") check would silently miss (e.g. a malformed
    // "WHEREid = $1" would still contain both substrings).
    expect(lockSql).toMatch(/WHERE\s+id\s*=\s*\$1\s+FOR\s+UPDATE/i);
    expect(lockSql).toContain("conversations");
    expect(client.query.mock.calls[2]?.[0]).toContain("escalations");
    expect(client.query.mock.calls[2]?.[0]).toContain("status = 'open'");
    expect(client.query.mock.calls[3]?.[0]).toContain("INSERT INTO escalations");
    expect(client.query.mock.calls[3]?.[1]).toEqual([CONVERSATION_ID, "agent_step_limit_reached", makeEscalationRow().context_summary]);
    expect(client.query.mock.calls[4]?.[0]).toBe("COMMIT");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("exact reason and context_summary are the ones actually passed", async () => {
    const client = makeFakeClient();
    vi.spyOn(postgresPool, "connect").mockResolvedValue(client as never);
    client.query.mockResolvedValueOnce({});
    client.query.mockResolvedValueOnce({ rows: [{ id: CONVERSATION_ID }] });
    client.query.mockResolvedValueOnce({ rows: [] });
    client.query.mockResolvedValueOnce({ rows: [makeEscalationRow({ reason: "unverifiable_observation", context_summary: "intent=product_search; executedSteps=[SEARCH_PRODUCTS]; guardrailReasons=[unverifiable_observation]; lastError=none" })] });
    client.query.mockResolvedValueOnce({});

    const result = await createEscalation(
      CONVERSATION_ID,
      "unverifiable_observation",
      "intent=product_search; executedSteps=[SEARCH_PRODUCTS]; guardrailReasons=[unverifiable_observation]; lastError=none",
    );

    expect(result.created).toBe(true);
    if (result.created) {
      expect(result.escalation.reason).toBe("unverifiable_observation");
      expect(result.escalation.contextSummary).toBe(
        "intent=product_search; executedSteps=[SEARCH_PRODUCTS]; guardrailReasons=[unverifiable_observation]; lastError=none",
      );
      expect(result.escalation.status).toBe("open");
      expect(result.escalation.conversationId).toBe(CONVERSATION_ID);
    }
  });
});

describe("createEscalation — conversation not found (4)", () => {
  it("4: rolls back, never queries/inserts escalations, returns the controlled result", async () => {
    const client = makeFakeClient();
    vi.spyOn(postgresPool, "connect").mockResolvedValue(client as never);
    client.query.mockResolvedValueOnce({}); // BEGIN
    client.query.mockResolvedValueOnce({ rows: [] }); // lock conversation -> not found
    client.query.mockResolvedValueOnce({}); // ROLLBACK

    const result = await createEscalation(CONVERSATION_ID, "reason", "summary");

    expect(result).toEqual({ created: false, reason: "conversation_not_found" });
    expect(client.query).toHaveBeenCalledTimes(3);
    expect(client.query.mock.calls[2]?.[0]).toBe("ROLLBACK");
    const escalationQueries = client.query.mock.calls.filter((call) => String(call[0]).toLowerCase().includes("escalations"));
    expect(escalationQueries).toHaveLength(0);
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});

describe("createEscalation — existing open escalation replay (5)", () => {
  it("5: does not INSERT, rolls back (read-only), returns replayed:true with the existing real ID", async () => {
    const client = makeFakeClient();
    vi.spyOn(postgresPool, "connect").mockResolvedValue(client as never);
    client.query.mockResolvedValueOnce({}); // BEGIN
    client.query.mockResolvedValueOnce({ rows: [{ id: CONVERSATION_ID }] }); // lock conversation
    client.query.mockResolvedValueOnce({ rows: [makeEscalationRow()] }); // existing open escalation found
    client.query.mockResolvedValueOnce({}); // ROLLBACK (nothing written)

    const result = await createEscalation(CONVERSATION_ID, "new_reason", "new_summary");

    expect(result).toEqual({
      created: true,
      replayed: true,
      escalation: {
        id: ESCALATION_ID,
        conversationId: CONVERSATION_ID,
        reason: "agent_step_limit_reached",
        contextSummary: makeEscalationRow().context_summary,
        status: "open",
        createdAt: "2026-09-19T12:00:00.000Z",
      },
    });
    const insertCalls = client.query.mock.calls.filter((call) => String(call[0]).includes("INSERT"));
    expect(insertCalls).toHaveLength(0);
    expect(client.query.mock.calls[3]?.[0]).toBe("ROLLBACK");
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});

describe("createEscalation — error propagation (12, 13)", () => {
  it("12: a DB failure propagates unchanged, not swallowed", async () => {
    const client = makeFakeClient();
    vi.spyOn(postgresPool, "connect").mockResolvedValue(client as never);
    client.query.mockResolvedValueOnce({}); // BEGIN
    client.query.mockRejectedValueOnce(new Error("connection reset by peer")); // lock conversation fails
    client.query.mockResolvedValueOnce({}); // best-effort ROLLBACK

    await expect(createEscalation(CONVERSATION_ID, "reason", "summary")).rejects.toThrow("connection reset by peer");
  });

  it("13: client is still released even when a query throws (rollback attempted, release always runs)", async () => {
    const client = makeFakeClient();
    vi.spyOn(postgresPool, "connect").mockResolvedValue(client as never);
    client.query.mockResolvedValueOnce({}); // BEGIN
    client.query.mockRejectedValueOnce(new Error("boom")); // lock conversation fails
    client.query.mockResolvedValueOnce({}); // best-effort ROLLBACK

    await expect(createEscalation(CONVERSATION_ID, "reason", "summary")).rejects.toThrow("boom");
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});

describe("createEscalation — no unrelated writes (14, 15)", () => {
  it("14/15: only touches conversations (read/lock) and escalations — never UPDATE conversations, never cart/order/customer/followup tables", async () => {
    const client = makeFakeClient();
    vi.spyOn(postgresPool, "connect").mockResolvedValue(client as never);
    client.query.mockResolvedValueOnce({});
    client.query.mockResolvedValueOnce({ rows: [{ id: CONVERSATION_ID }] });
    client.query.mockResolvedValueOnce({ rows: [] });
    client.query.mockResolvedValueOnce({ rows: [makeEscalationRow()] });
    client.query.mockResolvedValueOnce({});

    await createEscalation(CONVERSATION_ID, "reason", "summary");

    const allSql = client.query.mock.calls.map((call) => String(call[0]));
    expect(allSql.some((sql) => /update\s+conversations/i.test(sql))).toBe(false);
    expect(allSql.some((sql) => /\b(carts|cart_items|orders|order_items|customers|followups)\b/i.test(sql))).toBe(false);
  });
});
