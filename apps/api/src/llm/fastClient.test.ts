import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFastLlmClient, fastChat, LlmError } from "./fastClient";
import type { ChatMessage } from "./fastClient";

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

describe("createFastLlmClient — config (A-G)", () => {
  it("A: does not depend on process.env at all", async () => {
    delete process.env.LLM_URL;
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_FAST_MODEL;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeFetchResponse());

    const client = createFastLlmClient(VALID_CONFIG);
    const result = await client.chat(VALID_MESSAGES);

    expect(result).toBe("hi there");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("B: missing/blank URL rejects before fetch", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(() => createFastLlmClient({ ...VALID_CONFIG, url: "" })).toThrow(LlmError);
    expect(() => createFastLlmClient({ ...VALID_CONFIG, url: "   " })).toThrow(LlmError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("C: invalid URL rejects before fetch", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(() => createFastLlmClient({ ...VALID_CONFIG, url: "not-a-url" })).toThrow(LlmError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("D: non-http/https URL rejects before fetch", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(() => createFastLlmClient({ ...VALID_CONFIG, url: "ftp://example.test/x" })).toThrow(LlmError);
    expect(() => createFastLlmClient({ ...VALID_CONFIG, url: "file:///etc/passwd" })).toThrow(LlmError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("E: a localhost HTTP URL is accepted", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeFetchResponse());
    const client = createFastLlmClient({ ...VALID_CONFIG, url: "http://localhost:8080/chat" });
    await expect(client.chat(VALID_MESSAGES)).resolves.toBe("hi there");
  });

  it("F: missing/blank API key rejects before fetch", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(() => createFastLlmClient({ ...VALID_CONFIG, apiKey: "" })).toThrow(LlmError);
    expect(() => createFastLlmClient({ ...VALID_CONFIG, apiKey: "   " })).toThrow(LlmError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("G: missing/blank model rejects before fetch", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(() => createFastLlmClient({ ...VALID_CONFIG, model: "" })).toThrow(LlmError);
    expect(() => createFastLlmClient({ ...VALID_CONFIG, model: "   " })).toThrow(LlmError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("fastChat — lazy environment reads (H, I, J, K)", () => {
  it("H, I, J: fastChat reads LLM_URL/LLM_API_KEY/LLM_FAST_MODEL lazily at call time", async () => {
    process.env.LLM_URL = "https://example.test/env-endpoint";
    process.env.LLM_API_KEY = "test-api-key";
    process.env.LLM_FAST_MODEL = "fast-model-env";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeFetchResponse());

    await fastChat(VALID_MESSAGES);

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.test/env-endpoint");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-api-key");
    const body = JSON.parse(init.body as string) as { model: string };
    expect(body.model).toBe("fast-model-env");
  });

  it("K: LLM_REASONING_MODEL is never read/used", async () => {
    process.env.LLM_URL = "https://example.test/env-endpoint";
    process.env.LLM_API_KEY = "test-api-key";
    process.env.LLM_FAST_MODEL = "fast-model-env";
    process.env.LLM_REASONING_MODEL = "reasoning-model-should-be-ignored";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeFetchResponse());

    await fastChat(VALID_MESSAGES);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { model: string };
    expect(body.model).toBe("fast-model-env");
    expect(body.model).not.toBe("reasoning-model-should-be-ignored");
  });

  it("importing fastClient.ts does not fail when no LLM env vars are configured", () => {
    delete process.env.LLM_URL;
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_FAST_MODEL;
    expect(typeof fastChat).toBe("function");
  });

  it("fastChat rejects with a config error if env vars are missing at call time", async () => {
    delete process.env.LLM_URL;
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_FAST_MODEL;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(fastChat(VALID_MESSAGES)).rejects.toThrow(LlmError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("input contract (L, M, N, O, P)", () => {
  it("L: empty messages rejects before fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = createFastLlmClient(VALID_CONFIG);
    await expect(client.chat([])).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("M: an invalid role rejects before fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = createFastLlmClient(VALID_CONFIG);
    await expect(client.chat([{ role: "bot" as never, content: "hi" }])).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("N: blank content rejects before fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = createFastLlmClient(VALID_CONFIG);
    await expect(client.chat([{ role: "user", content: "   " }])).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("O: content is trimmed before the remote request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeFetchResponse());
    const client = createFastLlmClient(VALID_CONFIG);

    await client.chat([{ role: "user", content: "  hello world  " }]);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { messages: ChatMessage[] };
    expect(body.messages[0]?.content).toBe("hello world");
  });

  it("P: multiple system/user/assistant messages retain order", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeFetchResponse());
    const client = createFastLlmClient(VALID_CONFIG);
    const messages: ChatMessage[] = [
      { role: "system", content: "be terse" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "how are you" },
    ];

    await client.chat(messages);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { messages: ChatMessage[] };
    expect(body.messages).toEqual(messages);
  });
});

describe("request contract (Q, R, S, T, U, V)", () => {
  it("Q: the configured URL is used EXACTLY, no path appended", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeFetchResponse());
    const client = createFastLlmClient({ ...VALID_CONFIG, url: "https://example.test/custom/full-endpoint" });

    await client.chat(VALID_MESSAGES);

    expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://example.test/custom/full-endpoint");
  });

  it("R, S, T: method POST, Content-Type application/json, exact Authorization header", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeFetchResponse());
    const client = createFastLlmClient(VALID_CONFIG);

    await client.chat(VALID_MESSAGES);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.Authorization).toBe("Bearer test-api-key");
  });

  it("U: body is exactly {model, messages} — no additional properties", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeFetchResponse());
    const client = createFastLlmClient(VALID_CONFIG);

    await client.chat(VALID_MESSAGES);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["messages", "model"]);
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("response_format");
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("stream");
    expect(body).not.toHaveProperty("max_tokens");
  });

  it("V: exactly one fetch call per chat() invocation", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeFetchResponse());
    const client = createFastLlmClient(VALID_CONFIG);

    await client.chat(VALID_MESSAGES);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("success response (W, X, Y)", () => {
  it("W, X: returns choices[0].message.content, trimmed", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeFetchResponse({ json: async () => ({ choices: [{ message: { content: "  padded content  " } }] }) }),
    );
    const client = createFastLlmClient(VALID_CONFIG);

    await expect(client.chat(VALID_MESSAGES)).resolves.toBe("padded content");
  });

  it("Y: unknown additional response fields (id, model, usage, finish_reason) are accepted", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeFetchResponse({
        json: async () => ({
          id: "cmpl-123",
          model: "fast-model-1",
          usage: { total_tokens: 42 },
          choices: [{ message: { content: "ok", role: "assistant" }, finish_reason: "stop", index: 0 }],
        }),
      }),
    );
    const client = createFastLlmClient(VALID_CONFIG);

    await expect(client.chat(VALID_MESSAGES)).resolves.toBe("ok");
  });
});

describe("protocol failures (Z, AA, AB, AC, AD, AE, AF)", () => {
  it("Z: invalid JSON rejects with a sanitized protocol error", async () => {
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

  it("AA: missing choices rejects", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeFetchResponse({ json: async () => ({}) }));
    const client = createFastLlmClient(VALID_CONFIG);
    await expect(client.chat(VALID_MESSAGES)).rejects.toMatchObject({ category: "protocol_error" });
  });

  it("AB: empty choices array rejects", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeFetchResponse({ json: async () => ({ choices: [] }) }));
    const client = createFastLlmClient(VALID_CONFIG);
    await expect(client.chat(VALID_MESSAGES)).rejects.toMatchObject({ category: "protocol_error" });
  });

  it("AC: missing message rejects", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeFetchResponse({ json: async () => ({ choices: [{}] }) }));
    const client = createFastLlmClient(VALID_CONFIG);
    await expect(client.chat(VALID_MESSAGES)).rejects.toMatchObject({ category: "protocol_error" });
  });

  it("AD: null content rejects", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeFetchResponse({ json: async () => ({ choices: [{ message: { content: null } }] }) }),
    );
    const client = createFastLlmClient(VALID_CONFIG);
    await expect(client.chat(VALID_MESSAGES)).rejects.toMatchObject({ category: "protocol_error" });
  });

  it("AE: non-string content rejects", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeFetchResponse({ json: async () => ({ choices: [{ message: { content: 42 } }] }) }),
    );
    const client = createFastLlmClient(VALID_CONFIG);
    await expect(client.chat(VALID_MESSAGES)).rejects.toMatchObject({ category: "protocol_error" });
  });

  it("AF: whitespace-only content rejects", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeFetchResponse({ json: async () => ({ choices: [{ message: { content: "   " } }] }) }),
    );
    const client = createFastLlmClient(VALID_CONFIG);
    await expect(client.chat(VALID_MESSAGES)).rejects.toMatchObject({ category: "protocol_error" });
  });
});

describe("HTTP failures (AG-AO)", () => {
  it("AG: HTTP 400 -> sanitized client_error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeFetchResponse({ ok: false, status: 400, statusText: "Bad Request" }));
    const client = createFastLlmClient(VALID_CONFIG);
    await expect(client.chat(VALID_MESSAGES)).rejects.toMatchObject({ category: "client_error" });
  });

  it("AH, AI: HTTP 401/403 -> sanitized authentication_error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeFetchResponse({ ok: false, status: 401, statusText: "Unauthorized" }));
    const client1 = createFastLlmClient(VALID_CONFIG);
    await expect(client1.chat(VALID_MESSAGES)).rejects.toMatchObject({ category: "authentication_error" });

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeFetchResponse({ ok: false, status: 403, statusText: "Forbidden" }));
    const client2 = createFastLlmClient(VALID_CONFIG);
    await expect(client2.chat(VALID_MESSAGES)).rejects.toMatchObject({ category: "authentication_error" });
  });

  it("AJ: HTTP 429 -> sanitized rate_limited, no retry", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeFetchResponse({ ok: false, status: 429, statusText: "Too Many Requests" }));
    const client = createFastLlmClient(VALID_CONFIG);
    await expect(client.chat(VALID_MESSAGES)).rejects.toMatchObject({ category: "rate_limited" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("AK: HTTP 500 -> sanitized server_error, no retry", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(makeFetchResponse({ ok: false, status: 500, statusText: "Internal Server Error" }));
    const client = createFastLlmClient(VALID_CONFIG);
    await expect(client.chat(VALID_MESSAGES)).rejects.toMatchObject({ category: "server_error" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("AL: no HTTP error class automatically retries", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeFetchResponse({ ok: false, status: 503, statusText: "Unavailable" }));
    const client = createFastLlmClient(VALID_CONFIG);
    await expect(client.chat(VALID_MESSAGES)).rejects.toThrow();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("AM, AN, AO: thrown error never contains the raw body, API key, or request message text", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeFetchResponse({ ok: false, status: 400, statusText: "Bad Request" }));
    const client = createFastLlmClient(VALID_CONFIG);
    const secretContent = "super secret customer conversation text";

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
    expect(message).not.toContain("Bearer");
  });
});

describe("network and timeout (AP-AT)", () => {
  it("AP: a normal network rejection becomes a sanitized network_error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("fetch failed"));
    const client = createFastLlmClient(VALID_CONFIG);
    await expect(client.chat(VALID_MESSAGES)).rejects.toMatchObject({ category: "network_error" });
  });

  it("AQ: a TimeoutError becomes an explicit timeout_error", async () => {
    const timeoutError = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(timeoutError);
    const client = createFastLlmClient(VALID_CONFIG);
    await expect(client.chat(VALID_MESSAGES)).rejects.toMatchObject({ category: "timeout_error" });
  });

  it("AR: an AbortError also becomes an explicit timeout_error", async () => {
    const abortError = new DOMException("The operation was aborted", "AbortError");
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(abortError);
    const client = createFastLlmClient(VALID_CONFIG);
    await expect(client.chat(VALID_MESSAGES)).rejects.toMatchObject({ category: "timeout_error" });
  });

  it("AS: timeout/network failures do not retry", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("fetch failed"));
    const client = createFastLlmClient(VALID_CONFIG);
    await expect(client.chat(VALID_MESSAGES)).rejects.toThrow();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("AT: fetch receives an AbortSignal", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeFetchResponse());
    const client = createFastLlmClient(VALID_CONFIG);

    await client.chat(VALID_MESSAGES);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
