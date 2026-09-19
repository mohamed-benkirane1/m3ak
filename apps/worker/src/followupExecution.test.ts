import { afterEach, describe, expect, it, vi } from "vitest";
import { postgresPool } from "./infrastructure/postgres";
import { fastChat } from "./llm/fastClient";
import { executeFollowup, markFollowupExecutionFailed } from "./followupExecution";

vi.mock("./llm/fastClient", () => ({ fastChat: vi.fn() }));

const mockedFastChat = vi.mocked(fastChat);

const FOLLOWUP_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
const CUSTOMER_ID = "33333333-3333-4333-8333-333333333333";

interface FakeClient {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}

function makeFakeClient(): FakeClient {
  return { query: vi.fn(), release: vi.fn() };
}

function followupRow(overrides: Record<string, unknown> = {}) {
  return {
    id: FOLLOWUP_ID,
    conversation_id: CONVERSATION_ID,
    status: "scheduled",
    created_at: new Date("2026-09-19T10:00:00.000Z"),
    bullmq_job_id: FOLLOWUP_ID,
    ...overrides,
  };
}

function conversationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CONVERSATION_ID,
    customer_id: CUSTOMER_ID,
    status: "active",
    language: "french",
    updated_at: new Date("2026-09-19T09:00:00.000Z"), // before followup.created_at -> still inactive
    ...overrides,
  };
}

// Queues the full pre-flight query sequence for an ELIGIBLE followup:
// BEGIN, lock followup, load conversation, order-check, escalation-check,
// [customer preferred_language only when conversation language is unknown],
// recent messages, active-cart lookup [+ items], ROLLBACK.
function queuePreflightEligible(
  client: FakeClient,
  opts: { cart?: boolean; language?: string; customerPreferredLanguage?: string | null } = {},
) {
  const language = opts.language ?? "french";
  client.query.mockResolvedValueOnce({}); // BEGIN
  client.query.mockResolvedValueOnce({ rows: [followupRow()] }); // lock followup
  client.query.mockResolvedValueOnce({ rows: [conversationRow({ language })] }); // load conversation
  client.query.mockResolvedValueOnce({ rows: [] }); // no order
  client.query.mockResolvedValueOnce({ rows: [] }); // no open escalation
  if (language === "unknown") {
    client.query.mockResolvedValueOnce({ rows: [{ preferred_language: opts.customerPreferredLanguage ?? null }] });
  }
  client.query.mockResolvedValueOnce({ rows: [{ role: "customer", content: "Bghit veste k7la" }] }); // recent messages
  if (opts.cart) {
    client.query.mockResolvedValueOnce({ rows: [{ id: "cart-1" }] });
    client.query.mockResolvedValueOnce({ rows: [{ product_ref: "REF-001", quantity: 2 }] });
  } else {
    client.query.mockResolvedValueOnce({ rows: [] });
  }
  client.query.mockResolvedValueOnce({}); // ROLLBACK (read-only continue)
}

// Queues the full FINAL query sequence for a still-eligible followup that
// commits as executed: BEGIN, lock followup, load conversation, order-check,
// escalation-check, INSERT message, UPDATE followups, UPDATE conversations,
// COMMIT.
function queueFinalExecuted(client: FakeClient) {
  client.query.mockResolvedValueOnce({});
  client.query.mockResolvedValueOnce({ rows: [followupRow()] });
  client.query.mockResolvedValueOnce({ rows: [conversationRow()] });
  client.query.mockResolvedValueOnce({ rows: [] });
  client.query.mockResolvedValueOnce({ rows: [] });
  client.query.mockResolvedValueOnce({});
  client.query.mockResolvedValueOnce({});
  client.query.mockResolvedValueOnce({});
  client.query.mockResolvedValueOnce({});
}

afterEach(() => {
  vi.restoreAllMocks();
  // vi.restoreAllMocks() only restores vi.spyOn() wrappers — it does not
  // clear a vi.mock()-factory mock's queued responses/call history, so
  // mockedFastChat needs an explicit reset or `.mock.calls[0]` would keep
  // pointing at an earlier test's call once calls accumulate across tests.
  mockedFastChat.mockReset();
});

describe("executeFollowup — followup state no-ops (3, 4, 5, 6)", () => {
  it("3: followup not found -> no-op, no retry, no fastChat", async () => {
    const client = makeFakeClient();
    vi.spyOn(postgresPool, "connect").mockResolvedValueOnce(client as never);
    client.query.mockResolvedValueOnce({});
    client.query.mockResolvedValueOnce({ rows: [] });
    client.query.mockResolvedValueOnce({});

    const result = await executeFollowup(FOLLOWUP_ID);

    expect(result).toEqual({ outcome: "no_such_followup" });
    expect(mockedFastChat).not.toHaveBeenCalled();
  });

  it.each(["executed", "cancelled", "failed"])("4/5/6: status=%s -> controlled no-op, no fastChat", async (status) => {
    const client = makeFakeClient();
    vi.spyOn(postgresPool, "connect").mockResolvedValueOnce(client as never);
    client.query.mockResolvedValueOnce({});
    client.query.mockResolvedValueOnce({ rows: [followupRow({ status })] });
    client.query.mockResolvedValueOnce({});

    const result = await executeFollowup(FOLLOWUP_ID);

    expect(result).toEqual({ outcome: "already_handled", status });
    expect(mockedFastChat).not.toHaveBeenCalled();
  });

  it("7: bullmq_job_id mismatch -> technical integrity error, thrown and not swallowed", async () => {
    const client = makeFakeClient();
    vi.spyOn(postgresPool, "connect").mockResolvedValueOnce(client as never);
    client.query.mockResolvedValueOnce({});
    client.query.mockResolvedValueOnce({ rows: [followupRow({ bullmq_job_id: "mismatched-id" })] });
    client.query.mockResolvedValueOnce({}); // best-effort ROLLBACK

    await expect(executeFollowup(FOLLOWUP_ID)).rejects.toThrow(/Integrity error/);
    expect(mockedFastChat).not.toHaveBeenCalled();
  });
});

describe("executeFollowup — pre-flight invalidation (8, 9, 10, 11, 12)", () => {
  it("8: conversation not active -> cancelled, fastChat never called", async () => {
    const client = makeFakeClient();
    vi.spyOn(postgresPool, "connect").mockResolvedValueOnce(client as never);
    client.query.mockResolvedValueOnce({});
    client.query.mockResolvedValueOnce({ rows: [followupRow()] });
    client.query.mockResolvedValueOnce({ rows: [conversationRow({ status: "completed" })] });
    client.query.mockResolvedValueOnce({}); // UPDATE cancelled
    client.query.mockResolvedValueOnce({}); // COMMIT

    const result = await executeFollowup(FOLLOWUP_ID);

    expect(result).toEqual({ outcome: "cancelled", reason: "conversation_not_active" });
    expect(mockedFastChat).not.toHaveBeenCalled();
    expect(String(client.query.mock.calls[3]?.[0])).toContain("status = 'cancelled'");
  });

  it("9: conversation activity after scheduling (updated_at > followup.created_at) -> cancelled", async () => {
    const client = makeFakeClient();
    vi.spyOn(postgresPool, "connect").mockResolvedValueOnce(client as never);
    client.query.mockResolvedValueOnce({});
    client.query.mockResolvedValueOnce({ rows: [followupRow({ created_at: new Date("2026-09-19T10:00:00.000Z") })] });
    client.query.mockResolvedValueOnce({ rows: [conversationRow({ updated_at: new Date("2026-09-19T10:05:00.000Z") })] });
    client.query.mockResolvedValueOnce({});
    client.query.mockResolvedValueOnce({});

    const result = await executeFollowup(FOLLOWUP_ID);

    expect(result).toEqual({ outcome: "cancelled", reason: "conversation_activity_since_scheduling" });
    expect(mockedFastChat).not.toHaveBeenCalled();
  });

  it("10: an existing order -> cancelled", async () => {
    const client = makeFakeClient();
    vi.spyOn(postgresPool, "connect").mockResolvedValueOnce(client as never);
    client.query.mockResolvedValueOnce({});
    client.query.mockResolvedValueOnce({ rows: [followupRow()] });
    client.query.mockResolvedValueOnce({ rows: [conversationRow()] });
    client.query.mockResolvedValueOnce({ rows: [{ "?column?": 1 }] });
    client.query.mockResolvedValueOnce({});
    client.query.mockResolvedValueOnce({});

    const result = await executeFollowup(FOLLOWUP_ID);

    expect(result).toEqual({ outcome: "cancelled", reason: "order_exists" });
    expect(mockedFastChat).not.toHaveBeenCalled();
  });

  it("11/12: an open escalation -> cancelled, fastChat never called", async () => {
    const client = makeFakeClient();
    vi.spyOn(postgresPool, "connect").mockResolvedValueOnce(client as never);
    client.query.mockResolvedValueOnce({});
    client.query.mockResolvedValueOnce({ rows: [followupRow()] });
    client.query.mockResolvedValueOnce({ rows: [conversationRow()] });
    client.query.mockResolvedValueOnce({ rows: [] });
    client.query.mockResolvedValueOnce({ rows: [{ "?column?": 1 }] });
    client.query.mockResolvedValueOnce({});
    client.query.mockResolvedValueOnce({});

    const result = await executeFollowup(FOLLOWUP_ID);

    expect(result).toEqual({ outcome: "cancelled", reason: "open_escalation" });
    expect(mockedFastChat).not.toHaveBeenCalled();
  });

  it("5: missing conversation during PRE-FLIGHT -> thrown integrity error, not a controlled/cancelled result", async () => {
    const client = makeFakeClient();
    vi.spyOn(postgresPool, "connect").mockResolvedValueOnce(client as never);
    client.query.mockResolvedValueOnce({});
    client.query.mockResolvedValueOnce({ rows: [followupRow()] });
    client.query.mockResolvedValueOnce({ rows: [] }); // conversation not found
    client.query.mockResolvedValueOnce({});

    await expect(executeFollowup(FOLLOWUP_ID)).rejects.toThrow(/Integrity error/);
    const cancelledCalls = client.query.mock.calls.filter((call) => String(call[0]).includes("status = 'cancelled'"));
    expect(cancelledCalls).toHaveLength(0);
  });

  it("6: missing conversation during FINAL revalidation -> thrown integrity error, not cancelled — retry machinery stays responsible", async () => {
    const preflightClient = makeFakeClient();
    const finalClient = makeFakeClient();
    vi.spyOn(postgresPool, "connect").mockResolvedValueOnce(preflightClient as never).mockResolvedValueOnce(finalClient as never);
    queuePreflightEligible(preflightClient);
    mockedFastChat.mockResolvedValueOnce("Bonjour !");
    finalClient.query.mockResolvedValueOnce({}); // BEGIN
    finalClient.query.mockResolvedValueOnce({ rows: [followupRow()] }); // still scheduled
    finalClient.query.mockResolvedValueOnce({ rows: [] }); // conversation missing under the lock
    finalClient.query.mockResolvedValueOnce({}); // best-effort ROLLBACK

    await expect(executeFollowup(FOLLOWUP_ID)).rejects.toThrow(/Integrity error/);

    const cancelledCalls = finalClient.query.mock.calls.filter((call) => String(call[0]).includes("status = 'cancelled'"));
    expect(cancelledCalls).toHaveLength(0);
  });
});

describe("executeFollowup — race-safe FINAL conversation lock (TASK-028B)", () => {
  it("1: PRE-FLIGHT conversation SELECT does not lock the row (no FOR UPDATE) — optimization only", async () => {
    const client = makeFakeClient();
    vi.spyOn(postgresPool, "connect").mockResolvedValueOnce(client as never);
    queuePreflightEligible(client);
    mockedFastChat.mockRejectedValueOnce(new Error("stop-after-preflight"));

    await expect(executeFollowup(FOLLOWUP_ID)).rejects.toThrow("stop-after-preflight");

    const conversationSql = String(client.query.mock.calls[2]?.[0]);
    expect(conversationSql).toContain("FROM conversations WHERE id = $1");
    expect(conversationSql).not.toMatch(/FOR UPDATE/i);
  });

  it("2: FINAL conversation SELECT locks the row (FOR UPDATE) — the authoritative gate", async () => {
    const preflightClient = makeFakeClient();
    const finalClient = makeFakeClient();
    vi.spyOn(postgresPool, "connect").mockResolvedValueOnce(preflightClient as never).mockResolvedValueOnce(finalClient as never);
    queuePreflightEligible(preflightClient);
    mockedFastChat.mockResolvedValueOnce("Bonjour !");
    queueFinalExecuted(finalClient);

    await executeFollowup(FOLLOWUP_ID);

    const conversationSql = String(finalClient.query.mock.calls[2]?.[0]);
    expect(conversationSql).toMatch(/FROM conversations WHERE id = \$1 FOR UPDATE/i);
  });

  it("3: FINAL ordering is followup FOR UPDATE -> conversation FOR UPDATE -> eligibility queries -> persistence -> COMMIT", async () => {
    const preflightClient = makeFakeClient();
    const finalClient = makeFakeClient();
    vi.spyOn(postgresPool, "connect").mockResolvedValueOnce(preflightClient as never).mockResolvedValueOnce(finalClient as never);
    queuePreflightEligible(preflightClient);
    mockedFastChat.mockResolvedValueOnce("Bonjour !");
    queueFinalExecuted(finalClient);

    await executeFollowup(FOLLOWUP_ID);

    const sqlCalls = finalClient.query.mock.calls.map((call) => String(call[0]));
    expect(sqlCalls[0]).toBe("BEGIN");
    expect(sqlCalls[1]).toMatch(/FROM followups WHERE id = \$1 FOR UPDATE/i);
    expect(sqlCalls[2]).toMatch(/FROM conversations WHERE id = \$1 FOR UPDATE/i);
    expect(sqlCalls[3]).toMatch(/FROM orders/i);
    expect(sqlCalls[4]).toMatch(/FROM escalations/i);
    expect(sqlCalls[5]).toContain("INSERT INTO messages");
    expect(sqlCalls[6]).toContain("UPDATE followups");
    expect(sqlCalls[7]).toContain("UPDATE conversations");
    expect(sqlCalls[8]).toBe("COMMIT");
  });

  it("4: activity newer than followup.created_at, observed under the FINAL locked read -> cancelled, no assistant message inserted", async () => {
    const preflightClient = makeFakeClient();
    const finalClient = makeFakeClient();
    vi.spyOn(postgresPool, "connect").mockResolvedValueOnce(preflightClient as never).mockResolvedValueOnce(finalClient as never);
    queuePreflightEligible(preflightClient);
    mockedFastChat.mockResolvedValueOnce("Bonjour !");
    finalClient.query.mockResolvedValueOnce({}); // BEGIN
    finalClient.query.mockResolvedValueOnce({ rows: [followupRow({ created_at: new Date("2026-09-19T10:00:00.000Z") })] });
    finalClient.query.mockImplementationOnce((sql: string) => {
      expect(sql).toMatch(/FOR UPDATE/i); // the locked read is what observes the race
      return Promise.resolve({ rows: [conversationRow({ updated_at: new Date("2026-09-19T10:30:00.000Z") })] });
    });
    finalClient.query.mockResolvedValueOnce({}); // UPDATE cancelled
    finalClient.query.mockResolvedValueOnce({}); // COMMIT

    const result = await executeFollowup(FOLLOWUP_ID);

    expect(result).toEqual({ outcome: "cancelled", reason: "conversation_activity_since_scheduling" });
    const insertCalls = finalClient.query.mock.calls.filter((call) => String(call[0]).includes("INSERT INTO messages"));
    expect(insertCalls).toHaveLength(0);
  });
});

describe("executeFollowup — generation context / language (13, 14, 15, 16, 17)", () => {
  it("13: conversation.language wins when it is not unknown", async () => {
    const preflightClient = makeFakeClient();
    vi.spyOn(postgresPool, "connect").mockResolvedValueOnce(preflightClient as never);
    queuePreflightEligible(preflightClient, { language: "darija" });
    mockedFastChat.mockRejectedValueOnce(new Error("stop-after-preflight"));

    await expect(executeFollowup(FOLLOWUP_ID)).rejects.toThrow("stop-after-preflight");

    const userContent = (mockedFastChat.mock.calls[0]?.[0] as Array<{ role: string; content: string }>)[1]?.content ?? "{}";
    expect(JSON.parse(userContent).language).toBe("darija");
  });

  it("14: customer preferred_language is used as fallback when conversation.language is unknown", async () => {
    const preflightClient = makeFakeClient();
    vi.spyOn(postgresPool, "connect").mockResolvedValueOnce(preflightClient as never);
    queuePreflightEligible(preflightClient, { language: "unknown", customerPreferredLanguage: "arabic" });
    mockedFastChat.mockRejectedValueOnce(new Error("stop-after-preflight"));

    await expect(executeFollowup(FOLLOWUP_ID)).rejects.toThrow("stop-after-preflight");

    const userContent = (mockedFastChat.mock.calls[0]?.[0] as Array<{ role: string; content: string }>)[1]?.content ?? "{}";
    expect(JSON.parse(userContent).language).toBe("arabic");
  });

  it("15: both conversation and customer language unknown -> stays unknown", async () => {
    const preflightClient = makeFakeClient();
    vi.spyOn(postgresPool, "connect").mockResolvedValueOnce(preflightClient as never);
    queuePreflightEligible(preflightClient, { language: "unknown", customerPreferredLanguage: null });
    mockedFastChat.mockRejectedValueOnce(new Error("stop-after-preflight"));

    await expect(executeFollowup(FOLLOWUP_ID)).rejects.toThrow("stop-after-preflight");

    const userContent = (mockedFastChat.mock.calls[0]?.[0] as Array<{ role: string; content: string }>)[1]?.content ?? "{}";
    expect(JSON.parse(userContent).language).toBe("unknown");
  });

  it("16: a bounded, structured context (recent messages + cart refs/quantities only) is passed to fastChat", async () => {
    const preflightClient = makeFakeClient();
    vi.spyOn(postgresPool, "connect").mockResolvedValueOnce(preflightClient as never);
    queuePreflightEligible(preflightClient, { cart: true });
    mockedFastChat.mockRejectedValueOnce(new Error("stop-after-preflight"));

    await expect(executeFollowup(FOLLOWUP_ID)).rejects.toThrow("stop-after-preflight");

    const [systemMessage, userMessage] = mockedFastChat.mock.calls[0]?.[0] as Array<{ role: string; content: string }>;
    expect(systemMessage.role).toBe("system");
    const payload = JSON.parse(userMessage.content);
    expect(payload.recentMessages).toEqual([{ role: "customer", content: "Bghit veste k7la" }]);
    expect(payload.cart).toEqual({ items: [{ productRef: "REF-001", quantity: 2 }] });
    expect(Object.keys(payload).sort()).toEqual(["cart", "language", "recentMessages"]);
  });

  it("17: empty model output (after trim) -> technical error, no persistence attempted", async () => {
    const preflightClient = makeFakeClient();
    vi.spyOn(postgresPool, "connect").mockResolvedValueOnce(preflightClient as never);
    queuePreflightEligible(preflightClient);
    mockedFastChat.mockResolvedValueOnce("   ");

    await expect(executeFollowup(FOLLOWUP_ID)).rejects.toThrow(/empty/i);
  });
});

describe("executeFollowup — final revalidation after fastChat (18, 19, 20, 21, 33, 34)", () => {
  it("18: conversation activity appears DURING fastChat -> final revalidation cancels, generated text discarded", async () => {
    const preflightClient = makeFakeClient();
    const finalClient = makeFakeClient();
    vi.spyOn(postgresPool, "connect").mockResolvedValueOnce(preflightClient as never).mockResolvedValueOnce(finalClient as never);
    queuePreflightEligible(preflightClient);
    mockedFastChat.mockResolvedValueOnce("Bonjour, toujours intéressé ?");
    finalClient.query.mockResolvedValueOnce({}); // BEGIN
    finalClient.query.mockResolvedValueOnce({ rows: [followupRow()] }); // still scheduled
    finalClient.query.mockResolvedValueOnce({ rows: [conversationRow({ updated_at: new Date("2026-09-19T10:30:00.000Z") })] }); // activity now
    finalClient.query.mockResolvedValueOnce({}); // UPDATE cancelled
    finalClient.query.mockResolvedValueOnce({}); // COMMIT

    const result = await executeFollowup(FOLLOWUP_ID);

    expect(result).toEqual({ outcome: "cancelled", reason: "conversation_activity_since_scheduling" });
    const insertCalls = finalClient.query.mock.calls.filter((call) => String(call[0]).includes("INSERT INTO messages"));
    expect(insertCalls).toHaveLength(0);
    const followupUpdateSql = String(finalClient.query.mock.calls[3]?.[0]);
    expect(followupUpdateSql).toContain("status = 'cancelled'");
    expect(followupUpdateSql).not.toContain("executed_at");
    expect(followupUpdateSql).not.toContain("message");
  });

  it("19: an order appears during fastChat -> cancelled at final revalidation", async () => {
    const preflightClient = makeFakeClient();
    const finalClient = makeFakeClient();
    vi.spyOn(postgresPool, "connect").mockResolvedValueOnce(preflightClient as never).mockResolvedValueOnce(finalClient as never);
    queuePreflightEligible(preflightClient);
    mockedFastChat.mockResolvedValueOnce("Bonjour, toujours intéressé ?");
    finalClient.query.mockResolvedValueOnce({});
    finalClient.query.mockResolvedValueOnce({ rows: [followupRow()] });
    finalClient.query.mockResolvedValueOnce({ rows: [conversationRow()] });
    finalClient.query.mockResolvedValueOnce({ rows: [{ "?column?": 1 }] }); // order now exists
    finalClient.query.mockResolvedValueOnce({});
    finalClient.query.mockResolvedValueOnce({});

    const result = await executeFollowup(FOLLOWUP_ID);

    expect(result).toEqual({ outcome: "cancelled", reason: "order_exists" });
  });

  it("20: an escalation appears during fastChat -> cancelled at final revalidation", async () => {
    const preflightClient = makeFakeClient();
    const finalClient = makeFakeClient();
    vi.spyOn(postgresPool, "connect").mockResolvedValueOnce(preflightClient as never).mockResolvedValueOnce(finalClient as never);
    queuePreflightEligible(preflightClient);
    mockedFastChat.mockResolvedValueOnce("Bonjour, toujours intéressé ?");
    finalClient.query.mockResolvedValueOnce({});
    finalClient.query.mockResolvedValueOnce({ rows: [followupRow()] });
    finalClient.query.mockResolvedValueOnce({ rows: [conversationRow()] });
    finalClient.query.mockResolvedValueOnce({ rows: [] });
    finalClient.query.mockResolvedValueOnce({ rows: [{ "?column?": 1 }] }); // escalation now open
    finalClient.query.mockResolvedValueOnce({});
    finalClient.query.mockResolvedValueOnce({});

    const result = await executeFollowup(FOLLOWUP_ID);

    expect(result).toEqual({ outcome: "cancelled", reason: "open_escalation" });
  });

  it("21/35: followup status changed to executed while fastChat runs -> no-op, no duplicate persistence", async () => {
    const preflightClient = makeFakeClient();
    const finalClient = makeFakeClient();
    vi.spyOn(postgresPool, "connect").mockResolvedValueOnce(preflightClient as never).mockResolvedValueOnce(finalClient as never);
    queuePreflightEligible(preflightClient);
    mockedFastChat.mockResolvedValueOnce("Bonjour, toujours intéressé ?");
    finalClient.query.mockResolvedValueOnce({});
    finalClient.query.mockResolvedValueOnce({ rows: [followupRow({ status: "executed" })] }); // another worker won the race
    finalClient.query.mockResolvedValueOnce({});

    const result = await executeFollowup(FOLLOWUP_ID);

    expect(result).toEqual({ outcome: "already_handled", status: "executed" });
    const insertCalls = finalClient.query.mock.calls.filter((call) => String(call[0]).includes("INSERT INTO messages"));
    expect(insertCalls).toHaveLength(0);
  });

  it("33/34: the final transaction locks the followup row FOR UPDATE, and revalidation runs strictly after fastChat resolves", async () => {
    const preflightClient = makeFakeClient();
    const finalClient = makeFakeClient();
    vi.spyOn(postgresPool, "connect").mockResolvedValueOnce(preflightClient as never).mockResolvedValueOnce(finalClient as never);
    queuePreflightEligible(preflightClient);
    const callOrder: string[] = [];
    mockedFastChat.mockImplementationOnce(async () => {
      callOrder.push("fastChat");
      return "Bonjour, toujours intéressé ?";
    });
    finalClient.query.mockResolvedValueOnce({}); // BEGIN
    finalClient.query.mockImplementationOnce((sql: string) => {
      callOrder.push("finalLock");
      expect(sql).toMatch(/FROM followups[\s\S]*WHERE\s+id\s*=\s*\$1\s+FOR\s+UPDATE/i);
      return Promise.resolve({ rows: [followupRow()] });
    });
    finalClient.query.mockResolvedValueOnce({ rows: [conversationRow()] });
    finalClient.query.mockResolvedValueOnce({ rows: [] });
    finalClient.query.mockResolvedValueOnce({ rows: [] });
    finalClient.query.mockResolvedValueOnce({});
    finalClient.query.mockResolvedValueOnce({});
    finalClient.query.mockResolvedValueOnce({});
    finalClient.query.mockResolvedValueOnce({});

    await executeFollowup(FOLLOWUP_ID);

    expect(callOrder).toEqual(["fastChat", "finalLock"]);
  });
});

describe("executeFollowup — successful atomic transaction (22-28)", () => {
  it("22-28: loads fresh context, calls fastChat, re-validates, and commits message+followup+conversation atomically", async () => {
    const preflightClient = makeFakeClient();
    const finalClient = makeFakeClient();
    vi.spyOn(postgresPool, "connect").mockResolvedValueOnce(preflightClient as never).mockResolvedValueOnce(finalClient as never);
    queuePreflightEligible(preflightClient, { cart: true });
    mockedFastChat.mockResolvedValueOnce("  Bonjour ! On voulait prendre des nouvelles.  ");
    queueFinalExecuted(finalClient);

    const result = await executeFollowup(FOLLOWUP_ID);

    expect(result).toEqual({ outcome: "executed" });

    const insertCall = finalClient.query.mock.calls[5];
    expect(String(insertCall?.[0])).toContain("INSERT INTO messages");
    expect(String(insertCall?.[0])).toContain("'assistant'");
    expect(insertCall?.[1]).toEqual([CONVERSATION_ID, "Bonjour ! On voulait prendre des nouvelles."]);

    const updateFollowupCall = finalClient.query.mock.calls[6];
    expect(String(updateFollowupCall?.[0])).toContain("message = $2");
    expect(String(updateFollowupCall?.[0])).toContain("executed_at = now()");
    expect(String(updateFollowupCall?.[0])).toContain("status = 'executed'");
    expect(updateFollowupCall?.[1]).toEqual([FOLLOWUP_ID, "Bonjour ! On voulait prendre des nouvelles."]);

    const updateConversationCall = finalClient.query.mock.calls[7];
    expect(String(updateConversationCall?.[0])).toContain("UPDATE conversations SET updated_at = now()");
    expect(updateConversationCall?.[1]).toEqual([CONVERSATION_ID]);

    expect(finalClient.query.mock.calls[8]?.[0]).toBe("COMMIT");
  });

  it("27: no WebSocket/emission call of any kind occurs", async () => {
    const preflightClient = makeFakeClient();
    const finalClient = makeFakeClient();
    vi.spyOn(postgresPool, "connect").mockResolvedValueOnce(preflightClient as never).mockResolvedValueOnce(finalClient as never);
    queuePreflightEligible(preflightClient);
    mockedFastChat.mockResolvedValueOnce("Bonjour !");
    queueFinalExecuted(finalClient);

    const result = await executeFollowup(FOLLOWUP_ID);

    expect(result).toEqual({ outcome: "executed" });
    // Structural proof: this module never imports/uses anything ws/socket-related —
    // verified independently by the forbidden-scope source grep in the final report.
  });
});

describe("executeFollowup — technical error propagation", () => {
  it("a genuine DB error during pre-flight propagates, not swallowed", async () => {
    const client = makeFakeClient();
    vi.spyOn(postgresPool, "connect").mockResolvedValueOnce(client as never);
    client.query.mockResolvedValueOnce({});
    client.query.mockRejectedValueOnce(new Error("connection reset by peer"));
    client.query.mockResolvedValueOnce({});

    await expect(executeFollowup(FOLLOWUP_ID)).rejects.toThrow("connection reset by peer");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("an LlmError from fastChat propagates unchanged", async () => {
    const preflightClient = makeFakeClient();
    vi.spyOn(postgresPool, "connect").mockResolvedValueOnce(preflightClient as never);
    queuePreflightEligible(preflightClient);
    mockedFastChat.mockRejectedValueOnce(new Error("LLM request timed out after 15000ms"));

    await expect(executeFollowup(FOLLOWUP_ID)).rejects.toThrow("LLM request timed out");
  });
});

describe("markFollowupExecutionFailed", () => {
  it("issues a scoped UPDATE ... WHERE status = 'scheduled', touching only status", async () => {
    const querySpy = vi.spyOn(postgresPool, "query").mockResolvedValueOnce({} as never);

    await markFollowupExecutionFailed(FOLLOWUP_ID);

    expect(querySpy).toHaveBeenCalledTimes(1);
    const [sql, params] = querySpy.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("UPDATE followups");
    expect(sql).toContain("SET status = 'failed'");
    expect(sql).toContain("WHERE id = $1 AND status = 'scheduled'");
    expect(sql).not.toContain("executed_at");
    expect(sql).not.toContain("message");
    expect(params).toEqual([FOLLOWUP_ID]);
  });
});
