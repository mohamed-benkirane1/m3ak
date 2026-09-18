import { z } from "zod";

// Design decision, not an official sourced value (TASK-014A): "fast" model
// traffic should fail well before a human would call it fast anyway.
const FAST_LLM_TIMEOUT_MS = 15_000;

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatTransportConfig {
  url: string;
  apiKey: string;
  model: string;
}

export type LlmErrorCategory =
  | "client_error"
  | "authentication_error"
  | "rate_limited"
  | "server_error"
  | "http_error"
  | "network_error"
  | "timeout_error"
  | "protocol_error"
  | "config_error";

export class LlmError extends Error {
  readonly category: LlmErrorCategory;

  constructor(category: LlmErrorCategory, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LlmError";
    this.category = category;
  }
}

const ChatMessageSchema = z
  .object({
    role: z.enum(["system", "user", "assistant"]),
    content: z.string().trim().min(1),
  })
  .strict();

const MessagesInputSchema = z.array(ChatMessageSchema).min(1);

const ConfigSchema = z
  .object({
    url: z
      .string()
      .trim()
      .url()
      .refine(
        (value) => {
          // Zod does not guarantee short-circuiting after .url() already
          // failed — this predicate can still run on an unparseable string,
          // so it must never let the URL constructor's own throw escape.
          try {
            const protocol = new URL(value).protocol;
            return protocol === "http:" || protocol === "https:";
          } catch {
            return false;
          }
        },
        { message: "url must use http or https" },
      ),
    apiKey: z.string().trim().min(1),
    model: z.string().trim().min(1),
  })
  .strict();

// Shared by createFastLlmClient (validates once, immediately, at construction
// time) and requestChatCompletion (defense in depth for any other caller).
// Wrapped as LlmError so every failure class this module produces — config,
// network, timeout, HTTP, protocol — is the same catchable error type.
export function validateChatTransportConfig(rawConfig: ChatTransportConfig): ChatTransportConfig {
  const result = ConfigSchema.safeParse(rawConfig);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new LlmError("config_error", `Invalid LLM client configuration: ${issues}`);
  }
  return result.data;
}

// Deliberately NOT .strict(): this validates a REMOTE, not-locally-controlled
// response body. Real providers commonly include additional fields (id,
// object, usage, finish_reason, ...) that are irrelevant here but must never
// cause a hard rejection.
const ChatCompletionResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().trim().min(1),
        }),
      }),
    )
    .min(1),
});

function categorizeHttpStatus(status: number): LlmErrorCategory {
  if (status === 401 || status === 403) return "authentication_error";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  if (status >= 400) return "client_error";
  return "http_error";
}

// The one HTTP mechanic shared by every OpenAI-Chat-Completions-shaped client
// this project builds (TASK-014's fast client today, TASK-015's reasoning
// client next). Provider-mechanical only: no env reads, no model-selection
// policy, no business/extraction logic, no retries, no LangGraph.
//
// ASSUMPTION, not a confirmed fact (TASK-014A): the actual NumeOS HTTP
// contract is absent from every local authoritative source. This function
// implements a minimal Chat-Completions-shaped request/response as an
// explicit architecture decision, contained by strict-but-tolerant response
// validation that fails loudly (never silently) if the real contract differs.
export async function requestChatCompletion(rawConfig: ChatTransportConfig, rawMessages: ChatMessage[]): Promise<string> {
  const config = validateChatTransportConfig(rawConfig);
  const messages = MessagesInputSchema.parse(rawMessages);

  let response: Response;
  try {
    response = await fetch(config.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({ model: config.model, messages }),
      signal: AbortSignal.timeout(FAST_LLM_TIMEOUT_MS),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : undefined;
    if (name === "TimeoutError" || name === "AbortError") {
      throw new LlmError("timeout_error", `LLM request timed out after ${FAST_LLM_TIMEOUT_MS}ms`);
    }
    throw new LlmError("network_error", "LLM request failed due to a network error", { cause: error });
  }

  if (!response.ok) {
    throw new LlmError(
      categorizeHttpStatus(response.status),
      `LLM request failed with HTTP ${response.status} ${response.statusText}`,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new LlmError("protocol_error", "LLM response was not valid JSON", { cause: error });
  }

  const parsed = ChatCompletionResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new LlmError("protocol_error", "LLM response did not match the expected shape (missing/empty content)");
  }

  // .min(1) already guarantees at least one element at runtime;
  // noUncheckedIndexedAccess just can't express that statically.
  const [firstChoice] = parsed.data.choices;
  if (!firstChoice) {
    throw new LlmError("protocol_error", "LLM response did not match the expected shape (missing/empty content)");
  }
  return firstChoice.message.content;
}
