import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FOLLOWUP_JOB_NAME } from "@m3ak/shared";
import { postgresPool } from "../infrastructure/postgres";
import { getFollowupQueue } from "../infrastructure/followupQueue";
import { scheduleFollowup } from "./followup";

vi.mock("../infrastructure/followupQueue", () => ({
  getFollowupQueue: vi.fn(),
}));

const mockedGetFollowupQueue = vi.mocked(getFollowupQueue);

const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
const FOLLOWUP_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface FakeClient {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}

function makeFakeClient(): FakeClient {
  return { query: vi.fn(), release: vi.fn() };
}

function makeFollowupRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    conversation_id: CONVERSATION_ID,
    scheduled_at: new Date("2026-09-19T12:05:00.000Z"),
    executed_at: null,
    status: "scheduled",
    message: null,
    ...overrides,
  };
}

let mockAdd: ReturnType<typeof vi.fn>;
let originalDelayEnv: string | undefined;

beforeEach(() => {
  originalDelayEnv = process.env.FOLLOWUP_DELAY_MINUTES;
  delete process.env.FOLLOWUP_DELAY_MINUTES;
  mockAdd = vi.fn().mockImplementation((_name: string, _data: unknown, opts: { jobId: string }) =>
    Promise.resolve({ id: opts.jobId }),
  );
  mockedGetFollowupQueue.mockReturnValue({ add: mockAdd } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  mockedGetFollowupQueue.mockReset();
  if (originalDelayEnv === undefined) {
    delete process.env.FOLLOWUP_DELAY_MINUTES;
  } else {
    process.env.FOLLOWUP_DELAY_MINUTES = originalDelayEnv;
  }
});

describe("scheduleFollowup — input validation (1)", () => {
  it("1: rejects a malformed conversation id before acquiring a client or touching the queue", async () => {
    const connectSpy = vi.spyOn(postgresPool, "connect");

    await expect(scheduleFollowup("not-a-uuid")).rejects.toThrow();

    expect(connectSpy).not.toHaveBeenCalled();
    expect(mockAdd).not.toHaveBeenCalled();
  });
});

describe("scheduleFollowup — conversation not found (2)", () => {
  it("2: rolls back, returns a controlled result, never inserts or enqueues", async () => {
    const client = makeFakeClient();
    vi.spyOn(postgresPool, "connect").mockResolvedValue(client as never);
    client.query.mockResolvedValueOnce({}); // BEGIN
    client.query.mockResolvedValueOnce({ rows: [] }); // lock conversation -> not found
    client.query.mockResolvedValueOnce({}); // ROLLBACK

    const result = await scheduleFollowup(CONVERSATION_ID);

    expect(result).toEqual({ scheduled: false, reason: "conversation_not_found" });
    expect(client.query.mock.calls[2]?.[0]).toBe("ROLLBACK");
    expect(mockAdd).not.toHaveBeenCalled();
  });
});

describe("scheduleFollowup — conversation not active (3)", () => {
  it.each(["completed", "escalated"])("3: status=%s -> controlled result, no enqueue", async (status) => {
    const client = makeFakeClient();
    vi.spyOn(postgresPool, "connect").mockResolvedValue(client as never);
    client.query.mockResolvedValueOnce({}); // BEGIN
    client.query.mockResolvedValueOnce({ rows: [{ status }] }); // lock conversation
    client.query.mockResolvedValueOnce({}); // ROLLBACK

    const result = await scheduleFollowup(CONVERSATION_ID);

    expect(result).toEqual({ scheduled: false, reason: "conversation_not_active" });
    expect(mockAdd).not.toHaveBeenCalled();
  });
});

describe("scheduleFollowup — existing order (4)", () => {
  it("4: an existing order -> controlled result, no enqueue", async () => {
    const client = makeFakeClient();
    vi.spyOn(postgresPool, "connect").mockResolvedValue(client as never);
    client.query.mockResolvedValueOnce({}); // BEGIN
    client.query.mockResolvedValueOnce({ rows: [{ status: "active" }] }); // lock conversation
    client.query.mockResolvedValueOnce({ rows: [{ "?column?": 1 }] }); // existing order found
    client.query.mockResolvedValueOnce({}); // ROLLBACK

    const result = await scheduleFollowup(CONVERSATION_ID);

    expect(result).toEqual({ scheduled: false, reason: "order_already_exists" });
    expect(mockAdd).not.toHaveBeenCalled();
  });
});

describe("scheduleFollowup — open escalation (5)", () => {
  it("5: an open escalation -> controlled result, no enqueue", async () => {
    const client = makeFakeClient();
    vi.spyOn(postgresPool, "connect").mockResolvedValue(client as never);
    client.query.mockResolvedValueOnce({}); // BEGIN
    client.query.mockResolvedValueOnce({ rows: [{ status: "active" }] }); // lock conversation
    client.query.mockResolvedValueOnce({ rows: [] }); // no existing order
    client.query.mockResolvedValueOnce({ rows: [{ "?column?": 1 }] }); // open escalation found
    client.query.mockResolvedValueOnce({}); // ROLLBACK

    const result = await scheduleFollowup(CONVERSATION_ID);

    expect(result).toEqual({ scheduled: false, reason: "open_escalation_exists" });
    expect(mockAdd).not.toHaveBeenCalled();
  });
});

describe("scheduleFollowup — existing scheduled followup replay (6)", () => {
  it("6: does not insert, does not enqueue a second job, replays the existing scheduled followup", async () => {
    const client = makeFakeClient();
    vi.spyOn(postgresPool, "connect").mockResolvedValue(client as never);
    client.query.mockResolvedValueOnce({}); // BEGIN
    client.query.mockResolvedValueOnce({ rows: [{ status: "active" }] }); // lock conversation
    client.query.mockResolvedValueOnce({ rows: [] }); // no existing order
    client.query.mockResolvedValueOnce({ rows: [] }); // no open escalation
    client.query.mockResolvedValueOnce({ rows: [makeFollowupRow()] }); // existing scheduled followup
    client.query.mockResolvedValueOnce({}); // ROLLBACK (nothing new written)

    const result = await scheduleFollowup(CONVERSATION_ID);

    expect(result).toMatchObject({ scheduled: true, replayed: true });
    const insertCalls = client.query.mock.calls.filter((call) => String(call[0]).includes("INSERT"));
    expect(insertCalls).toHaveLength(0);
    expect(mockAdd).not.toHaveBeenCalled();
    expect(client.query.mock.calls[5]?.[0]).toBe("ROLLBACK");
  });
});

describe("scheduleFollowup — successful creation (7)", () => {
  it("7: locks the conversation, inserts a scheduled row with executed_at/message null and bullmq_job_id == id", async () => {
    const client = makeFakeClient();
    vi.spyOn(postgresPool, "connect").mockResolvedValue(client as never);
    client.query.mockResolvedValueOnce({}); // BEGIN
    client.query.mockResolvedValueOnce({ rows: [{ status: "active" }] }); // lock conversation
    client.query.mockResolvedValueOnce({ rows: [] }); // no existing order
    client.query.mockResolvedValueOnce({ rows: [] }); // no open escalation
    client.query.mockResolvedValueOnce({ rows: [] }); // no existing scheduled followup
    client.query.mockImplementationOnce((sql: string, params: unknown[]) => {
      const [id, conversationId, scheduledAt] = params as [string, string, Date];
      return Promise.resolve({
        rows: [makeFollowupRow({ id, conversation_id: conversationId, scheduled_at: scheduledAt })],
      });
    }); // INSERT ... RETURNING
    client.query.mockResolvedValueOnce({}); // COMMIT

    const result = await scheduleFollowup(CONVERSATION_ID);

    expect(result.scheduled).toBe(true);
    if (result.scheduled) {
      expect(result.replayed).toBe(false);
      expect(result.followup.id).toMatch(FOLLOWUP_ID_PATTERN);
      expect(result.followup.status).toBe("scheduled");
      expect(result.followup).not.toHaveProperty("executedAt");
      expect(result.followup).not.toHaveProperty("message");
    }

    const lockSql = String(client.query.mock.calls[1]?.[0]);
    expect(lockSql).toMatch(/WHERE\s+id\s*=\s*\$1\s+FOR\s+UPDATE/i);

    const insertCall = client.query.mock.calls[5];
    expect(String(insertCall?.[0])).toContain("INSERT INTO followups");
    const insertParams = insertCall?.[1] as [string, string, Date];
    expect(insertParams[0]).toBe(mockAdd.mock.calls[0]?.[2]?.jobId); // same UUID used as id and jobId
    expect(client.query.mock.calls[6]?.[0]).toBe("COMMIT");
  });
});

describe("scheduleFollowup — delay contract (8)", () => {
  it("8a: defaults to 5 minutes when FOLLOWUP_DELAY_MINUTES is missing/blank", async () => {
    const client = makeFakeClient();
    vi.spyOn(postgresPool, "connect").mockResolvedValue(client as never);
    client.query.mockResolvedValueOnce({});
    client.query.mockResolvedValueOnce({ rows: [{ status: "active" }] });
    client.query.mockResolvedValueOnce({ rows: [] });
    client.query.mockResolvedValueOnce({ rows: [] });
    client.query.mockResolvedValueOnce({ rows: [] });
    client.query.mockImplementationOnce((_sql: string, params: unknown[]) => {
      const [id, conversationId, scheduledAt] = params as [string, string, Date];
      return Promise.resolve({ rows: [makeFollowupRow({ id, conversation_id: conversationId, scheduled_at: scheduledAt })] });
    });
    client.query.mockResolvedValueOnce({});

    const before = Date.now();
    const result = await scheduleFollowup(CONVERSATION_ID);
    const after = Date.now();

    expect(result.scheduled).toBe(true);
    if (result.scheduled) {
      const scheduledAtMs = new Date(result.followup.scheduledAt).getTime();
      expect(scheduledAtMs).toBeGreaterThanOrEqual(before + 5 * 60_000);
      expect(scheduledAtMs).toBeLessThanOrEqual(after + 5 * 60_000);
    }
    expect(mockAdd.mock.calls[0]?.[2]?.delay).toBe(5 * 60_000);
  });

  it("8b: honors a valid configured FOLLOWUP_DELAY_MINUTES", async () => {
    process.env.FOLLOWUP_DELAY_MINUTES = "10";
    const client = makeFakeClient();
    vi.spyOn(postgresPool, "connect").mockResolvedValue(client as never);
    client.query.mockResolvedValueOnce({});
    client.query.mockResolvedValueOnce({ rows: [{ status: "active" }] });
    client.query.mockResolvedValueOnce({ rows: [] });
    client.query.mockResolvedValueOnce({ rows: [] });
    client.query.mockResolvedValueOnce({ rows: [] });
    client.query.mockImplementationOnce((_sql: string, params: unknown[]) => {
      const [id, conversationId, scheduledAt] = params as [string, string, Date];
      return Promise.resolve({ rows: [makeFollowupRow({ id, conversation_id: conversationId, scheduled_at: scheduledAt })] });
    });
    client.query.mockResolvedValueOnce({});

    await scheduleFollowup(CONVERSATION_ID);

    expect(mockAdd.mock.calls[0]?.[2]?.delay).toBe(10 * 60_000);
  });

  it.each(["0", "-1", "not-a-number", "1.5"])(
    "8c: rejects an invalid configured FOLLOWUP_DELAY_MINUTES (%s) before any DB/queue operation",
    async (value) => {
      process.env.FOLLOWUP_DELAY_MINUTES = value;
      const connectSpy = vi.spyOn(postgresPool, "connect");

      await expect(scheduleFollowup(CONVERSATION_ID)).rejects.toThrow(/FOLLOWUP_DELAY_MINUTES/);

      expect(connectSpy).not.toHaveBeenCalled();
      expect(mockAdd).not.toHaveBeenCalled();
    },
  );
});

describe("scheduleFollowup — queue.add exact contract (9)", () => {
  it("9: FOLLOWUP_JOB_NAME, payload exactly { followupId }, jobId === followupId, delay in ms, no attempts/backoff override", async () => {
    const client = makeFakeClient();
    vi.spyOn(postgresPool, "connect").mockResolvedValue(client as never);
    client.query.mockResolvedValueOnce({});
    client.query.mockResolvedValueOnce({ rows: [{ status: "active" }] });
    client.query.mockResolvedValueOnce({ rows: [] });
    client.query.mockResolvedValueOnce({ rows: [] });
    client.query.mockResolvedValueOnce({ rows: [] });
    client.query.mockImplementationOnce((_sql: string, params: unknown[]) => {
      const [id, conversationId, scheduledAt] = params as [string, string, Date];
      return Promise.resolve({ rows: [makeFollowupRow({ id, conversation_id: conversationId, scheduled_at: scheduledAt })] });
    });
    client.query.mockResolvedValueOnce({});

    const result = await scheduleFollowup(CONVERSATION_ID);

    expect(mockAdd).toHaveBeenCalledTimes(1);
    const [name, data, opts] = mockAdd.mock.calls[0] as [string, unknown, Record<string, unknown>];
    expect(name).toBe(FOLLOWUP_JOB_NAME);
    expect(result.scheduled && !result.replayed ? result.followup.id : undefined).toBe(
      (data as { followupId: string }).followupId,
    );
    expect(Object.keys(data as object)).toEqual(["followupId"]);
    expect(opts.jobId).toBe((data as { followupId: string }).followupId);
    expect(typeof opts.delay).toBe("number");
    expect(opts).not.toHaveProperty("attempts");
    expect(opts).not.toHaveProperty("backoff");
  });
});

describe("scheduleFollowup — enqueue failure (10, 11)", () => {
  it("10: the durable row already committed, status is corrected to failed, the original enqueue error propagates", async () => {
    const client = makeFakeClient();
    vi.spyOn(postgresPool, "connect").mockResolvedValue(client as never);
    client.query.mockResolvedValueOnce({});
    client.query.mockResolvedValueOnce({ rows: [{ status: "active" }] });
    client.query.mockResolvedValueOnce({ rows: [] });
    client.query.mockResolvedValueOnce({ rows: [] });
    client.query.mockResolvedValueOnce({ rows: [] });
    client.query.mockImplementationOnce((_sql: string, params: unknown[]) => {
      const [id, conversationId, scheduledAt] = params as [string, string, Date];
      return Promise.resolve({ rows: [makeFollowupRow({ id, conversation_id: conversationId, scheduled_at: scheduledAt })] });
    });
    client.query.mockResolvedValueOnce({}); // COMMIT
    mockAdd.mockRejectedValueOnce(new Error("redis connection refused"));
    const poolQuerySpy = vi.spyOn(postgresPool, "query").mockResolvedValueOnce({} as never); // status correction UPDATE

    await expect(scheduleFollowup(CONVERSATION_ID)).rejects.toThrow("redis connection refused");

    expect(poolQuerySpy).toHaveBeenCalledTimes(1);
    const [updateSql, updateParams] = poolQuerySpy.mock.calls[0] as [string, unknown[]];
    expect(updateSql).toContain("UPDATE followups");
    expect(updateSql).toContain("SET status = 'failed'");
    expect(updateSql).not.toContain("executed_at");
    expect(updateSql).not.toContain("message");
    expect(updateParams).toHaveLength(1);
  });

  it("11: if the status-correction UPDATE itself also fails, the original enqueue error still propagates (no false success)", async () => {
    const client = makeFakeClient();
    vi.spyOn(postgresPool, "connect").mockResolvedValue(client as never);
    client.query.mockResolvedValueOnce({});
    client.query.mockResolvedValueOnce({ rows: [{ status: "active" }] });
    client.query.mockResolvedValueOnce({ rows: [] });
    client.query.mockResolvedValueOnce({ rows: [] });
    client.query.mockResolvedValueOnce({ rows: [] });
    client.query.mockImplementationOnce((_sql: string, params: unknown[]) => {
      const [id, conversationId, scheduledAt] = params as [string, string, Date];
      return Promise.resolve({ rows: [makeFollowupRow({ id, conversation_id: conversationId, scheduled_at: scheduledAt })] });
    });
    client.query.mockResolvedValueOnce({});
    mockAdd.mockRejectedValueOnce(new Error("redis connection refused"));
    vi.spyOn(postgresPool, "query").mockRejectedValueOnce(new Error("db unreachable for status correction"));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(scheduleFollowup(CONVERSATION_ID)).rejects.toThrow("redis connection refused");

    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("job.id mismatch is treated as an enqueue-failure-class integrity error (status corrected, error propagates)", async () => {
    const client = makeFakeClient();
    vi.spyOn(postgresPool, "connect").mockResolvedValue(client as never);
    client.query.mockResolvedValueOnce({});
    client.query.mockResolvedValueOnce({ rows: [{ status: "active" }] });
    client.query.mockResolvedValueOnce({ rows: [] });
    client.query.mockResolvedValueOnce({ rows: [] });
    client.query.mockResolvedValueOnce({ rows: [] });
    client.query.mockImplementationOnce((_sql: string, params: unknown[]) => {
      const [id, conversationId, scheduledAt] = params as [string, string, Date];
      return Promise.resolve({ rows: [makeFollowupRow({ id, conversation_id: conversationId, scheduled_at: scheduledAt })] });
    });
    client.query.mockResolvedValueOnce({});
    mockAdd.mockResolvedValueOnce({ id: "mismatched-id" });
    const poolQuerySpy = vi.spyOn(postgresPool, "query").mockResolvedValueOnce({} as never);

    await expect(scheduleFollowup(CONVERSATION_ID)).rejects.toThrow(/Integrity error/);

    expect(poolQuerySpy).toHaveBeenCalledTimes(1);
  });
});

describe("scheduleFollowup — concurrency / duplicate protection ordering (13)", () => {
  it("13: the conversation is locked FOR UPDATE strictly before the existing-scheduled-followup check and any insert", async () => {
    const client = makeFakeClient();
    vi.spyOn(postgresPool, "connect").mockResolvedValue(client as never);
    client.query.mockResolvedValueOnce({}); // BEGIN
    client.query.mockResolvedValueOnce({ rows: [{ status: "active" }] }); // lock conversation
    client.query.mockResolvedValueOnce({ rows: [] }); // no existing order
    client.query.mockResolvedValueOnce({ rows: [] }); // no open escalation
    client.query.mockResolvedValueOnce({ rows: [] }); // existing-scheduled check
    client.query.mockImplementationOnce((_sql: string, params: unknown[]) => {
      const [id, conversationId, scheduledAt] = params as [string, string, Date];
      return Promise.resolve({ rows: [makeFollowupRow({ id, conversation_id: conversationId, scheduled_at: scheduledAt })] });
    });
    client.query.mockResolvedValueOnce({});

    await scheduleFollowup(CONVERSATION_ID);

    const sqlCalls = client.query.mock.calls.map((call) => String(call[0]));
    const lockIndex = sqlCalls.findIndex((sql) => /FOR UPDATE/i.test(sql));
    const existingScheduledIndex = sqlCalls.findIndex((sql) => sql.includes("status = 'scheduled'") && sql.includes("SELECT"));
    const insertIndex = sqlCalls.findIndex((sql) => sql.includes("INSERT INTO followups"));

    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(existingScheduledIndex).toBeGreaterThan(lockIndex);
    expect(insertIndex).toBeGreaterThan(existingScheduledIndex);
  });
});

describe("scheduleFollowup — error propagation / no TASK-028 behavior (12, 14, 15)", () => {
  it("12: an unexpected DB error propagates unchanged, not swallowed", async () => {
    const client = makeFakeClient();
    vi.spyOn(postgresPool, "connect").mockResolvedValue(client as never);
    client.query.mockResolvedValueOnce({}); // BEGIN
    client.query.mockRejectedValueOnce(new Error("connection reset by peer")); // lock conversation fails
    client.query.mockResolvedValueOnce({}); // best-effort ROLLBACK

    await expect(scheduleFollowup(CONVERSATION_ID)).rejects.toThrow("connection reset by peer");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("14/15: no queue.add before COMMIT, and no TASK-028 fields ever appear in the INSERT", async () => {
    const client = makeFakeClient();
    vi.spyOn(postgresPool, "connect").mockResolvedValue(client as never);
    client.query.mockResolvedValueOnce({});
    client.query.mockResolvedValueOnce({ rows: [{ status: "active" }] });
    client.query.mockResolvedValueOnce({ rows: [] });
    client.query.mockResolvedValueOnce({ rows: [] });
    client.query.mockResolvedValueOnce({ rows: [] });
    client.query.mockImplementationOnce((_sql: string, params: unknown[]) => {
      expect(mockAdd).not.toHaveBeenCalled(); // INSERT happens strictly before any enqueue attempt
      const [id, conversationId, scheduledAt] = params as [string, string, Date];
      return Promise.resolve({ rows: [makeFollowupRow({ id, conversation_id: conversationId, scheduled_at: scheduledAt })] });
    });
    client.query.mockResolvedValueOnce({});

    await scheduleFollowup(CONVERSATION_ID);

    const insertSql = String(client.query.mock.calls[5]?.[0]);
    expect(insertSql).toContain("VALUES ($1, $2, $3, NULL, 'scheduled', NULL, $1)");
    expect(mockAdd).toHaveBeenCalledTimes(1);
  });
});
