import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../dashboard/dashboard", () => ({
  getDashboardData: vi.fn(),
}));

import Fastify, { type FastifyInstance } from "fastify";
import { getDashboardData } from "../dashboard/dashboard";
import { registerDashboardRoute } from "./dashboard";

const mockedGetDashboardData = vi.mocked(getDashboardData);

const SAMPLE_RESPONSE = {
  metrics: {
    conversations: 4,
    orders: 2,
    convertedConversations: 2,
    conversionRate: 50,
    openEscalations: 1,
    scheduledFollowups: 1,
    orderValueCents: 69980,
    currency: "MAD" as const,
  },
  conversations: [],
  orders: [],
  escalations: [],
  followups: [],
};

async function makeServer(): Promise<FastifyInstance> {
  const server = Fastify({ logger: false });
  registerDashboardRoute(server);
  await server.ready();
  return server;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/dashboard — success (1)", () => {
  it("1: returns 200 with exactly the data layer's response, untouched", async () => {
    mockedGetDashboardData.mockResolvedValueOnce(SAMPLE_RESPONSE);
    const server = await makeServer();

    const response = await server.inject({ method: "GET", url: "/api/dashboard" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(SAMPLE_RESPONSE);
    await server.close();
  });
});

describe("GET /api/dashboard — error contract (23, 24, 26)", () => {
  it("23/24: a data-layer failure is caught and returns HTTP 503 with the controlled error body", async () => {
    mockedGetDashboardData.mockRejectedValueOnce(new Error("relation \"orders\" does not exist — internal SQL detail"));
    const server = await makeServer();

    const response = await server.inject({ method: "GET", url: "/api/dashboard" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: { code: "dashboard_unavailable", message: "Dashboard temporarily unavailable" },
    });
    await server.close();
  });

  it("26: never leaks the raw PostgreSQL error text or stack into the response body", async () => {
    mockedGetDashboardData.mockRejectedValueOnce(new Error("password authentication failed for user \"m3ak\" at 10.0.0.5:5432"));
    const server = await makeServer();

    const response = await server.inject({ method: "GET", url: "/api/dashboard" });

    expect(response.body).not.toMatch(/password|authentication|5432|10\.0\.0\.5/i);
    await server.close();
  });
});

describe("GET /api/dashboard — CORS (25)", () => {
  it("25: allows the local Vite dev origin on localhost", async () => {
    mockedGetDashboardData.mockResolvedValueOnce(SAMPLE_RESPONSE);
    const server = await makeServer();

    const response = await server.inject({
      method: "GET",
      url: "/api/dashboard",
      headers: { origin: "http://localhost:5173" },
    });

    expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(response.headers.vary).toBe("Origin");
    await server.close();
  });

  it("25: allows the local Vite dev origin on 127.0.0.1", async () => {
    mockedGetDashboardData.mockResolvedValueOnce(SAMPLE_RESPONSE);
    const server = await makeServer();

    const response = await server.inject({
      method: "GET",
      url: "/api/dashboard",
      headers: { origin: "http://127.0.0.1:5173" },
    });

    expect(response.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:5173");
    await server.close();
  });

  it("25: allows a same-host LAN demo origin sharing the request host on port 5173", async () => {
    mockedGetDashboardData.mockResolvedValueOnce(SAMPLE_RESPONSE);
    const server = await makeServer();

    const response = await server.inject({
      method: "GET",
      url: "/api/dashboard",
      headers: { origin: "http://192.168.1.50:5173", host: "192.168.1.50:3001" },
    });

    expect(response.headers["access-control-allow-origin"]).toBe("http://192.168.1.50:5173");
    await server.close();
  });

  it("does not allow an unrelated origin, but still sets Vary: Origin", async () => {
    mockedGetDashboardData.mockResolvedValueOnce(SAMPLE_RESPONSE);
    const server = await makeServer();

    const response = await server.inject({
      method: "GET",
      url: "/api/dashboard",
      headers: { origin: "http://evil.example:5173" },
    });

    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(response.headers.vary).toBe("Origin");
    await server.close();
  });

  it("does not allow the frontend hostname on a foreign port", async () => {
    mockedGetDashboardData.mockResolvedValueOnce(SAMPLE_RESPONSE);
    const server = await makeServer();

    const response = await server.inject({
      method: "GET",
      url: "/api/dashboard",
      headers: { origin: "http://localhost:4000" },
    });

    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    await server.close();
  });

  it("never sets Access-Control-Allow-Credentials", async () => {
    mockedGetDashboardData.mockResolvedValueOnce(SAMPLE_RESPONSE);
    const server = await makeServer();

    const response = await server.inject({
      method: "GET",
      url: "/api/dashboard",
      headers: { origin: "http://localhost:5173" },
    });

    expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
    await server.close();
  });

  it("requests without an Origin header succeed and carry no CORS headers", async () => {
    mockedGetDashboardData.mockResolvedValueOnce(SAMPLE_RESPONSE);
    const server = await makeServer();

    const response = await server.inject({ method: "GET", url: "/api/dashboard" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(response.headers.vary).toBeUndefined();
    await server.close();
  });
});
