import { ChatMessage, ChatTransportConfig, LlmError, requestChatCompletion, validateChatTransportConfig } from "./transport";

export type { ChatRole, ChatMessage } from "./transport";
export { LlmError } from "./transport";
export type { LlmErrorCategory } from "./transport";

export type FastLlmClientConfig = ChatTransportConfig;

export interface FastLlmClient {
  chat(messages: ChatMessage[]): Promise<string>;
}

// Explicit config, zero process.env dependency — the shape tests should
// prefer. Fully provider-agnostic: which env vars/auth scheme a caller wires
// in (Azure OpenAI here, a generic OpenAI-compatible provider for
// reasoningClient.ts) is entirely the caller's concern, not this function's.
// Config is validated once, immediately, here — not deferred to the first
// chat() call.
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

// Azure OpenAI's REST contract composes the request URL from the resource
// endpoint, the deployment name and an api-version query parameter — there
// is no single flat "base URL" the way a generic OpenAI-compatible provider
// otherwise expects. Trailing slash(es) are stripped defensively so exactly
// one slash ever separates the endpoint from the deployment path, regardless
// of how AZURE_OPENAI_ENDPOINT was entered; the deployment name and api
// version are both percent-encoded since neither is a repository-controlled
// constant.
function buildAzureChatCompletionsUrl(endpoint: string, deployment: string, apiVersion: string): string {
  const trimmedEndpoint = endpoint.replace(/\/+$/, "");
  return `${trimmedEndpoint}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;
}

// Mirrors the getMaxAgentSteps()/getFollowupDelayMinutes() convention
// elsewhere in this repo: a configured-but-malformed value fails explicitly
// (never silently coerced/defaulted) — here as the same LlmError("config_error")
// class every other fastChat() misconfiguration already produces.
function parseMaxTokens(raw: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new LlmError("config_error", `AZURE_OPENAI_MAX_TOKENS must be a positive integer, got "${raw}"`);
  }
  return parsed;
}

// process.env is read lazily, only when this is actually called — importing
// this module must never fail just because the LLM has not been configured
// yet (e.g. for callers/tests unrelated to the LLM).
//
// TASK-BLOCKER-DUAL-LLM: the fast tier is the official Azure OpenAI GPT-4.1
// deployment — AZURE_OPENAI_API_KEY/ENDPOINT/API_VERSION/DEPLOYMENT_NAME/
// MAX_TOKENS. Never LLM_URL/LLM_API_KEY/LLM_FAST_MODEL/LLM_REASONING_MODEL:
// those remain reasoningClient.ts's own, entirely separate, generic
// OpenAI-compatible credentials — the two tiers never share configuration.
export async function fastChat(messages: ChatMessage[]): Promise<string> {
  const endpoint = readRequiredEnv("AZURE_OPENAI_ENDPOINT");
  const deployment = readRequiredEnv("AZURE_OPENAI_DEPLOYMENT_NAME");
  const apiVersion = readRequiredEnv("AZURE_OPENAI_API_VERSION");
  const apiKey = readRequiredEnv("AZURE_OPENAI_API_KEY");
  const maxTokens = parseMaxTokens(readRequiredEnv("AZURE_OPENAI_MAX_TOKENS"));

  const config: FastLlmClientConfig = {
    url: buildAzureChatCompletionsUrl(endpoint, deployment, apiVersion),
    apiKey,
    model: deployment,
    authHeader: "api-key",
    maxTokens,
  };
  return createFastLlmClient(config).chat(messages);
}
