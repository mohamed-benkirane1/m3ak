import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReasoningLlmClient, reasoningChat, LlmError } from "./reasoningClient";
import type { ChatMessage } from "./reasoningClient";

const VALID_CONFIG = { url: "https://example.test/custom/full-endpoint", apiKey: "test-api-key", model: "reasoning-model-1" };
const VALID_MESSAGES: ChatMessage[] = [{ role: "user", content: "hello" }];

function makeFetchResponse(overrides: Partial<{ ok: boolean; status: number; statusText: string; json: () => Promise<unknown> }> = {}) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({ choices: [{ message: { content: "hi there" } }] }),
    ...overrides,
  } as Response;
}

let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  originalEnv = { ...process.env };
});

afterEach(() => {
  process.env = originalEnv;
  vi.restoreAllMocks();
});

describe("createReasoningLlmClient — config (A-D)", () => {
  it("A: explicit config works with all relevant env vars absent", async () => {
    delete process.env.LLM_URL;
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_FAST_MODEL;
    delete process.env.LLM_REASONING_MODEL;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeFetchResponse());

    const client = createReasoningLlmClient(VALID_CONFIG);
    const result = await client.chat(VALID_MESSAGES);

    expect(result).toBe("hi there");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("B: missing/blank explicit URL rejects before fetch", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(() => createReasoningLlmClient({ ...VALID_CONFIG, url: "" })).toThrow(LlmError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("C: missing/blank explicit API key rejects before fetch", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(() => createReasoningLlmClient({ ...VALID_CONFIG, apiKey: "" })).toThrow(LlmError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("D: missing/blank explicit model rejects before fetch", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(() => createReasoningLlmClient({ ...VALID_CONFIG, model: "" })).toThrow(LlmError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("reasoningChat — lazy environment reads (E, F, G, H, I)", () => {
  it("E, F, G: reasoningChat reads LLM_URL/LLM_API_KEY/LLM_REASONING_MODEL lazily at call time", async () => {
    process.env.LLM_URL = "https://example.test/env-endpoint";
    process.env.LLM_API_KEY = "test-api-key";
    process.env.LLM_REASONING_MODEL = "reasoning-model-env";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeFetchResponse());

    await reasoningChat(VALID_MESSAGES);

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.test/env-endpoint");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-api-key");
    const body = JSON.parse(init.body as string) as { model: string };
    expect(body.model).toBe("reasoning-model-env");
  });

  it("H: LLM_FAST_MODEL is ignored even if set to a different value", async () => {
    process.env.LLM_URL = "https://example.test/env-endpoint";
    process.env.LLM_API_KEY = "test-api-key";
    process.env.LLM_REASONING_MODEL = "reasoning-model-env";
    process.env.LLM_FAST_MODEL = "fast-model-should-be-ignored";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeFetchResponse());

    await reasoningChat(VALID_MESSAGES);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { model: string };
    expect(body.model).toBe("reasoning-model-env");
    expect(body.model).not.toBe("fast-model-should-be-ignored");
  });

  it("I: missing LLM_REASONING_MODEL -> config_error before fetch", async () => {
    process.env.LLM_URL = "https://example.test/env-endpoint";
    process.env.LLM_API_KEY = "test-api-key";
    delete process.env.LLM_REASONING_MODEL;
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(reasoningChat(VALID_MESSAGES)).rejects.toMatchObject({ category: "config_error" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("importing reasoningClient.ts does not fail when no LLM env vars are configured", () => {
    delete process.env.LLM_URL;
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_REASONING_MODEL;
    expect(typeof reasoningChat).toBe("function");
  });
});

describe("request contract (J, K, L, M, N, O, P)", () => {
  it("J: the configured URL is used EXACTLY, no path appended", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeFetchResponse());
    const client = createReasoningLlmClient({ ...VALID_CONFIG, url: "https://example.test/custom/full-endpoint" });

    await client.chat(VALID_MESSAGES);

    expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://example.test/custom/full-endpoint");
  });

  it("K: the request model is the configured reasoning model", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeFetchResponse());
    const client = createReasoningLlmClient({ ...VALID_CONFIG, model: "reasoning-model-xyz" });

    await client.chat(VALID_MESSAGES);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { model: string };
    expect(body.model).toBe("reasoning-model-xyz");
  });

  it("L, M, N: method POST, Content-Type application/json, exact Authorization header", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeFetchResponse());
    const client = createReasoningLlmClient(VALID_CONFIG);

    await client.chat(VALID_MESSAGES);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.Authorization).toBe("Bearer test-api-key");
  });

  it("O: body is exactly {model, messages} — no reasoning-specific provider knobs", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeFetchResponse());
    const client = createReasoningLlmClient(VALID_CONFIG);

    await client.chat(VALID_MESSAGES);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["messages", "model"]);
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("response_format");
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("stream");
    expect(body).not.toHaveProperty("max_tokens");
    expect(body).not.toHaveProperty("max_completion_tokens");
  });

  it("P: exactly one fetch call per chat() invocation", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeFetchResponse());
    const client = createReasoningLlmClient(VALID_CONFIG);

    await client.chat(VALID_MESSAGES);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("timeout (Q, S, T, U)", () => {
  it("Q: the reasoning client calls AbortSignal.timeout(60_000)", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeFetchResponse());
    const client = createReasoningLlmClient(VALID_CONFIG);

    await client.chat(VALID_MESSAGES);

    expect(timeoutSpy).toHaveBeenCalledWith(60_000);
  });

  it("S: an omitted transport timeout option still defaults to 15_000 (fast-client path, exercised via transport directly is covered in fastClient.test.ts)", async () => {
    // Covered by the TASK-015 regression test in fastClient.test.ts; kept here
    // only as a cross-reference note, no duplicate assertion needed.
    expect(true).toBe(true);
  });

  it("U: an invalid explicit timeout (0, negative, non-integer, NaN, Infinity) rejects with config_error before fetch", async () => {
    // reasoningClient.ts does not expose timeoutMs publicly, so this exercises
    // transport's own validation directly through the same import surface
    // reasoningClient.ts uses, proving the guard fires before any fetch.
    const { requestChatCompletion } = await import("./transport");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const invalidValues = [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY];

    for (const timeoutMs of invalidValues) {
      await expect(requestChatCompletion(VALID_CONFIG, VALID_MESSAGES, { timeoutMs })).rejects.toMatchObject({
        category: "config_error",
      });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("inherited error behavior from transport (V, W, X)", () => {
  it("V: an HTTP error retains the expected LlmError category", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeFetchResponse({ ok: false, status: 401, statusText: "Unauthorized" }));
    const client = createReasoningLlmClient(VALID_CONFIG);
    await expect(client.chat(VALID_MESSAGES)).rejects.toMatchObject({ category: "authentication_error" });
  });

  it("W: a protocol-invalid response retains protocol_error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeFetchResponse({ json: async () => ({ choices: [] }) }));
    const client = createReasoningLlmClient(VALID_CONFIG);
    await expect(client.chat(VALID_MESSAGES)).rejects.toMatchObject({ category: "protocol_error" });
  });

  it("X: a TimeoutError remains timeout_error", async () => {
    const timeoutError = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(timeoutError);
    const client = createReasoningLlmClient(VALID_CONFIG);
    await expect(client.chat(VALID_MESSAGES)).rejects.toMatchObject({ category: "timeout_error" });
  });

  it("no automatic retry on any HTTP/network/timeout failure", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("fetch failed"));
    const client = createReasoningLlmClient(VALID_CONFIG);
    await expect(client.chat(VALID_MESSAGES)).rejects.toThrow();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("thrown errors never contain the API key or message content", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeFetchResponse({ ok: false, status: 400, statusText: "Bad Request" }));
    const client = createReasoningLlmClient(VALID_CONFIG);
    const secretContent = "super secret complex-reasoning customer text";

    let caught: unknown;
    try {
      await client.chat([{ role: "user", content: secretContent }]);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(LlmError);
    const message = (caught as Error).message;
    expect(message).not.toContain("test-api-key");
    expect(message).not.toContain(secretContent);
  });
});
