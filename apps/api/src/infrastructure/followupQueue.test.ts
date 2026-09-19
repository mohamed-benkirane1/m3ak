import { beforeEach, describe, expect, it, vi } from "vitest";
import { FOLLOWUP_QUEUE_NAME } from "@m3ak/shared";

const { mockQueueClose, MockQueueCtor, mockCreateNodeRedisClient, mockCreateClient } = vi.hoisted(() => {
  const mockQueueClose = vi.fn().mockResolvedValue(undefined);
  const MockQueueCtor = vi.fn().mockImplementation(function MockQueue() {
    return { close: mockQueueClose };
  });
  const mockCreateNodeRedisClient = vi.fn().mockImplementation((client: unknown) => ({ __wrapped: client }));
  function makeMockRawClient() {
    return { isOpen: true, on: vi.fn(), quit: vi.fn().mockResolvedValue(undefined) };
  }
  const mockCreateClient = vi.fn().mockImplementation(() => makeMockRawClient());
  return { mockQueueClose, MockQueueCtor, mockCreateNodeRedisClient, mockCreateClient };
});

vi.mock("bullmq", () => ({
  Queue: MockQueueCtor,
  createNodeRedisClient: mockCreateNodeRedisClient,
}));

vi.mock("redis", () => ({
  createClient: mockCreateClient,
}));

// followupQueue.ts holds true module-level singleton state (lazy Queue +
// dedicated raw client), so every test resets the module registry and
// re-imports fresh — the same isolation need already solved this way
// elsewhere in the repo whenever a lazy singleton is under test.
beforeEach(() => {
  vi.resetModules();
  MockQueueCtor.mockClear();
  mockQueueClose.mockClear();
  mockCreateNodeRedisClient.mockClear();
  mockCreateClient.mockClear();
});

describe("getFollowupQueue — TASK-026 producer infrastructure", () => {
  it("1: constructs a Queue with the exact shared FOLLOWUP_QUEUE_NAME constant", async () => {
    const { getFollowupQueue } = await import("./followupQueue");

    getFollowupQueue();

    expect(MockQueueCtor).toHaveBeenCalledTimes(1);
    expect(MockQueueCtor.mock.calls[0]?.[0]).toBe(FOLLOWUP_QUEUE_NAME);
  });

  it("2: uses a dedicated node-redis client wrapped via BullMQ's createNodeRedisClient adapter", async () => {
    const { getFollowupQueue } = await import("./followupQueue");

    getFollowupQueue();

    expect(mockCreateClient).toHaveBeenCalledTimes(1);
    expect(mockCreateNodeRedisClient).toHaveBeenCalledTimes(1);
    const options = MockQueueCtor.mock.calls[0]?.[1] as { connection?: unknown };
    expect(options.connection).toBe(mockCreateNodeRedisClient.mock.results[0]?.value);
  });

  it("3: defaultJobOptions are attempts=3 with exponential backoff delay=1000", async () => {
    const { getFollowupQueue } = await import("./followupQueue");

    getFollowupQueue();

    const options = MockQueueCtor.mock.calls[0]?.[1] as {
      defaultJobOptions?: { attempts?: number; backoff?: { type?: string; delay?: number } };
    };
    expect(options.defaultJobOptions?.attempts).toBe(3);
    expect(options.defaultJobOptions?.backoff).toEqual({ type: "exponential", delay: 1000 });
  });

  it("4: lazy singleton — repeated calls return the same Queue instance without reconstructing it", async () => {
    const { getFollowupQueue } = await import("./followupQueue");

    const first = getFollowupQueue();
    const second = getFollowupQueue();

    expect(second).toBe(first);
    expect(MockQueueCtor).toHaveBeenCalledTimes(1);
    expect(mockCreateClient).toHaveBeenCalledTimes(1);
  });

  it("5: never reuses or mutates the API's own healthcheck redis client — its own dedicated client is created fresh", async () => {
    const { getFollowupQueue } = await import("./followupQueue");

    getFollowupQueue();

    // followupQueue.ts never imports ../infrastructure/redis at all — the
    // only redis.createClient() call observed here is this module's own.
    expect(mockCreateClient).toHaveBeenCalledTimes(1);
  });

  it("9: a genuine construction error propagates, never converted into a false success", async () => {
    MockQueueCtor.mockImplementationOnce(function FailingQueue() {
      throw new Error("redis connection refused");
    });
    const { getFollowupQueue } = await import("./followupQueue");

    expect(() => getFollowupQueue()).toThrow("redis connection refused");
  });
});

describe("closeFollowupQueue — shutdown contract (6, 7, 8)", () => {
  it("6: close before initialization is safe and a no-op", async () => {
    const { closeFollowupQueue } = await import("./followupQueue");

    await expect(closeFollowupQueue()).resolves.toBeUndefined();

    expect(mockQueueClose).not.toHaveBeenCalled();
  });

  it("7: close after initialization closes the Queue then releases the dedicated raw client", async () => {
    const { getFollowupQueue, closeFollowupQueue } = await import("./followupQueue");
    getFollowupQueue();
    const rawClientResult = mockCreateClient.mock.results[0]?.value as { quit: ReturnType<typeof vi.fn> };

    await closeFollowupQueue();

    expect(mockQueueClose).toHaveBeenCalledTimes(1);
    expect(rawClientResult.quit).toHaveBeenCalledTimes(1);
  });

  it("8: repeated shutdown does not recreate a Queue or fail", async () => {
    const { getFollowupQueue, closeFollowupQueue } = await import("./followupQueue");
    getFollowupQueue();

    await closeFollowupQueue();
    await expect(closeFollowupQueue()).resolves.toBeUndefined();

    expect(MockQueueCtor).toHaveBeenCalledTimes(1);
    expect(mockQueueClose).toHaveBeenCalledTimes(1);
  });
});
