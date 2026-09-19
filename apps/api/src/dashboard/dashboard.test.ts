import { afterEach, describe, expect, it, vi } from "vitest";
import { postgresPool } from "../infrastructure/postgres";
import { DASHBOARD_LIST_LIMIT, getDashboardData, getEscalationReasonLabel } from "./dashboard";

function metricsRow(overrides: Record<string, unknown> = {}) {
  return {
    rows: [
      {
        conversations: "12",
        orders: "5",
        converted_conversations: "3",
        open_escalations: "2",
        scheduled_followups: "1",
        order_value_cents: "459900",
        ...overrides,
      },
    ],
  };
}

function emptyMetricsRow() {
  return {
    rows: [
      {
        conversations: "0",
        orders: "0",
        converted_conversations: "0",
        open_escalations: "0",
        scheduled_followups: "0",
        order_value_cents: "0",
      },
    ],
  };
}

function conversationRow(overrides: Record<string, unknown> = {}) {
  return {
    customer_ref: "CLI-0001",
    language: "french",
    status: "active",
    message_count: "4",
    has_order: true,
    has_open_escalation: false,
    created_at: new Date("2026-09-18T10:00:00.000Z"),
    updated_at: new Date("2026-09-19T09:00:00.000Z"),
    ...overrides,
  };
}

function orderRow(overrides: Record<string, unknown> = {}) {
  return {
    customer_ref: "CLI-0002",
    status: "confirmed",
    total_cents: "34990",
    created_at: new Date("2026-09-19T08:00:00.000Z"),
    ...overrides,
  };
}

function escalationRow(overrides: Record<string, unknown> = {}) {
  return {
    customer_ref: "CLI-0003",
    status: "open",
    reason: "missing_stock_evidence, unsupported_restock_claim",
    created_at: new Date("2026-09-19T07:00:00.000Z"),
    ...overrides,
  };
}

function followupRow(overrides: Record<string, unknown> = {}) {
  return {
    customer_ref: "CLI-0004",
    status: "scheduled",
    scheduled_at: new Date("2026-09-20T10:00:00.000Z"),
    executed_at: null,
    ...overrides,
  };
}

function mockAllQueries(overrides: {
  metrics?: unknown;
  conversations?: unknown[];
  orders?: unknown[];
  escalations?: unknown[];
  followups?: unknown[];
}) {
  const spy = vi.spyOn(postgresPool, "query");
  spy.mockResolvedValueOnce(overrides.metrics ?? metricsRow());
  spy.mockResolvedValueOnce({ rows: overrides.conversations ?? [conversationRow()] });
  spy.mockResolvedValueOnce({ rows: overrides.orders ?? [orderRow()] });
  spy.mockResolvedValueOnce({ rows: overrides.escalations ?? [escalationRow()] });
  spy.mockResolvedValueOnce({ rows: overrides.followups ?? [followupRow()] });
  return spy;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DASHBOARD_LIST_LIMIT (12)", () => {
  it("12: is exactly 10", () => {
    expect(DASHBOARD_LIST_LIMIT).toBe(10);
  });
});

describe("getDashboardData — exact success response shape (1)", () => {
  it("1: returns exactly the contracted keys with normalized values", async () => {
    mockAllQueries({});

    const result = await getDashboardData();

    expect(result).toEqual({
      metrics: {
        conversations: 12,
        orders: 5,
        convertedConversations: 3,
        conversionRate: 25,
        openEscalations: 2,
        scheduledFollowups: 1,
        orderValueCents: 459900,
        currency: "MAD",
      },
      conversations: [
        {
          customerRef: "CLI-0001",
          language: "french",
          status: "active",
          messageCount: 4,
          hasOrder: true,
          hasOpenEscalation: false,
          createdAt: "2026-09-18T10:00:00.000Z",
          updatedAt: "2026-09-19T09:00:00.000Z",
        },
      ],
      orders: [
        {
          customerRef: "CLI-0002",
          status: "confirmed",
          totalCents: 34990,
          createdAt: "2026-09-19T08:00:00.000Z",
        },
      ],
      escalations: [
        {
          customerRef: "CLI-0003",
          status: "open",
          reasonLabel: "Stock non vérifié · Réassort non vérifiable",
          createdAt: "2026-09-19T07:00:00.000Z",
        },
      ],
      followups: [
        {
          customerRef: "CLI-0004",
          status: "scheduled",
          scheduledAt: "2026-09-20T10:00:00.000Z",
          executedAt: null,
        },
      ],
    });
    expect(Object.keys(result).sort()).toEqual(["conversations", "escalations", "followups", "metrics", "orders"]);
    expect(Object.keys(result.metrics).sort()).toEqual(
      [
        "conversations",
        "orders",
        "convertedConversations",
        "conversionRate",
        "openEscalations",
        "scheduledFollowups",
        "orderValueCents",
        "currency",
      ].sort(),
    );
  });
});

describe("getDashboardData — empty database (2)", () => {
  it("2: returns zeroed metrics, null conversion rate and empty lists", async () => {
    mockAllQueries({ metrics: emptyMetricsRow(), conversations: [], orders: [], escalations: [], followups: [] });

    const result = await getDashboardData();

    expect(result.metrics).toEqual({
      conversations: 0,
      orders: 0,
      convertedConversations: 0,
      conversionRate: null,
      openEscalations: 0,
      scheduledFollowups: 0,
      orderValueCents: 0,
      currency: "MAD",
    });
    expect(result.conversations).toEqual([]);
    expect(result.orders).toEqual([]);
    expect(result.escalations).toEqual([]);
    expect(result.followups).toEqual([]);
  });
});

describe("getDashboardData — metrics field mapping (3, 4, 10, 11)", () => {
  it("3: conversations count comes from the metrics row", async () => {
    mockAllQueries({ metrics: metricsRow({ conversations: "40" }) });
    const result = await getDashboardData();
    expect(result.metrics.conversations).toBe(40);
  });

  it("4: orders count comes from the metrics row", async () => {
    mockAllQueries({ metrics: metricsRow({ orders: "17" }) });
    const result = await getDashboardData();
    expect(result.metrics.orders).toBe(17);
  });

  it("10: openEscalations is filtered to status = 'open'", async () => {
    const spy = mockAllQueries({ metrics: metricsRow({ open_escalations: "6" }) });
    const result = await getDashboardData();
    expect(result.metrics.openEscalations).toBe(6);
    const metricsSql = String(spy.mock.calls[0]?.[0]);
    expect(metricsSql).toMatch(/escalations\s+WHERE\s+status\s*=\s*'open'/i);
  });

  it("11: scheduledFollowups is filtered to status = 'scheduled'", async () => {
    const spy = mockAllQueries({ metrics: metricsRow({ scheduled_followups: "9" }) });
    const result = await getDashboardData();
    expect(result.metrics.scheduledFollowups).toBe(9);
    const metricsSql = String(spy.mock.calls[0]?.[0]);
    expect(metricsSql).toMatch(/followups\s+WHERE\s+status\s*=\s*'scheduled'/i);
  });
});

describe("getDashboardData — conversion contract (5, 6, 7, 8)", () => {
  it("5: convertedConversations counts DISTINCT converted conversation ids from live orders only", async () => {
    const spy = mockAllQueries({ metrics: metricsRow({ converted_conversations: "3" }) });
    const result = await getDashboardData();
    expect(result.metrics.convertedConversations).toBe(3);
    const metricsSql = String(spy.mock.calls[0]?.[0]);
    expect(metricsSql).toMatch(/COUNT\(DISTINCT\s+conversation_id\)\s+FROM\s+orders/i);
  });

  it("6/22: excludes historical_orders and historical_order_items entirely from the metrics query", async () => {
    const spy = mockAllQueries({});
    await getDashboardData();
    const metricsSql = String(spy.mock.calls[0]?.[0]);
    expect(metricsSql).not.toMatch(/historical_order/i);
  });

  it("7: conversations === 0 yields conversionRate null", async () => {
    mockAllQueries({ metrics: emptyMetricsRow(), conversations: [], orders: [], escalations: [], followups: [] });
    const result = await getDashboardData();
    expect(result.metrics.conversionRate).toBeNull();
  });

  it("8: conversionRate is (convertedConversations / conversations) * 100 in percentage points", async () => {
    mockAllQueries({ metrics: metricsRow({ conversations: "8", converted_conversations: "2" }) });
    const result = await getDashboardData();
    expect(result.metrics.conversionRate).toBe(25);
  });
});

describe("getDashboardData — order value contract (9)", () => {
  it("9: orderValueCents sums live orders.total_cents only, never historical", async () => {
    const spy = mockAllQueries({ metrics: metricsRow({ order_value_cents: "125000" }) });
    const result = await getDashboardData();
    expect(result.metrics.orderValueCents).toBe(125000);
    const metricsSql = String(spy.mock.calls[0]?.[0]);
    expect(metricsSql).toMatch(/SUM\(total_cents\)\s+FROM\s+orders/i);
    expect(metricsSql).not.toMatch(/historical/i);
  });
});

describe("getDashboardData — list safety net (12)", () => {
  it("12: rejects a result exceeding DASHBOARD_LIST_LIMIT rows (defense in depth beyond SQL LIMIT)", async () => {
    const tooMany = Array.from({ length: DASHBOARD_LIST_LIMIT + 1 }, (_unused, index) => conversationRow({ customer_ref: `CLI-${index}` }));
    mockAllQueries({ conversations: tooMany });
    await expect(getDashboardData()).rejects.toThrow();
  });
});

describe("getDashboardData — deterministic ordering (13)", () => {
  it("13: conversations, orders, escalations and followups are all ordered DESC then id DESC", async () => {
    const spy = mockAllQueries({});
    await getDashboardData();

    const conversationsSql = String(spy.mock.calls[1]?.[0]);
    const ordersSql = String(spy.mock.calls[2]?.[0]);
    const escalationsSql = String(spy.mock.calls[3]?.[0]);
    const followupsSql = String(spy.mock.calls[4]?.[0]);

    expect(conversationsSql).toMatch(/ORDER BY\s+conversation\.updated_at DESC,\s*conversation\.id DESC/i);
    expect(ordersSql).toMatch(/ORDER BY\s+orders\.created_at DESC,\s*orders\.id DESC/i);
    expect(escalationsSql).toMatch(/ORDER BY\s+escalation\.created_at DESC,\s*escalation\.id DESC/i);
    expect(followupsSql).toMatch(/ORDER BY\s+followup\.created_at DESC,\s*followup\.id DESC/i);
  });
});

describe("getDashboardData — conversation summary fields (14, 15, 16)", () => {
  it("14: messageCount is passed through from the row", async () => {
    mockAllQueries({ conversations: [conversationRow({ message_count: "23" })] });
    const result = await getDashboardData();
    expect(result.conversations[0]?.messageCount).toBe(23);
  });

  it("15: hasOrder reflects the EXISTS check on live orders", async () => {
    mockAllQueries({ conversations: [conversationRow({ has_order: true })] });
    const result = await getDashboardData();
    expect(result.conversations[0]?.hasOrder).toBe(true);
  });

  it("16: hasOpenEscalation reflects the EXISTS check on open escalations", async () => {
    mockAllQueries({ conversations: [conversationRow({ has_open_escalation: true })] });
    const result = await getDashboardData();
    expect(result.conversations[0]?.hasOpenEscalation).toBe(true);
  });
});

describe("getEscalationReasonLabel — reason mapping (17, 18)", () => {
  it("17: maps each known guardrail reason to its French label", () => {
    expect(getEscalationReasonLabel("unverifiable_observation")).toBe("Résultat non vérifiable");
    expect(getEscalationReasonLabel("missing_stock_evidence")).toBe("Stock non vérifié");
    expect(getEscalationReasonLabel("missing_promotion_evidence")).toBe("Promotion non vérifiée");
    expect(getEscalationReasonLabel("missing_delivery_evidence")).toBe("Livraison non vérifiée");
    expect(getEscalationReasonLabel("ambiguous_product_reference")).toBe("Produit ambigu");
    expect(getEscalationReasonLabel("unsupported_restock_claim")).toBe("Réassort non vérifiable");
    expect(getEscalationReasonLabel("agent_step_limit_reached")).toBe("Limite d’automatisation atteinte");
    expect(getEscalationReasonLabel("orchestrator_requested_escalation")).toBe("Intervention humaine demandée");
  });

  it("17: maps a comma-joined composite reason to joined labels", () => {
    expect(getEscalationReasonLabel("missing_stock_evidence, unsupported_restock_claim")).toBe(
      "Stock non vérifié · Réassort non vérifiable",
    );
  });

  it("18: maps an unknown reason to the neutral fallback", () => {
    expect(getEscalationReasonLabel("some_future_reason_not_yet_known")).toBe("Intervention humaine requise");
    expect(getEscalationReasonLabel("")).toBe("Intervention humaine requise");
    expect(getEscalationReasonLabel(null)).toBe("Intervention humaine requise");
  });

  it("18: a composite reason with one unknown member falls back to the neutral label", () => {
    expect(getEscalationReasonLabel("missing_stock_evidence, some_future_reason")).toBe("Intervention humaine requise");
  });
});

describe("getDashboardData — privacy boundary (19, 20, 21)", () => {
  it("19: escalation query never selects context_summary and the summary omits it", async () => {
    const spy = mockAllQueries({});
    const result = await getDashboardData();
    const escalationsSql = String(spy.mock.calls[3]?.[0]);
    expect(escalationsSql).not.toMatch(/context_summary/i);
    expect(Object.keys(result.escalations[0] ?? {})).not.toContain("context_summary");
  });

  it("20: no raw identifiers (conversation/customer/order/escalation ids) or PII fields appear in the response", async () => {
    mockAllQueries({});
    const result = await getDashboardData();
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/conversationId|customerId|orderId|escalationId|followupId|phone|address|threadId|langgraph_thread_id/i);
  });

  it("20: falls back to the neutral customer label when external_ref is blank", async () => {
    mockAllQueries({ conversations: [conversationRow({ customer_ref: "   " })] });
    const result = await getDashboardData();
    expect(result.conversations[0]?.customerRef).toBe("Client");
  });

  it("21: followups query never selects message or bullmq_job_id and the summary omits them", async () => {
    const spy = mockAllQueries({});
    const result = await getDashboardData();
    const followupsSql = String(spy.mock.calls[4]?.[0]);
    expect(followupsSql).not.toMatch(/bullmq_job_id/i);
    expect(followupsSql).not.toMatch(/followup\.message/i);
    expect(Object.keys(result.followups[0] ?? {})).not.toContain("message");
    expect(Object.keys(result.followups[0] ?? {})).not.toContain("bullmqJobId");
  });
});

describe("getDashboardData — failure propagation (23)", () => {
  it("23: a DB failure propagates unchanged, not swallowed into a false success", async () => {
    vi.spyOn(postgresPool, "query").mockRejectedValueOnce(new Error("connection reset by peer"));
    await expect(getDashboardData()).rejects.toThrow("connection reset by peer");
  });

  it("23: a missing metrics row is a controlled failure, not a crash with undefined fields", async () => {
    const spy = vi.spyOn(postgresPool, "query");
    spy.mockResolvedValueOnce({ rows: [] });
    spy.mockResolvedValueOnce({ rows: [] });
    spy.mockResolvedValueOnce({ rows: [] });
    spy.mockResolvedValueOnce({ rows: [] });
    spy.mockResolvedValueOnce({ rows: [] });
    await expect(getDashboardData()).rejects.toThrow();
  });
});
