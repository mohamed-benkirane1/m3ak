import { afterEach, describe, expect, it, vi } from "vitest";
import { postgresPool } from "../infrastructure/postgres";
import { createChatSession } from "./chatSession";

const CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createChatSession", () => {
  it("1: rejects invalid customerRef values before touching PostgreSQL", async () => {
    const query = vi.spyOn(postgresPool, "query");

    await expect(createChatSession("   ")).rejects.toThrow();
    await expect(createChatSession("x".repeat(129))).rejects.toThrow();

    expect(query).not.toHaveBeenCalled();
  });

  it("2: returns controlled customer_not_found and never inserts a conversation", async () => {
    const query = vi.spyOn(postgresPool, "query").mockResolvedValueOnce({ rows: [] });

    await expect(createChatSession("KENZA-404")).resolves.toEqual({
      created: false,
      reason: "customer_not_found",
    });

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain("FROM customers");
    expect(query.mock.calls[0]?.[1]).toEqual(["KENZA-404"]);
  });

  it("3/4/5/6/7/8/10: resolves external_ref, generates a UUID, and creates only the active unknown-language conversation", async () => {
    const query = vi.spyOn(postgresPool, "query");
    query.mockResolvedValueOnce({ rows: [{ id: CUSTOMER_ID }] });
    query.mockResolvedValueOnce({ rows: [{ id: CONVERSATION_ID }] });

    const result = await createChatSession("  KENZA-001  ");

    expect(result.created).toBe(true);
    if (!result.created) throw new Error("expected a created session");
    expect(result).toMatchObject({ conversationId: CONVERSATION_ID, customerId: CUSTOMER_ID });
    expect(result.threadId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[0]).toContain("external_ref = $1");
    expect(query.mock.calls[0]?.[1]).toEqual(["KENZA-001"]);
    const insertSql = String(query.mock.calls[1]?.[0]);
    expect(insertSql).toContain("INSERT INTO conversations");
    expect(insertSql).toContain("customer_id, status, language, langgraph_thread_id");
    expect(insertSql).toContain("'active'");
    expect(insertSql).toContain("'unknown'");
    expect(query.mock.calls[1]?.[1]).toEqual([CUSTOMER_ID, result.threadId]);

    const allSql = query.mock.calls.map(([sql]) => String(sql)).join("\n");
    expect(allSql).not.toMatch(/insert\s+into\s+customers/i);
    expect(allSql).not.toMatch(/insert\s+into\s+messages/i);
    expect(allSql).not.toMatch(/update\s+conversations/i);
  });

  it("9: propagates unexpected database failures", async () => {
    vi.spyOn(postgresPool, "query").mockRejectedValueOnce(new Error("database unavailable"));

    await expect(createChatSession("KENZA-001")).rejects.toThrow("database unavailable");
  });
});
