import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFastLlmClient, fastChat, LlmError } from "./fastClient";
import type { ChatMessage } from "./fastClient";

const VALID_CONFIG = { url: "https://example.test/custom/full-endpoint", apiKey: "test-api-key", model: "fast-model-1" };
const VALID_MESSAGES: ChatMessage[] = [{ role: "user", content: "hello" }];

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

function deleteAzureEnv(): void {
  for (const key of Object.keys(VALID_AZURE_ENV)) {
    delete process.env[key];
  }
}

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
    deleteAzureEnv();
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

describe("createFastLlmClient — Azure-shaped config (auth header / max tokens)", () => {
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
    const client = createFastLlmClient({ ...VALID_CONFIG, maxTokens: 512 });

    await client.chat(VALID_MESSAGES);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.max_tokens).toBe(512);
  });

  it("omitting authHeader/maxTokens preserves today's exact bearer/no-max_tokens behavior", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeFetchResponse());
    const client = createFastLlmClient(VALID_CONFIG);

    await client.chat(VALID_MESSAGES);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-api-key");
    expect(headers["api-key"]).toBeUndefined();
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).not.toHaveProperty("max_tokens");
  });
});

describe("fastChat — Azure GPT-4.1 environment contract", () => {
  it("1: reads the five AZURE_OPENAI_* variables lazily at call time", async () => {
    setValidAzureEnv();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeFetchResponse());

    await fastChat(VALID_MESSAGES);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("2: the exact Azure chat-completions URL is constructed from endpoint/deployment/api-version", async () => {
    setValidAzureEnv();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeFetchResponse());

    await fastChat(VALID_MESSAGES);

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://example-resource.openai.azure.com/openai/deployments/gpt-4.1-deployment/chat/completions?api-version=2024-06-01",
    );
  });

  it("3: a trailing endpoint slash (single or multiple) never produces a double slash", async () => {
    for (const endpoint of ["https://example-resource.openai.azure.com/", "https://example-resource.openai.azure.com///"]) {
      setValidAzureEnv({ AZURE_OPENAI_ENDPOINT: endpoint });
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeFetchResponse());

      await fastChat(VALID_MESSAGES);

      const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(
        "https://example-resource.openai.azure.com/openai/deployments/gpt-4.1-deployment/chat/completions?api-version=2024-06-01",
      );
      fetchSpy.mockRestore();
    }
  });

  it("4: deployment name and api version are percent-encoded", async () => {
    setValidAzureEnv({ AZURE_OPENAI_DEPLOYMENT_NAME: "my deployment/v1", AZURE_OPENAI_API_VERSION: "2024-06-01-preview&x" });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeFetchResponse());

    await fastChat(VALID_MESSAGES);

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://example-resource.openai.azure.com/openai/deployments/${encodeURIComponent("my deployment/v1")}/chat/completions?api-version=${encodeURIComponent("2024-06-01-preview&x")}`,
    );
    expect(url).not.toContain("my deployment/v1");
  });

  it("5: uses the api-key header, never Authorization/Bearer", async () => {
    setValidAzureEnv();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeFetchResponse());

    await fastChat(VALID_MESSAGES);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["api-key"]).toBe("test-azure-api-key");
    expect(headers.Authorization).toBeUndefined();
  });

  it("6: request body model is the deployment name", async () => {
    setValidAzureEnv();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeFetchResponse());

    await fastChat(VALID_MESSAGES);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { model: string };
    expect(body.model).toBe("gpt-4.1-deployment");
  });

  it("7: request body includes max_tokens parsed from AZURE_OPENAI_MAX_TOKENS", async () => {
    setValidAzureEnv({ AZURE_OPENAI_MAX_TOKENS: "1234" });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeFetchResponse());

    await fastChat(VALID_MESSAGES);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { max_tokens: number };
    expect(body.max_tokens).toBe(1234);
  });

  it("8: missing AZURE_OPENAI_API_KEY -> config_error before fetch", async () => {
    setValidAzureEnv({ AZURE_OPENAI_API_KEY: "" });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(fastChat(VALID_MESSAGES)).rejects.toMatchObject({ category: "config_error" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("9: missing AZURE_OPENAI_ENDPOINT -> config_error before fetch", async () => {
    setValidAzureEnv({ AZURE_OPENAI_ENDPOINT: "" });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(fastChat(VALID_MESSAGES)).rejects.toMatchObject({ category: "config_error" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("10: missing AZURE_OPENAI_DEPLOYMENT_NAME -> config_error before fetch", async () => {
    setValidAzureEnv({ AZURE_OPENAI_DEPLOYMENT_NAME: "" });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(fastChat(VALID_MESSAGES)).rejects.toMatchObject({ category: "config_error" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("11: missing AZURE_OPENAI_API_VERSION -> config_error before fetch", async () => {
    setValidAzureEnv({ AZURE_OPENAI_API_VERSION: "" });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(fastChat(VALID_MESSAGES)).rejects.toMatchObject({ category: "config_error" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("12: invalid/zero/negative/non-integer AZURE_OPENAI_MAX_TOKENS -> config_error before fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    for (const invalid of ["0", "-5", "3.5", "not-a-number", ""]) {
      setValidAzureEnv({ AZURE_OPENAI_MAX_TOKENS: invalid });
      await expect(fastChat(VALID_MESSAGES)).rejects.toMatchObject({ category: "config_error" });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("12b: missing AZURE_OPENAI_MAX_TOKENS -> config_error before fetch", async () => {
    setValidAzureEnv({ AZURE_OPENAI_MAX_TOKENS: "" });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(fastChat(VALID_MESSAGES)).rejects.toMatchObject({ category: "config_error" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("13: no secret value ever appears in a surfaced error message", async () => {
    setValidAzureEnv({ AZURE_OPENAI_MAX_TOKENS: "not-a-number" });
    let caught: unknown;
    try {
      await fastChat(VALID_MESSAGES);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LlmError);
    const message = (caught as Error).message;
    expect(message).not.toContain("test-azure-api-key");
    expect(message).not.toContain("api-key");
  });

  it("13b: an HTTP auth failure never leaks the Azure key in the thrown error", async () => {
    setValidAzureEnv();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeFetchResponse({ ok: false, status: 401, statusText: "Unauthorized" }));

    let caught: unknown;
    try {
      await fastChat(VALID_MESSAGES);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ category: "authentication_error" });
    const message = (caught as Error).message;
    expect(message).not.toContain("test-azure-api-key");
  });

  it("14: a normal successful response still parses correctly", async () => {
    setValidAzureEnv();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeFetchResponse({ json: async () => ({ choices: [{ message: { content: "  réponse Azure  " } }] }) }),
    );

    await expect(fastChat(VALID_MESSAGES)).resolves.toBe("réponse Azure");
  });

  it("15: existing network/timeout/protocol error behavior remains intact", async () => {
    setValidAzureEnv();
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(fastChat(VALID_MESSAGES)).rejects.toMatchObject({ category: "network_error" });
  });

  it("importing fastClient.ts does not fail when no Azure env vars are configured", () => {
    deleteAzureEnv();
    expect(typeof fastChat).toBe("function");
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

  it("U: body is exactly {model, messages} — no additional properties (when maxTokens is omitted)", async () => {
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

  it("TASK-015 regression: the fast client still uses the transport default timeout (15_000ms), unaffected by the timeoutMs refactor", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeFetchResponse());
    const client = createFastLlmClient(VALID_CONFIG);

    await client.chat(VALID_MESSAGES);

    expect(timeoutSpy).toHaveBeenCalledWith(15_000);
  });
});
