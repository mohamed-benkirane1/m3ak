export const DASHBOARD_ERROR_MESSAGE = "Impossible de charger le dashboard. Réessayez.";

export type DashboardLanguage = "darija" | "arabic" | "french" | "mixed" | "unknown";
export type DashboardConversationStatus = "active" | "completed" | "escalated";
export type DashboardOrderStatus = "confirmed";
export type DashboardEscalationStatus = "open" | "resolved";
export type DashboardFollowupStatus = "scheduled" | "executed" | "cancelled" | "failed";

export interface DashboardData {
  metrics: {
    conversations: number;
    orders: number;
    convertedConversations: number;
    conversionRate: number | null;
    openEscalations: number;
    scheduledFollowups: number;
    orderValueCents: number;
    currency: "MAD";
  };
  conversations: Array<{
    customerRef: string;
    language: DashboardLanguage;
    status: DashboardConversationStatus;
    messageCount: number;
    hasOrder: boolean;
    hasOpenEscalation: boolean;
    createdAt: string;
    updatedAt: string;
  }>;
  orders: Array<{
    customerRef: string;
    status: DashboardOrderStatus;
    totalCents: number;
    createdAt: string;
  }>;
  escalations: Array<{
    customerRef: string;
    status: DashboardEscalationStatus;
    reasonLabel: string;
    createdAt: string;
  }>;
  followups: Array<{
    customerRef: string;
    status: DashboardFollowupStatus;
    scheduledAt: string;
    executedAt: string | null;
  }>;
}

type BrowserLocation = Pick<Location, "protocol" | "hostname">;

const LANGUAGES = ["darija", "arabic", "french", "mixed", "unknown"] as const;
const CONVERSATION_STATUSES = ["active", "completed", "escalated"] as const;
const ORDER_STATUSES = ["confirmed"] as const;
const ESCALATION_STATUSES = ["open", "resolved"] as const;
const FOLLOWUP_STATUSES = ["scheduled", "executed", "cancelled", "failed"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && /^\d{4}-\d{2}-\d{2}T/.test(value);
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}

function parseMetrics(value: unknown): DashboardData["metrics"] | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "conversations",
      "orders",
      "convertedConversations",
      "conversionRate",
      "openEscalations",
      "scheduledFollowups",
      "orderValueCents",
      "currency",
    ]) ||
    !isNonNegativeSafeInteger(value.conversations) ||
    !isNonNegativeSafeInteger(value.orders) ||
    !isNonNegativeSafeInteger(value.convertedConversations) ||
    value.convertedConversations > value.conversations ||
    !isNonNegativeSafeInteger(value.openEscalations) ||
    !isNonNegativeSafeInteger(value.scheduledFollowups) ||
    !isNonNegativeSafeInteger(value.orderValueCents) ||
    value.currency !== "MAD"
  ) {
    return null;
  }

  const conversionRate = value.conversionRate;
  if (
    conversionRate !== null &&
    (typeof conversionRate !== "number" || !Number.isFinite(conversionRate) || conversionRate < 0 || conversionRate > 100)
  ) {
    return null;
  }
  if ((value.conversations === 0) !== (conversionRate === null)) return null;

  return {
    conversations: value.conversations,
    orders: value.orders,
    convertedConversations: value.convertedConversations,
    conversionRate,
    openEscalations: value.openEscalations,
    scheduledFollowups: value.scheduledFollowups,
    orderValueCents: value.orderValueCents,
    currency: "MAD",
  };
}

function parseConversations(value: unknown): DashboardData["conversations"] | null {
  if (!Array.isArray(value) || value.length > 10) return null;
  const parsed: DashboardData["conversations"] = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      !hasExactKeys(item, [
        "customerRef",
        "language",
        "status",
        "messageCount",
        "hasOrder",
        "hasOpenEscalation",
        "createdAt",
        "updatedAt",
      ]) ||
      !isNonEmptyString(item.customerRef) ||
      !isOneOf(item.language, LANGUAGES) ||
      !isOneOf(item.status, CONVERSATION_STATUSES) ||
      !isNonNegativeSafeInteger(item.messageCount) ||
      typeof item.hasOrder !== "boolean" ||
      typeof item.hasOpenEscalation !== "boolean" ||
      !isIsoDate(item.createdAt) ||
      !isIsoDate(item.updatedAt)
    ) return null;
    parsed.push({
      customerRef: item.customerRef,
      language: item.language,
      status: item.status,
      messageCount: item.messageCount,
      hasOrder: item.hasOrder,
      hasOpenEscalation: item.hasOpenEscalation,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    });
  }
  return parsed;
}

function parseOrders(value: unknown): DashboardData["orders"] | null {
  if (!Array.isArray(value) || value.length > 10) return null;
  const parsed: DashboardData["orders"] = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      !hasExactKeys(item, ["customerRef", "status", "totalCents", "createdAt"]) ||
      !isNonEmptyString(item.customerRef) ||
      !isOneOf(item.status, ORDER_STATUSES) ||
      !isNonNegativeSafeInteger(item.totalCents) ||
      !isIsoDate(item.createdAt)
    ) return null;
    parsed.push({
      customerRef: item.customerRef,
      status: item.status,
      totalCents: item.totalCents,
      createdAt: item.createdAt,
    });
  }
  return parsed;
}

function parseEscalations(value: unknown): DashboardData["escalations"] | null {
  if (!Array.isArray(value) || value.length > 10) return null;
  const parsed: DashboardData["escalations"] = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      !hasExactKeys(item, ["customerRef", "status", "reasonLabel", "createdAt"]) ||
      !isNonEmptyString(item.customerRef) ||
      !isOneOf(item.status, ESCALATION_STATUSES) ||
      !isNonEmptyString(item.reasonLabel) ||
      !isIsoDate(item.createdAt)
    ) return null;
    parsed.push({
      customerRef: item.customerRef,
      status: item.status,
      reasonLabel: item.reasonLabel,
      createdAt: item.createdAt,
    });
  }
  return parsed;
}

function parseFollowups(value: unknown): DashboardData["followups"] | null {
  if (!Array.isArray(value) || value.length > 10) return null;
  const parsed: DashboardData["followups"] = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      !hasExactKeys(item, ["customerRef", "status", "scheduledAt", "executedAt"]) ||
      !isNonEmptyString(item.customerRef) ||
      !isOneOf(item.status, FOLLOWUP_STATUSES) ||
      !isIsoDate(item.scheduledAt) ||
      (item.executedAt !== null && !isIsoDate(item.executedAt))
    ) return null;
    parsed.push({
      customerRef: item.customerRef,
      status: item.status,
      scheduledAt: item.scheduledAt,
      executedAt: item.executedAt,
    });
  }
  return parsed;
}

export function parseDashboardResponse(value: unknown): DashboardData | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["metrics", "conversations", "orders", "escalations", "followups"])
  ) return null;

  const metrics = parseMetrics(value.metrics);
  const conversations = parseConversations(value.conversations);
  const orders = parseOrders(value.orders);
  const escalations = parseEscalations(value.escalations);
  const followups = parseFollowups(value.followups);
  if (metrics === null || conversations === null || orders === null || escalations === null || followups === null) {
    return null;
  }
  return { metrics, conversations, orders, escalations, followups };
}

export function buildDashboardApiUrl(configuredWsBase: string | undefined, browserLocation: BrowserLocation): string {
  let url: URL;
  if (configuredWsBase?.trim()) {
    url = new URL(configuredWsBase.trim());
    if (url.protocol === "ws:") url.protocol = "http:";
    else if (url.protocol === "wss:") url.protocol = "https:";
    else throw new Error("Unsupported WebSocket protocol");
  } else {
    url = new URL(browserLocation.protocol === "https:" ? "https://localhost" : "http://localhost");
    url.hostname = browserLocation.hostname;
    url.port = "3001";
  }
  url.pathname = "/api/dashboard";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function formatMad(cents: number): string {
  return new Intl.NumberFormat("fr-MA", {
    style: "currency",
    currency: "MAD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

export function formatConversionRate(rate: number | null): string {
  if (rate === null) return "—";
  return `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 }).format(rate)} %`;
}

export function formatDashboardDate(value: string): string {
  return new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

export function getDashboardLanguageLabel(language: DashboardLanguage): string {
  return { darija: "Darija", arabic: "Arabe", french: "Français", mixed: "Mixte", unknown: "Inconnue" }[language];
}

export function getDashboardStatusLabel(status: DashboardConversationStatus | DashboardOrderStatus | DashboardEscalationStatus | DashboardFollowupStatus): string {
  return {
    active: "Active",
    completed: "Terminée",
    escalated: "Escaladée",
    confirmed: "Confirmée",
    open: "Ouverte",
    resolved: "Résolue",
    scheduled: "Planifiée",
    executed: "Exécutée",
    cancelled: "Annulée",
    failed: "Échec",
  }[status];
}
