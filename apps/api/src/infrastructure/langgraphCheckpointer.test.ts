import { describe, expect, it } from "vitest";
import { vi } from "vitest";

const { mockSetup, mockEnd, MockPostgresSaverCtor } = vi.hoisted(() => {
  const mockSetup = vi.fn().mockResolvedValue(undefined);
  const mockEnd = vi.fn().mockResolvedValue(undefined);
  const MockPostgresSaverCtor = vi.fn().mockImplementation(function MockPostgresSaver() {
    return { setup: mockSetup, end: mockEnd };
  });
  return { mockSetup, mockEnd, MockPostgresSaverCtor };
});

vi.mock("@langchain/langgraph-checkpoint-postgres", () => ({
  PostgresSaver: MockPostgresSaverCtor,
}));

import { postgresPool } from "./postgres";
import * as checkpointerModule from "./langgraphCheckpointer";
import { setupLanggraphCheckpointer } from "./langgraphCheckpointer";

describe("langgraphCheckpointer — TASK-024 infrastructure", () => {
  it("1: constructs PostgresSaver with the shared postgresPool, not a second pool", () => {
    expect(MockPostgresSaverCtor).toHaveBeenCalledTimes(1);
    expect(MockPostgresSaverCtor).toHaveBeenCalledWith(postgresPool);
  });

  it("2: setupLanggraphCheckpointer() calls saver.setup() exactly once per call", async () => {
    mockSetup.mockClear();

    await setupLanggraphCheckpointer();

    expect(mockSetup).toHaveBeenCalledTimes(1);
  });

  it("3: a setup() failure propagates unchanged, never becomes a false success", async () => {
    mockSetup.mockRejectedValueOnce(new Error("checkpoint schema unavailable"));

    await expect(setupLanggraphCheckpointer()).rejects.toThrow("checkpoint schema unavailable");
  });

  it("4: exposes no separate close/end function — closePostgres() remains the sole pool owner", () => {
    expect(Object.keys(checkpointerModule).sort()).toEqual(["langgraphCheckpointer", "setupLanggraphCheckpointer"]);
    expect(mockEnd).not.toHaveBeenCalled();
  });
});
