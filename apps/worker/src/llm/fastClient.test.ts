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

describe("worker transport parity (7): Azure-shaped config (auth header / max tokens)", () => {
  it("authHeader: 'api-key' sends api-key instead of Authorization", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeFetchResponse());
    const client = createFastLlmClient({ ...VALID_CONFIG, authHeader: "api-key" });

    await client.chat(VALID_MESSAGES);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["api-key"]).toBe("test-api-key");
    expect(headers.Authorization).toBeUndefined();
  });

  it("maxTokens, when set, is serialized as max_tokens in the body", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeFetchResponse());
    await createFastLlmClient({ ...VALID_CONFIG, maxTokens: 512 }).chat(VALID_MESSAGES);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((JSON.parse(init.body as string) as Record<string, unknown>).max_tokens).toBe(512);
  });

  it("maxTokens, when omitted, never appears in the body", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeFetchResponse());
    await createFastLlmClient(VALID_CONFIG).chat(VALID_MESSAGES);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string) as Record<string, unknown>).not.toHaveProperty("max_tokens");
  });
});

describe("worker fastChat — Azure GPT-4.1 environment contract, parity with apps/api", () => {
  const VALID_AZURE_ENV = {
    AZURE_OPENAI_ENDPOINT: "https://example-resource.openai.azure.com",
    AZURE_OPENAI_DEPLOYMENT_NAME: "gpt-4.1-deployment",
    AZURE_OPENAI_API_VERSION: "2024-06-01",
    AZURE_OPENAI_API_KEY: "test-azure-api-key",
    AZURE_OPENAI_MAX_TOKENS: "800",
  };

  function setValidAzureEnv(overrides: Partial<typeof VALID_AZURE_ENV> = {}): void {
    const merged = { ...VALID_AZURE_ENV, ...overrides };
    for (const [key, value] of Object.entries(merged)) {
      process.env[key] = value;
    }
  }

  it("constructs the exact Azure chat-completions URL, uses api-key auth, and sends deployment/max_tokens", async () => {
    setValidAzureEnv();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeFetchResponse());
    const { fastChat } = await import("./fastClient");

    await fastChat(VALID_MESSAGES);

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://example-resource.openai.azure.com/openai/deployments/gpt-4.1-deployment/chat/completions?api-version=2024-06-01",
    );
    const headers = init.headers as Record<string, string>;
    expect(headers["api-key"]).toBe("test-azure-api-key");
    expect(headers.Authorization).toBeUndefined();
    const body = JSON.parse(init.body as string) as { model: string; max_tokens: number };
    expect(body.model).toBe("gpt-4.1-deployment");
    expect(body.max_tokens).toBe(800);
  });

  it("a trailing endpoint slash never produces a double slash", async () => {
    setValidAzureEnv({ AZURE_OPENAI_ENDPOINT: "https://example-resource.openai.azure.com/" });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeFetchResponse());
    const { fastChat } = await import("./fastClient");

    await fastChat(VALID_MESSAGES);

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://example-resource.openai.azure.com/openai/deployments/gpt-4.1-deployment/chat/completions?api-version=2024-06-01",
    );
  });

  it.each([
    "AZURE_OPENAI_API_KEY",
    "AZURE_OPENAI_ENDPOINT",
    "AZURE_OPENAI_DEPLOYMENT_NAME",
    "AZURE_OPENAI_API_VERSION",
  ] as const)("missing %s -> config_error before fetch", async (missingKey) => {
    setValidAzureEnv({ [missingKey]: "" } as Partial<typeof VALID_AZURE_ENV>);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { fastChat } = await import("./fastClient");

    await expect(fastChat(VALID_MESSAGES)).rejects.toBeInstanceOf(LlmError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("invalid/zero/negative/non-integer AZURE_OPENAI_MAX_TOKENS -> config_error before fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { fastChat } = await import("./fastClient");
    for (const invalid of ["0", "-5", "3.5", "not-a-number"]) {
      setValidAzureEnv({ AZURE_OPENAI_MAX_TOKENS: invalid });
      await expect(fastChat(VALID_MESSAGES)).rejects.toMatchObject({ category: "config_error" });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never uses LLM_URL/LLM_API_KEY/LLM_FAST_MODEL/LLM_REASONING_MODEL, even if set", async () => {
    setValidAzureEnv();
    process.env.LLM_URL = "https://should-be-ignored.test";
    process.env.LLM_API_KEY = "should-be-ignored-key";
    process.env.LLM_FAST_MODEL = "should-be-ignored-model";
    process.env.LLM_REASONING_MODEL = "should-be-ignored-reasoning-model";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeFetchResponse());
    const { fastChat } = await import("./fastClient");

    await fastChat(VALID_MESSAGES);

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain("should-be-ignored");
    const body = JSON.parse(init.body as string) as { model: string };
    expect(body.model).toBe("gpt-4.1-deployment");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });
});
