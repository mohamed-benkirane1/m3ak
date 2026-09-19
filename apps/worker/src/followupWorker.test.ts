import { beforeEach, describe, expect, it, vi } from "vitest";
import { FOLLOWUP_JOB_NAME, FOLLOWUP_QUEUE_NAME } from "@m3ak/shared";
import type { Job } from "bullmq";

const { mockWorkerClose, mockWorkerOn, MockWorkerCtor, mockCreateNodeRedisClient, mockCreateClient } = vi.hoisted(() => {
  const mockWorkerClose = vi.fn().mockResolvedValue(undefined);
  const mockWorkerOn = vi.fn();
  const MockWorkerCtor = vi.fn().mockImplementation(function MockWorker(name: string) {
    return { name, close: mockWorkerClose, on: mockWorkerOn };
  });
  const mockCreateNodeRedisClient = vi.fn().mockImplementation((client: unknown) => ({ __wrapped: client }));
  function makeMockRawClient() {
    return { isOpen: true, on: vi.fn(), quit: vi.fn().mockResolvedValue(undefined) };
  }
  const mockCreateClient = vi.fn().mockImplementation(() => makeMockRawClient());
  return { mockWorkerClose, mockWorkerOn, MockWorkerCtor, mockCreateNodeRedisClient, mockCreateClient };
});

const { mockExecuteFollowup, mockMarkFailed } = vi.hoisted(() => ({
  mockExecuteFollowup: vi.fn(),
  mockMarkFailed: vi.fn(),
}));

vi.mock("bullmq", () => ({
  Worker: MockWorkerCtor,
  createNodeRedisClient: mockCreateNodeRedisClient,
}));

vi.mock("redis", () => ({
  createClient: mockCreateClient,
}));

vi.mock("./followupExecution", () => ({
  executeFollowup: mockExecuteFollowup,
  markFollowupExecutionFailed: mockMarkFailed,
}));

// followupWorker.ts holds true module-level singleton state (worker + its
// dedicated raw client), so every test resets the module registry and
// re-imports fresh, matching the same isolation approach already used for
// the API producer's own lazy-singleton module.
beforeEach(() => {
  vi.resetModules();
  MockWorkerCtor.mockClear();
  mockWorkerClose.mockClear();
  mockWorkerOn.mockClear();
  mockCreateNodeRedisClient.mockClear();
  mockCreateClient.mockClear();
  mockExecuteFollowup.mockReset();
  mockMarkFailed.mockReset();
});

const VALID_FOLLOWUP_ID = "11111111-1111-4111-8111-111111111111";

function fakeJob(
  overrides: Partial<{
    name: string;
    data: unknown;
    id: string;
    attemptsStarted: number;
    attemptsMade: number;
    opts: { attempts?: number };
  }> = {},
): Job {
  return {
    name: FOLLOWUP_JOB_NAME,
    data: { followupId: VALID_FOLLOWUP_ID },
    id: "job-1",
    attemptsStarted: 1,
    attemptsMade: 0,
    opts: { attempts: 3 },
    ...overrides,
  } as unknown as Job;
}

describe("processFollowupJob — job name / payload validation", () => {
  it("rejects any job name other than execute-followup, never calls executeFollowup", async () => {
    const { processFollowupJob } = await import("./followupWorker");

    await expect(processFollowupJob(fakeJob({ name: "some-other-job" }))).rejects.toThrow(/unexpected_job_name/);

    expect(mockExecuteFollowup).not.toHaveBeenCalled();
  });

  it("rejects a malformed (non-UUID) followupId before executeFollowup is ever called", async () => {
    const { processFollowupJob } = await import("./followupWorker");

    await expect(processFollowupJob(fakeJob({ data: { followupId: "not-a-uuid" } }))).rejects.toThrow();

    expect(mockExecuteFollowup).not.toHaveBeenCalled();
  });

  it("rejects extra business-snapshot fields via the strict payload schema, never calls executeFollowup", async () => {
    const data = {
      followupId: "33333333-3333-4333-8333-333333333333",
      conversationId: "leaked-conversation",
      message: "leaked message content",
    };
    const { processFollowupJob } = await import("./followupWorker");

    await expect(processFollowupJob(fakeJob({ data }))).rejects.toThrow();

    expect(mockExecuteFollowup).not.toHaveBeenCalled();
  });

  it("a valid job delegates to executeFollowup with exactly the followupId, nothing else from the payload", async () => {
    mockExecuteFollowup.mockResolvedValueOnce({ outcome: "executed" });
    const { processFollowupJob } = await import("./followupWorker");

    await processFollowupJob(fakeJob());

    expect(mockExecuteFollowup).toHaveBeenCalledExactlyOnceWith(VALID_FOLLOWUP_ID);
  });
});

describe("processFollowupJob — retry semantics use attemptsStarted, not attemptsMade", () => {
  it("Case A: attemptsStarted=1 of 3 -> stays scheduled, no failed UPDATE, original error rethrown", async () => {
    mockExecuteFollowup.mockRejectedValueOnce(new Error("transient db error"));
    const { processFollowupJob } = await import("./followupWorker");

    await expect(
      processFollowupJob(fakeJob({ attemptsStarted: 1, opts: { attempts: 3 } })),
    ).rejects.toThrow("transient db error");

    expect(mockMarkFailed).not.toHaveBeenCalled();
  });

  it("Case B: attemptsStarted=2 of 3 -> stays scheduled, no failed UPDATE, original error rethrown", async () => {
    mockExecuteFollowup.mockRejectedValueOnce(new Error("transient db error"));
    const { processFollowupJob } = await import("./followupWorker");

    await expect(
      processFollowupJob(fakeJob({ attemptsStarted: 2, opts: { attempts: 3 } })),
    ).rejects.toThrow("transient db error");

    expect(mockMarkFailed).not.toHaveBeenCalled();
  });

  it("Case C: attemptsStarted=3 of 3 (final) -> best-effort status='failed' UPDATE, original error rethrown", async () => {
    mockExecuteFollowup.mockRejectedValueOnce(new Error("transient db error"));
    mockMarkFailed.mockResolvedValueOnce(undefined);
    const { processFollowupJob } = await import("./followupWorker");

    await expect(
      processFollowupJob(fakeJob({ attemptsStarted: 3, opts: { attempts: 3 } })),
    ).rejects.toThrow("transient db error");

    expect(mockMarkFailed).toHaveBeenCalledExactlyOnceWith(VALID_FOLLOWUP_ID);
  });

  it("regression: a misleading attemptsMade never drives the final-attempt decision (attemptsStarted does)", async () => {
    mockExecuteFollowup.mockRejectedValueOnce(new Error("transient db error"));
    const { processFollowupJob } = await import("./followupWorker");

    // attemptsStarted=2 (not final, of 3) but attemptsMade=3 (would look
    // final if that field were used instead) — must NOT mark failed.
    await expect(
      processFollowupJob(fakeJob({ attemptsStarted: 2, attemptsMade: 3, opts: { attempts: 3 } })),
    ).rejects.toThrow("transient db error");

    expect(mockMarkFailed).not.toHaveBeenCalled();
  });

  it("if the failure-marking UPDATE itself also fails, the original processor error still propagates", async () => {
    mockExecuteFollowup.mockRejectedValueOnce(new Error("transient db error"));
    mockMarkFailed.mockRejectedValueOnce(new Error("db unreachable for status correction"));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { processFollowupJob } = await import("./followupWorker");

    await expect(
      processFollowupJob(fakeJob({ attemptsStarted: 3, opts: { attempts: 3 } })),
    ).rejects.toThrow("transient db error");

    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it("no configured attempts option defaults the final-attempt threshold to 1", async () => {
    mockExecuteFollowup.mockRejectedValueOnce(new Error("transient db error"));
    mockMarkFailed.mockResolvedValueOnce(undefined);
    const { processFollowupJob } = await import("./followupWorker");

    await expect(processFollowupJob(fakeJob({ attemptsStarted: 1, opts: {} }))).rejects.toThrow("transient db error");

    expect(mockMarkFailed).toHaveBeenCalledTimes(1);
  });
});

describe("processFollowupJob — controlled outcomes resolve normally (no false retry)", () => {
  it("a cancelled outcome resolves normally — BullMQ must not retry a business-invalid followup", async () => {
    mockExecuteFollowup.mockResolvedValueOnce({ outcome: "cancelled", reason: "conversation_not_active" });
    const { processFollowupJob } = await import("./followupWorker");

    await expect(processFollowupJob(fakeJob())).resolves.toBeUndefined();
  });

  it("a no-such-followup outcome resolves normally, not a retry", async () => {
    mockExecuteFollowup.mockResolvedValueOnce({ outcome: "no_such_followup" });
    const { processFollowupJob } = await import("./followupWorker");

    await expect(processFollowupJob(fakeJob())).resolves.toBeUndefined();
  });

  it("an already_handled outcome resolves normally, not a retry", async () => {
    mockExecuteFollowup.mockResolvedValueOnce({ outcome: "already_handled", status: "executed" });
    const { processFollowupJob } = await import("./followupWorker");

    await expect(processFollowupJob(fakeJob())).resolves.toBeUndefined();
  });
});

describe("createFollowupWorker — TASK-026 infrastructure (1, 2, 9, 10)", () => {
  it("1/2: constructs a Worker with the exact shared FOLLOWUP_QUEUE_NAME constant, not a duplicated literal", async () => {
    const { createFollowupWorker } = await import("./followupWorker");

    createFollowupWorker();

    expect(MockWorkerCtor).toHaveBeenCalledTimes(1);
    expect(MockWorkerCtor.mock.calls[0]?.[0]).toBe(FOLLOWUP_QUEUE_NAME);
  });

  it("uses a dedicated node-redis client wrapped via BullMQ's createNodeRedisClient adapter", async () => {
    const { createFollowupWorker } = await import("./followupWorker");

    createFollowupWorker();

    expect(mockCreateClient).toHaveBeenCalledTimes(1);
    expect(mockCreateNodeRedisClient).toHaveBeenCalledTimes(1);
  });

  it("9: registers a failed handler", async () => {
    const { createFollowupWorker } = await import("./followupWorker");

    createFollowupWorker();

    expect(mockWorkerOn).toHaveBeenCalledWith("failed", expect.any(Function));
  });

  it("10: registers an error handler", async () => {
    const { createFollowupWorker } = await import("./followupWorker");

    createFollowupWorker();

    expect(mockWorkerOn).toHaveBeenCalledWith("error", expect.any(Function));
  });

  it("repeated create returns the same Worker instance without reconstructing it", async () => {
    const { createFollowupWorker } = await import("./followupWorker");

    const first = createFollowupWorker();
    const second = createFollowupWorker();

    expect(second).toBe(first);
    expect(MockWorkerCtor).toHaveBeenCalledTimes(1);
  });
});

describe("closeFollowupWorker — shutdown contract (11, 12, 13)", () => {
  it("close before creation is safe and a no-op", async () => {
    const { closeFollowupWorker } = await import("./followupWorker");

    await expect(closeFollowupWorker()).resolves.toBeUndefined();

    expect(mockWorkerClose).not.toHaveBeenCalled();
  });

  it("11/12: closing invokes worker.close() then releases the dedicated raw client", async () => {
    const { createFollowupWorker, closeFollowupWorker } = await import("./followupWorker");
    createFollowupWorker();
    const rawClientResult = mockCreateClient.mock.results[0]?.value as { quit: ReturnType<typeof vi.fn> };

    await closeFollowupWorker();

    expect(mockWorkerClose).toHaveBeenCalledTimes(1);
    expect(rawClientResult.quit).toHaveBeenCalledTimes(1);
  });

  it("13: double close is safe and does not recreate the worker or fail", async () => {
    const { createFollowupWorker, closeFollowupWorker } = await import("./followupWorker");
    createFollowupWorker();

    await closeFollowupWorker();
    await expect(closeFollowupWorker()).resolves.toBeUndefined();

    expect(MockWorkerCtor).toHaveBeenCalledTimes(1);
    expect(mockWorkerClose).toHaveBeenCalledTimes(1);
  });
});
