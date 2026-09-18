import { ChatMessage, ChatTransportConfig, LlmError, requestChatCompletion, validateChatTransportConfig } from "./transport";

export type { ChatRole, ChatMessage } from "./transport";
export { LlmError } from "./transport";
export type { LlmErrorCategory } from "./transport";

export type ReasoningLlmClientConfig = ChatTransportConfig;

export interface ReasoningLlmClient {
  chat(messages: ChatMessage[]): Promise<string>;
}

// Architecture decision, explicitly NOT an official NumeOS value (TASK-015):
// reasoning calls are reserved for heavier multi-step reasoning (CLAUDE.md §7:
// planification multi-étapes, orchestration complexe, révision de plan) and
// may legitimately take longer than the fast model's default budget.
const REASONING_LLM_TIMEOUT_MS = 60_000;

// Explicit config, zero process.env dependency — mirrors createFastLlmClient.
// Config is validated once, immediately, here — not deferred to the first
// chat() call. Never reads/knows LLM_FAST_MODEL.
export function createReasoningLlmClient(config: ReasoningLlmClientConfig): ReasoningLlmClient {
  const validatedConfig = validateChatTransportConfig(config);
  return {
    chat(messages: ChatMessage[]): Promise<string> {
      return requestChatCompletion(validatedConfig, messages, { timeoutMs: REASONING_LLM_TIMEOUT_MS });
    },
  };
}

function readRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new LlmError("config_error", `${name} is missing or empty. Configure it before calling reasoningChat().`);
  }
  return value;
}

// process.env is read lazily, only when this is actually called — importing
// this module must never fail just because the LLM has not been configured
// yet. Reuses the SAME LLM_URL/LLM_API_KEY as the fast client (no separate
// LLM_REASONING_URL/LLM_REASONING_API_KEY exists anywhere in this repository);
// only the model selection differs.
export async function reasoningChat(messages: ChatMessage[]): Promise<string> {
  const config: ReasoningLlmClientConfig = {
    url: readRequiredEnv("LLM_URL"),
    apiKey: readRequiredEnv("LLM_API_KEY"),
    model: readRequiredEnv("LLM_REASONING_MODEL"),
  };
  return createReasoningLlmClient(config).chat(messages);
}
