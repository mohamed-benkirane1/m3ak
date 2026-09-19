import { describe, expect, it } from "vitest";
import {
  buildDashboardApiUrl,
  formatConversionRate,
  formatMad,
  parseDashboardResponse,
  type DashboardData,
} from "./dashboard";

function validResponse(): DashboardData {
  return {
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
        reasonLabel: "Stock non vérifié",
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
  };
}

describe("parseDashboardResponse — valid contract (1)", () => {
  it("1: accepts a fully valid response and returns it unchanged", () => {
    const input = validResponse();
    expect(parseDashboardResponse(input)).toEqual(input);
  });

  it("1: accepts empty lists and a null conversion rate", () => {
    const input: DashboardData = {
      ...validResponse(),
      metrics: {
        conversations: 0,
        orders: 0,
        convertedConversations: 0,
        conversionRate: null,
        openEscalations: 0,
        scheduledFollowups: 0,
        orderValueCents: 0,
        currency: "MAD",
      },
      conversations: [],
      orders: [],
      escalations: [],
      followups: [],
    };
    expect(parseDashboardResponse(input)).toEqual(input);
  });
});

describe("parseDashboardResponse — malformed top-level (2)", () => {
  it("2: rejects null, arrays and non-object values", () => {
    expect(parseDashboardResponse(null)).toBeNull();
    expect(parseDashboardResponse(undefined)).toBeNull();
    expect(parseDashboardResponse([])).toBeNull();
    expect(parseDashboardResponse("dashboard")).toBeNull();
    expect(parseDashboardResponse(42)).toBeNull();
  });

  it("2: rejects an object missing a required top-level section", () => {
    const { followups: _followups, ...withoutFollowups } = validResponse();
    expect(parseDashboardResponse(withoutFollowups)).toBeNull();
  });
});

describe("parseDashboardResponse — private/unexpected fields rejected (3)", () => {
  it("3: rejects an unexpected top-level field", () => {
    expect(parseDashboardResponse({ ...validResponse(), debug: true })).toBeNull();
  });

  it("3: rejects a private/internal field inside metrics", () => {
    const input = validResponse();
    expect(
      parseDashboardResponse({
        ...input,
        metrics: { ...input.metrics, revenueCents: 459900 },
      }),
    ).toBeNull();
  });

  it("3: rejects a raw backend identifier leaking into a conversation summary", () => {
    const input = validResponse();
    const [conversation] = input.conversations;
    expect(
      parseDashboardResponse({
        ...input,
        conversations: [{ ...conversation, id: "11111111-1111-4111-8111-111111111111" }],
      }),
    ).toBeNull();
  });
});

describe("parseDashboardResponse — invalid metrics rejected (4)", () => {
  it("4: rejects a negative count", () => {
    const input = validResponse();
    expect(parseDashboardResponse({ ...input, metrics: { ...input.metrics, conversations: -1 } })).toBeNull();
  });

  it("4: rejects a non-integer count", () => {
    const input = validResponse();
    expect(parseDashboardResponse({ ...input, metrics: { ...input.metrics, orders: 5.5 } })).toBeNull();
  });

  it("4: rejects convertedConversations exceeding conversations", () => {
    const input = validResponse();
    expect(
      parseDashboardResponse({
        ...input,
        metrics: { ...input.metrics, conversations: 2, convertedConversations: 3 },
      }),
    ).toBeNull();
  });

  it("4: rejects a missing metrics key", () => {
    const input = validResponse();
    const { currency: _currency, ...withoutCurrency } = input.metrics;
    expect(parseDashboardResponse({ ...input, metrics: withoutCurrency })).toBeNull();
  });
});

describe("parseDashboardResponse — null conversion accepted (5)", () => {
  it("5: accepts conversionRate null exactly when conversations is 0", () => {
    const input = validResponse();
    expect(
      parseDashboardResponse({
        ...input,
        metrics: { ...input.metrics, conversations: 0, convertedConversations: 0, conversionRate: null },
      }),
    ).not.toBeNull();
  });

  it("5: rejects conversionRate null when conversations is non-zero", () => {
    const input = validResponse();
    expect(parseDashboardResponse({ ...input, metrics: { ...input.metrics, conversionRate: null } })).toBeNull();
  });
});

describe("parseDashboardResponse — invalid conversion range rejected (6)", () => {
  it("6: rejects a rate above 100", () => {
    const input = validResponse();
    expect(parseDashboardResponse({ ...input, metrics: { ...input.metrics, conversionRate: 101 } })).toBeNull();
  });

  it("6: rejects a negative rate", () => {
    const input = validResponse();
    expect(parseDashboardResponse({ ...input, metrics: { ...input.metrics, conversionRate: -5 } })).toBeNull();
  });

  it("6: rejects a non-null rate when conversations is 0", () => {
    const input = validResponse();
    expect(
      parseDashboardResponse({
        ...input,
        metrics: { ...input.metrics, conversations: 0, convertedConversations: 0, conversionRate: 0 },
      }),
    ).toBeNull();
  });
});

describe("parseDashboardResponse — non-MAD currency rejected (7)", () => {
  it("7: rejects USD and any other currency", () => {
    const input = validResponse();
    expect(parseDashboardResponse({ ...input, metrics: { ...input.metrics, currency: "USD" } })).toBeNull();
  });
});

describe("parseDashboardResponse — invalid arrays rejected (8)", () => {
  it("8: rejects a non-array list", () => {
    const input = validResponse();
    expect(parseDashboardResponse({ ...input, orders: {} })).toBeNull();
  });

  it("8: rejects a list exceeding the 10-item maximum", () => {
    const input = validResponse();
    const [order] = input.orders;
    const tooMany = Array.from({ length: 11 }, () => order);
    expect(parseDashboardResponse({ ...input, orders: tooMany })).toBeNull();
  });
});

describe("parseDashboardResponse — invalid enums/statuses rejected (9)", () => {
  it("9: rejects an unknown conversation status", () => {
    const input = validResponse();
    const [conversation] = input.conversations;
    expect(
      parseDashboardResponse({ ...input, conversations: [{ ...conversation, status: "pending" }] }),
    ).toBeNull();
  });

  it("9: rejects an unknown language", () => {
    const input = validResponse();
    const [conversation] = input.conversations;
    expect(
      parseDashboardResponse({ ...input, conversations: [{ ...conversation, language: "english" }] }),
    ).toBeNull();
  });

  it("9: rejects an unknown followup status", () => {
    const input = validResponse();
    const [followup] = input.followups;
    expect(parseDashboardResponse({ ...input, followups: [{ ...followup, status: "queued" }] })).toBeNull();
  });
});

describe("buildDashboardApiUrl — ws/wss protocol mapping (10, 11)", () => {
  it("10: maps a configured ws:// base to http://", () => {
    expect(buildDashboardApiUrl("ws://demo.example:9443/base", { protocol: "http:", hostname: "ignored.example" })).toBe(
      "http://demo.example:9443/api/dashboard",
    );
  });

  it("11: maps a configured wss:// base to https://", () => {
    expect(buildDashboardApiUrl("wss://demo.example:9443/base", { protocol: "http:", hostname: "ignored.example" })).toBe(
      "https://demo.example:9443/api/dashboard",
    );
  });
});

describe("buildDashboardApiUrl — browser fallback (12)", () => {
  it("12: falls back to http://<hostname>:3001 on an http page", () => {
    expect(buildDashboardApiUrl(undefined, { protocol: "http:", hostname: "shop.local" })).toBe(
      "http://shop.local:3001/api/dashboard",
    );
  });

  it("12: falls back to https://<hostname>:3001 on an https page", () => {
    expect(buildDashboardApiUrl("   ", { protocol: "https:", hostname: "shop.local" })).toBe(
      "https://shop.local:3001/api/dashboard",
    );
  });
});

describe("formatMad — money formatting (13)", () => {
  it("13: preserves cent precision when converting to MAD", () => {
    const expected = new Intl.NumberFormat("fr-MA", {
      style: "currency",
      currency: "MAD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(349.9);
    expect(formatMad(34990)).toBe(expected);
  });

  it("13: formats zero cents", () => {
    const expected = new Intl.NumberFormat("fr-MA", {
      style: "currency",
      currency: "MAD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(0);
    expect(formatMad(0)).toBe(expected);
  });

  it("13: preserves single-cent precision", () => {
    const expected = new Intl.NumberFormat("fr-MA", {
      style: "currency",
      currency: "MAD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(0.01);
    expect(formatMad(1)).toBe(expected);
  });
});

describe("formatConversionRate — percentage formatting (14, 15)", () => {
  it("14: renders null as an em dash", () => {
    expect(formatConversionRate(null)).toBe("—");
  });

  it("15: renders a finite rate with at most one decimal and a percent sign", () => {
    const expectedNumber = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 }).format(33.333);
    expect(formatConversionRate(33.333)).toBe(`${expectedNumber} %`);
  });

  it("15: renders a whole-number rate without spurious decimals", () => {
    const expectedNumber = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 }).format(30);
    expect(formatConversionRate(30)).toBe(`${expectedNumber} %`);
  });
});

describe("parsed contract carries no backend identifiers or private fields (16)", () => {
  it("16: the parsed, validated contract never contains raw ids, PII or private state", () => {
    const parsed = parseDashboardResponse(validResponse());
    expect(parsed).not.toBeNull();
    const serialized = JSON.stringify(parsed);
    expect(serialized).not.toMatch(
      /conversationId|customerId|orderId|escalationId|followupId|threadId|langgraph_thread_id|phone|address|bullmq_job_id|context_summary|activePlan|executedSteps|lastResult|lastError/i,
    );
  });
});
