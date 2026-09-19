export const DEMO_PERSONAS = [
  { label: "Persona français", customerRef: "CLI-0001" },
  { label: "Persona Darija", customerRef: "CLI-0004" },
  { label: "Persona arabe", customerRef: "CLI-0022" },
] as const;

export type DemoCustomerRef = (typeof DEMO_PERSONAS)[number]["customerRef"];
export type ConnectionState = "idle" | "connecting" | "open" | "closed";

export interface TranscriptMessage {
  id: number;
  role: "customer" | "assistant";
  content: string;
}

const ERROR_CODES = [
  "invalid_payload",
  "customer_not_found",
  "busy",
  "graph_error",
  "no_assistant_response",
  "session_error",
] as const;

export type AgentErrorCode = (typeof ERROR_CODES)[number];

const AGENT_STATUSES = ["loading_context", "planning", "escalating_to_human", "saving_conversation"] as const;
const PUBLIC_TOOL_NAMES = [
  "searchProducts",
  "getAvailability",
  "findAlternatives",
  "getApplicablePromotion",
  "getDeliveryOptions",
  "createCart",
  "addCartItem",
  "createOrder",
] as const;
const GUARDRAIL_STATUSES = [
  "allowed",
  "blocked",
  "clarification_required",
  "escalation_required",
  "not_applicable",
] as const;
const GUARDRAIL_CATEGORIES = [
  "ambiguous_product",
  "stock_unverified",
  "promotion_unverified",
  "delivery_unverified",
  "unsupported_restock",
  "automation_limit",
  "unverifiable_result",
] as const;

type AgentStatus = (typeof AGENT_STATUSES)[number];
type PublicToolName = (typeof PUBLIC_TOOL_NAMES)[number];
type GuardrailStatus = (typeof GUARDRAIL_STATUSES)[number];
type GuardrailCategory = (typeof GUARDRAIL_CATEGORIES)[number];

export type ServerFrame =
  | { type: "agent.message"; content: string }
  | { type: "agent.error"; code: AgentErrorCode; message: string }
  | { type: "agent.status"; status: AgentStatus }
  | { type: "agent.tool"; tool: PublicToolName; status: "started" }
  | { type: "agent.tool"; tool: PublicToolName; status: "completed"; outcome: "positive" | "negative" }
  | { type: "agent.tool"; tool: PublicToolName; status: "failed" }
  | { type: "agent.guardrail"; status: GuardrailStatus; categories: GuardrailCategory[] };

export interface OutgoingMessage {
  type: "message";
  content: string;
}

interface BrowserLocation {
  protocol: string;
  hostname: string;
}

const ERROR_MESSAGES: Record<AgentErrorCode, string> = {
  invalid_payload: "Le message envoyé est invalide. Vérifiez son contenu puis réessayez.",
  customer_not_found: "Ce client de démonstration est introuvable. Sélectionnez une autre persona.",
  busy: "Une réponse est déjà en cours. Patientez encore un instant.",
  graph_error: "M3AK n’a pas pu traiter ce message. Vous pouvez réessayer.",
  no_assistant_response: "M3AK n’a produit aucune réponse. Vous pouvez réessayer.",
  session_error: "La conversation n’a pas pu être ouverte. Réessayez dans un instant.",
};

export const UNKNOWN_SERVER_ERROR_MESSAGE = "Une réponse inattendue a été reçue. Veuillez réessayer.";
export const CONNECTION_ERROR_MESSAGE = "La connexion au simulateur a été interrompue. Démarrez une nouvelle conversation.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}

function parseFrameObject(value: unknown): ServerFrame | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;

  if (value.type === "agent.message") {
    if (!hasExactKeys(value, ["type", "content"]) || typeof value.content !== "string") return null;
    if (value.content.trim().length === 0) return null;
    return { type: value.type, content: value.content };
  }

  if (value.type === "agent.error") {
    if (!hasExactKeys(value, ["type", "code", "message"])) return null;
    if (!isOneOf(value.code, ERROR_CODES) || typeof value.message !== "string") return null;
    return { type: value.type, code: value.code, message: value.message };
  }

  if (value.type === "agent.status") {
    if (!hasExactKeys(value, ["type", "status"]) || !isOneOf(value.status, AGENT_STATUSES)) return null;
    return { type: value.type, status: value.status };
  }

  if (value.type === "agent.tool") {
    if (!isOneOf(value.tool, PUBLIC_TOOL_NAMES)) return null;
    if (value.status === "started" || value.status === "failed") {
      if (!hasExactKeys(value, ["type", "tool", "status"])) return null;
      return { type: value.type, tool: value.tool, status: value.status };
    }
    if (value.status === "completed") {
      if (!hasExactKeys(value, ["type", "tool", "status", "outcome"])) return null;
      if (value.outcome !== "positive" && value.outcome !== "negative") return null;
      return { type: value.type, tool: value.tool, status: value.status, outcome: value.outcome };
    }
    return null;
  }

  if (value.type === "agent.guardrail") {
    if (!hasExactKeys(value, ["type", "status", "categories"])) return null;
    if (!isOneOf(value.status, GUARDRAIL_STATUSES) || !Array.isArray(value.categories)) return null;
    if (!value.categories.every((category) => isOneOf(category, GUARDRAIL_CATEGORIES))) return null;
    return { type: value.type, status: value.status, categories: value.categories };
  }

  return null;
}

export function parseServerFrame(rawFrame: string): ServerFrame | null {
  try {
    return parseFrameObject(JSON.parse(rawFrame));
  } catch {
    return null;
  }
}

export function buildChatWebSocketUrl(
  customerRef: string,
  configuredBase: string | undefined,
  browserLocation: BrowserLocation,
): string {
  const trimmedBase = configuredBase?.trim();
  const base = trimmedBase
    ? new URL(trimmedBase)
    : new URL(`${browserLocation.protocol === "https:" ? "wss:" : "ws:"}//${browserLocation.hostname}:3001`);
  if (base.protocol !== "ws:" && base.protocol !== "wss:") {
    throw new Error("VITE_WS_URL must use ws: or wss:");
  }
  const url = new URL("/ws/chat", base);
  url.searchParams.set("customerRef", customerRef);
  return url.toString();
}

export function buildOutgoingMessage(rawContent: string): OutgoingMessage | null {
  const content = rawContent.trim();
  if (content.length === 0 || content.length > 4_000) return null;
  return { type: "message", content };
}

export function getSafeErrorMessage(code: unknown): string {
  return isOneOf(code, ERROR_CODES) ? ERROR_MESSAGES[code] : UNKNOWN_SERVER_ERROR_MESSAGE;
}
