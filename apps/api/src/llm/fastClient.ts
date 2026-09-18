import { ChatMessage, ChatTransportConfig, LlmError, requestChatCompletion, validateChatTransportConfig } from "./transport";

export type { ChatRole, ChatMessage } from "./transport";
export { LlmError } from "./transport";
export type { LlmErrorCategory } from "./transport";

export type FastLlmClientConfig = ChatTransportConfig;

export interface FastLlmClient {
  chat(messages: ChatMessage[]): Promise<string>;
}

// Explicit config, zero process.env dependency — the shape tests should
// prefer, and the shape TASK-015's reasoning client will mirror with its own
// env var. This client never reads/knows LLM_REASONING_MODEL. Config is
// validated once, immediately, here — not deferred to the first chat() call.
export function createFastLlmClient(config: FastLlmClientConfig): FastLlmClient {
  const validatedConfig = validateChatTransportConfig(config);
  return {
    chat(messages: ChatMessage[]): Promise<string> {
      return requestChatCompletion(validatedConfig, messages);
    },
  };
}

function readRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new LlmError("config_error", `${name} is missing or empty. Configure it before calling fastChat().`);
  }
  return value;
}

// process.env is read lazily, only when this is actually called — importing
// this module must never fail just because the LLM has not been configured
// yet (e.g. for callers/tests unrelated to the LLM).
export async function fastChat(messages: ChatMessage[]): Promise<string> {
  const config: FastLlmClientConfig = {
    url: readRequiredEnv("LLM_URL"),
    apiKey: readRequiredEnv("LLM_API_KEY"),
    model: readRequiredEnv("LLM_FAST_MODEL"),
  };
  return createFastLlmClient(config).chat(messages);
}
