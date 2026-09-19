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

vi.mock("bullmq", () => ({
  Worker: MockWorkerCtor,
  createNodeRedisClient: mockCreateNodeRedisClient,
}));

vi.mock("redis", () => ({
  createClient: mockCreateClient,
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
});

const VALID_FOLLOWUP_ID = "11111111-1111-4111-8111-111111111111";

function fakeJob(overrides: Partial<{ name: string; data: unknown; id: string }> = {}): Job {
  return { name: FOLLOWUP_JOB_NAME, data: { followupId: VALID_FOLLOWUP_ID }, id: "job-1", ...overrides } as Job;
}

describe("processFollowupJob — job name / payload validation (3, 4, 5, 6, 7, 8)", () => {
  it("3/8: accepts the exact job name execute-followup, reaches the processor, and fails explicitly — never succeeds", async () => {
    const { processFollowupJob, FollowupExecutionNotImplementedError } = await import("./followupWorker");

    await expect(processFollowupJob(fakeJob())).rejects.toBeInstanceOf(FollowupExecutionNotImplementedError);
  });

  it("4: any other job name is explicitly rejected", async () => {
    const { processFollowupJob } = await import("./followupWorker");

    await expect(processFollowupJob(fakeJob({ name: "some-other-job" }))).rejects.toThrow(/unexpected_job_name/);
  });

  it("5: a valid UUID followupId payload is accepted and reaches the not-implemented failure", async () => {
    const { processFollowupJob, FollowupExecutionNotImplementedError } = await import("./followupWorker");
    const followupId = "22222222-2222-4222-8222-222222222222";

    const error = await processFollowupJob(fakeJob({ data: { followupId } })).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FollowupExecutionNotImplementedError);
    expect((error as InstanceType<typeof FollowupExecutionNotImplementedError>).followupId).toBe(followupId);
  });

  it("6: a malformed followupId (not a UUID) is rejected before reaching the not-implemented failure", async () => {
    const { processFollowupJob, FollowupExecutionNotImplementedError } = await import("./followupWorker");

    const error = await processFollowupJob(fakeJob({ data: { followupId: "not-a-uuid" } })).catch((e: unknown) => e);

    expect(error).not.toBeInstanceOf(FollowupExecutionNotImplementedError);
  });

  it("7: extra business-snapshot fields are rejected by the strict payload schema", async () => {
    const { processFollowupJob, FollowupExecutionNotImplementedError } = await import("./followupWorker");
    const data = {
      followupId: "33333333-3333-4333-8333-333333333333",
      conversationId: "leaked-conversation",
      message: "leaked message content",
    };

    const error = await processFollowupJob(fakeJob({ data })).catch((e: unknown) => e);

    expect(error).not.toBeInstanceOf(FollowupExecutionNotImplementedError);
  });

  it("8: the stable failure message names TASK-028 and carries the real followupId, never a generic error", async () => {
    const { processFollowupJob } = await import("./followupWorker");

    const error = await processFollowupJob(fakeJob()).catch((e: unknown) => e as Error);

    expect(error.message).toContain("followup_execution_not_implemented");
    expect(error.message).toContain(VALID_FOLLOWUP_ID);
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
