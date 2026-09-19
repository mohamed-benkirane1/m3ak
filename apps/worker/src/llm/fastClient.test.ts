import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFastLlmClient, LlmError } from "./fastClient";
import type { ChatMessage } from "./fastClient";

// TASK-028B: targeted parity proof only — not a full copy of apps/api's own
// exhaustive fastClient.test.ts. Proves the worker's zod-restored transport
// matches the important parts of the API contract (HACK-CTRL decision), not
// every behavior the API suite already covers.

const VALID_CONFIG = { url: "https://example.test/custom/full-endpoint", apiKey: "test-api-key", model: "fast-model-1" };
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

describe("worker transport parity (1): a valid chat-completion response parses", () => {
  it("returns choices[0].message.content, trimmed", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeFetchResponse({ json: async () => ({ choices: [{ message: { content: "  padded content  " } }] }) }),
    );
    const client = createFastLlmClient(VALID_CONFIG);

    await expect(client.chat(VALID_MESSAGES)).resolves.toBe("padded content");
  });

  it("unknown additional response fields (id, model, usage, finish_reason) are accepted, matching zod's non-strict response schema", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeFetchResponse({
        json: async () => ({
          id: "cmpl-123",
          usage: { total_tokens: 42 },
          choices: [{ message: { content: "ok", role: "assistant" }, finish_reason: "stop", index: 0 }],
        }),
      }),
    );
    const client = createFastLlmClient(VALID_CONFIG);

    await expect(client.chat(VALID_MESSAGES)).resolves.toBe("ok");
  });
});

describe("worker transport parity (2): malformed responses produce the same protocol_error category as apps/api", () => {
  it("invalid JSON rejects with category protocol_error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeFetchResponse({
        json: async () => {
          throw new SyntaxError("Unexpected token");
        },
      }),
    );
    const client = createFastLlmClient(VALID_CONFIG);
    await expect(client.chat(VALID_MESSAGES)).rejects.toMatchObject({ category: "protocol_error" });
  });

  it("missing choices rejects with category protocol_error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeFetchResponse({ json: async () => ({}) }));
    const client = createFastLlmClient(VALID_CONFIG);
    await expect(client.chat(VALID_MESSAGES)).rejects.toMatchObject({ category: "protocol_error" });
  });

  it("empty choices array rejects with category protocol_error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeFetchResponse({ json: async () => ({ choices: [] }) }));
    const client = createFastLlmClient(VALID_CONFIG);
    await expect(client.chat(VALID_MESSAGES)).rejects.toMatchObject({ category: "protocol_error" });
  });
});

describe("worker transport parity (3): invalid role/message shape is rejected consistently, before any fetch", () => {
  it("an invalid role rejects before fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = createFastLlmClient(VALID_CONFIG);
    await expect(client.chat([{ role: "bot" as never, content: "hi" }])).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("empty messages array rejects before fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = createFastLlmClient(VALID_CONFIG);
    await expect(client.chat([])).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("blank content rejects before fetch, and an extra unknown field is rejected too (strict message schema)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = createFastLlmClient(VALID_CONFIG);
    await expect(client.chat([{ role: "user", content: "   " }])).rejects.toThrow();
    await expect(
      client.chat([{ role: "user", content: "hi", extra: "leaked" } as unknown as ChatMessage]),
    ).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("worker transport parity (4): empty/missing generated content remains a protocol_error", () => {
  it("null content rejects with category protocol_error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeFetchResponse({ json: async () => ({ choices: [{ message: { content: null } }] }) }),
    );
    const client = createFastLlmClient(VALID_CONFIG);
    await expect(client.chat(VALID_MESSAGES)).rejects.toMatchObject({ category: "protocol_error" });
  });

  it("whitespace-only content rejects with category protocol_error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeFetchResponse({ json: async () => ({ choices: [{ message: { content: "   " } }] }) }),
    );
    const client = createFastLlmClient(VALID_CONFIG);
    await expect(client.chat(VALID_MESSAGES)).rejects.toMatchObject({ category: "protocol_error" });
  });
});

describe("worker transport parity (5): HTTP status mapping is unchanged", () => {
  it("401/403 -> authentication_error, 429 -> rate_limited, 500 -> server_error, 400 -> client_error", async () => {
    const client = createFastLlmClient(VALID_CONFIG);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeFetchResponse({ ok: false, status: 400, statusText: "Bad Request" }));
    await expect(client.chat(VALID_MESSAGES)).rejects.toMatchObject({ category: "client_error" });

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeFetchResponse({ ok: false, status: 401, statusText: "Unauthorized" }));
    await expect(client.chat(VALID_MESSAGES)).rejects.toMatchObject({ category: "authentication_error" });

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeFetchResponse({ ok: false, status: 403, statusText: "Forbidden" }));
    await expect(client.chat(VALID_MESSAGES)).rejects.toMatchObject({ category: "authentication_error" });

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeFetchResponse({ ok: false, status: 429, statusText: "Too Many Requests" }));
    await expect(client.chat(VALID_MESSAGES)).rejects.toMatchObject({ category: "rate_limited" });

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeFetchResponse({ ok: false, status: 500, statusText: "Internal Server Error" }));
    await expect(client.chat(VALID_MESSAGES)).rejects.toMatchObject({ category: "server_error" });
  });
});

describe("worker transport parity (6): timeout/network behavior is unchanged", () => {
  it("a network rejection becomes network_error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("fetch failed"));
    const client = createFastLlmClient(VALID_CONFIG);
    await expect(client.chat(VALID_MESSAGES)).rejects.toMatchObject({ category: "network_error" });
  });

  it("a TimeoutError becomes timeout_error, and the default timeout (15000ms) is used", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const timeoutError = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(timeoutError);
    const client = createFastLlmClient(VALID_CONFIG);

    await expect(client.chat(VALID_MESSAGES)).rejects.toMatchObject({ category: "timeout_error" });
    expect(timeoutSpy).toHaveBeenCalledWith(15_000);
  });

  it("an AbortError also becomes timeout_error", async () => {
    const abortError = new DOMException("The operation was aborted", "AbortError");
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(abortError);
    const client = createFastLlmClient(VALID_CONFIG);
    await expect(client.chat(VALID_MESSAGES)).rejects.toMatchObject({ category: "timeout_error" });
  });
});

describe("worker fastClient — env var parity with apps/api", () => {
  it("reads LLM_URL/LLM_API_KEY/LLM_FAST_MODEL lazily, never LLM_REASONING_MODEL", async () => {
    process.env.LLM_URL = "https://example.test/env-endpoint";
    process.env.LLM_API_KEY = "test-api-key";
    process.env.LLM_FAST_MODEL = "fast-model-env";
    process.env.LLM_REASONING_MODEL = "reasoning-model-should-be-ignored";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeFetchResponse());
    const { fastChat } = await import("./fastClient");

    await fastChat(VALID_MESSAGES);

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.test/env-endpoint");
    const body = JSON.parse(init.body as string) as { model: string };
    expect(body.model).toBe("fast-model-env");
    expect(body.model).not.toBe("reasoning-model-should-be-ignored");
  });
});
