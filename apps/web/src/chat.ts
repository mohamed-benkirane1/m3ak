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

export type AgentStatus = (typeof AGENT_STATUSES)[number];
export type PublicToolName = (typeof PUBLIC_TOOL_NAMES)[number];
export type GuardrailStatus = (typeof GUARDRAIL_STATUSES)[number];
export type GuardrailCategory = (typeof GUARDRAIL_CATEGORIES)[number];

export type ServerFrame =
  | { type: "agent.message"; content: string }
  | { type: "agent.error"; code: AgentErrorCode; message: string }
  | { type: "agent.status"; status: AgentStatus }
  | { type: "agent.tool"; tool: PublicToolName; status: "started" }
  | { type: "agent.tool"; tool: PublicToolName; status: "completed"; outcome: "positive" | "negative" }
  | { type: "agent.tool"; tool: PublicToolName; status: "failed" }
  | { type: "agent.guardrail"; status: GuardrailStatus; categories: GuardrailCategory[] };

export type ActivityState =
  | "info"
  | "running"
  | "positive"
  | "negative"
  | "failed"
  | "allowed"
  | "blocked"
  | "clarification"
  | "escalation"
  | "neutral";

export interface ActivityItem {
  id: number;
  turnId: number;
  kind: "status" | "tool" | "guardrail";
  label: string;
  state: ActivityState;
  details?: string[];
  toolKey?: PublicToolName;
}

const STATUS_LABELS: Record<AgentStatus, string> = {
  loading_context: "Chargement du contexte client",
  planning: "Planification de la prochaine action",
  escalating_to_human: "Escalade vers un conseiller humain",
  saving_conversation: "Enregistrement de la conversation",
};

const TOOL_LABELS: Record<PublicToolName, string> = {
  searchProducts: "Recherche dans le catalogue",
  getAvailability: "Vérification du stock",
  findAlternatives: "Recherche d’alternatives",
  getApplicablePromotion: "Vérification des promotions",
  getDeliveryOptions: "Calcul des options de livraison",
  createCart: "Création du panier",
  addCartItem: "Ajout au panier",
  createOrder: "Création de la commande",
};

const GUARDRAIL_STATUS_LABELS: Record<GuardrailStatus, string> = {
  allowed: "Contrôle autorisé",
  blocked: "Action bloquée",
  clarification_required: "Clarification nécessaire",
  escalation_required: "Intervention humaine requise",
  not_applicable: "Aucun contrôle applicable",
};

const GUARDRAIL_CATEGORY_LABELS: Record<GuardrailCategory, string> = {
  ambiguous_product: "Produit ambigu",
  stock_unverified: "Stock non vérifié",
  promotion_unverified: "Promotion non vérifiée",
  delivery_unverified: "Livraison non vérifiée",
  unsupported_restock: "Réassort non vérifiable",
  automation_limit: "Limite d’automatisation atteinte",
  unverifiable_result: "Résultat non vérifiable",
};

const GUARDRAIL_STATES: Record<GuardrailStatus, ActivityState> = {
  allowed: "allowed",
  blocked: "blocked",
  clarification_required: "clarification",
  escalation_required: "escalation",
  not_applicable: "neutral",
};

const ACTIVITY_STATE_LABELS: Record<ActivityState, string> = {
  info: "Information",
  running: "En cours",
  positive: "Terminé — résultat positif",
  negative: "Terminé — résultat négatif",
  failed: "Erreur technique",
  allowed: "Contrôle autorisé",
  blocked: "Action bloquée",
  clarification: "Clarification nécessaire",
  escalation: "Intervention humaine requise",
  neutral: "Aucun contrôle applicable",
};

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

export function getActivityStatusLabel(status: AgentStatus): string {
  return STATUS_LABELS[status];
}

export function getToolLabel(tool: PublicToolName): string {
  return TOOL_LABELS[tool];
}

export function getGuardrailStatusLabel(status: GuardrailStatus): string {
  return GUARDRAIL_STATUS_LABELS[status];
}

export function getGuardrailCategoryLabel(category: GuardrailCategory): string {
  return GUARDRAIL_CATEGORY_LABELS[category];
}

export function getActivityStateLabel(state: ActivityState): string {
  return ACTIVITY_STATE_LABELS[state];
}

function projectActivityFrame(frame: ServerFrame, turnId: number, id: number): ActivityItem | null {
  if (frame.type === "agent.status") {
    return {
      id,
      turnId,
      kind: "status",
      label: getActivityStatusLabel(frame.status),
      state: "info",
    };
  }

  if (frame.type === "agent.tool") {
    const state: ActivityState = frame.status === "started"
      ? "running"
      : frame.status === "failed"
        ? "failed"
        : frame.outcome;
    return {
      id,
      turnId,
      kind: "tool",
      label: getToolLabel(frame.tool),
      state,
      toolKey: frame.tool,
    };
  }

  if (frame.type === "agent.guardrail") {
    const details = frame.categories.map(getGuardrailCategoryLabel);
    return {
      id,
      turnId,
      kind: "guardrail",
      label: getGuardrailStatusLabel(frame.status),
      state: GUARDRAIL_STATES[frame.status],
      ...(details.length > 0 ? { details } : {}),
    };
  }

  return null;
}

export function applyActivityFrame(
  currentItems: readonly ActivityItem[],
  frame: ServerFrame,
  turnId: number,
  nextId: number,
): ActivityItem[] {
  const projected = projectActivityFrame(frame, turnId, nextId);
  if (projected === null) return [...currentItems];

  if (frame.type === "agent.tool" && frame.status !== "started") {
    for (let index = currentItems.length - 1; index >= 0; index -= 1) {
      const candidate = currentItems[index];
      if (candidate === undefined) continue;
      if (
        candidate.kind === "tool"
        && candidate.turnId === turnId
        && candidate.toolKey === frame.tool
        && candidate.state === "running"
      ) {
        const updated = [...currentItems];
        updated[index] = { ...candidate, state: projected.state };
        return updated;
      }
    }
  }

  return [...currentItems, projected];
}

export function getSafeErrorMessage(code: unknown): string {
  return isOneOf(code, ERROR_CODES) ? ERROR_MESSAGES[code] : UNKNOWN_SERVER_ERROR_MESSAGE;
}
