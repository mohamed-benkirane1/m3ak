import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../agent/graph", () => ({
  invokeSalesGraphWithEvents: vi.fn(),
}));

vi.mock("../agent/events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agent/events")>();
  return { ...actual, persistAgentEvents: vi.fn() };
});

vi.mock("../conversation/chatSession", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../conversation/chatSession")>();
  return { ...actual, createChatSession: vi.fn() };
});

import websocketPlugin from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { persistAgentEvents, type AgentActivitySink } from "../agent/events";
import { invokeSalesGraphWithEvents } from "../agent/graph";
import type { M3AKState } from "../agent/state";
import { createChatSession } from "../conversation/chatSession";
import { registerChatRoute } from "./chat";

const mockedInvokeSalesGraphWithEvents = vi.mocked(invokeSalesGraphWithEvents);
const mockedPersistAgentEvents = vi.mocked(persistAgentEvents);
const mockedCreateChatSession = vi.mocked(createChatSession);

const SESSION = {
  created: true as const,
  conversationId: "11111111-1111-4111-8111-111111111111",
  customerId: "22222222-2222-4222-8222-222222222222",
  threadId: "33333333-3333-4333-8333-333333333333",
};

interface TestSocket {
  ws: WebSocket;
  nextJson(): Promise<Record<string, unknown>>;
}

const servers: FastifyInstance[] = [];
const sockets: WebSocket[] = [];

async function makeServer(): Promise<FastifyInstance> {
  const server = Fastify({ logger: false });
  servers.push(server);
  await server.register(websocketPlugin, { options: { maxPayload: 64 * 1024 } });
  registerChatRoute(server);
  await server.ready();
  return server;
}

async function connect(server: FastifyInstance, path = "/ws/chat?customerRef=KENZA-001"): Promise<TestSocket> {
  const queued: Record<string, unknown>[] = [];
  const waiters: Array<(value: Record<string, unknown>) => void> = [];
  const ws = await server.injectWS(path, {}, {
    onInit(client) {
      client.on("message", (data) => {
        const value = JSON.parse(data.toString()) as Record<string, unknown>;
        const waiter = waiters.shift();
        if (waiter) waiter(value);
        else queued.push(value);
      });
    },
  });
  sockets.push(ws);
  return {
    ws,
    nextJson: () => {
      const value = queued.shift();
      return value ? Promise.resolve(value) : new Promise((resolve) => waiters.push(resolve));
    },
  };
}

function replyWith(content: string) {
  mockedInvokeSalesGraphWithEvents.mockImplementationOnce(async (input) => {
    const state = input as M3AKState;
    return { ...state, messages: [...state.messages, { role: "assistant", content }] };
  });
}

function replyWithActivities(
  content: string,
  emit: (sink: AgentActivitySink) => void,
): void {
  mockedInvokeSalesGraphWithEvents.mockImplementationOnce(async (input, sink) => {
    emit(sink);
    const state = input as M3AKState;
    return { ...state, messages: [...state.messages, { role: "assistant", content }] };
  });
}

function sendMessage(socket: WebSocket, content = "Salam"): void {
  socket.send(JSON.stringify({ type: "message", content }));
}

beforeEach(() => {
  mockedCreateChatSession.mockResolvedValue(SESSION);
  mockedPersistAgentEvents.mockResolvedValue();
  replyWith("Marhba!");
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.all(servers.splice(0).map((server) => server.close()));
  vi.resetAllMocks();
});

describe("/ws/chat connection and input protocol", () => {
  it("1: exists and upgrades", async () => {
    const client = await connect(await makeServer());
    expect(client.ws.readyState).toBe(1);
    expect(mockedCreateChatSession).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", "/ws/chat"],
    ["empty", "/ws/chat?customerRef=%20%20"],
    ["unknown query field", "/ws/chat?customerRef=KENZA-001&threadId=forged"],
  ])("2/3/5: rejects %s customer query safely", async (_label, path) => {
    const client = await connect(await makeServer(), path);
    await expect(client.nextJson()).resolves.toMatchObject({ type: "agent.error", code: "invalid_payload" });
    expect(mockedCreateChatSession).not.toHaveBeenCalled();
    expect(mockedInvokeSalesGraphWithEvents).not.toHaveBeenCalled();
  });

  it("4: reports an unknown customer without invoking the graph", async () => {
    mockedCreateChatSession.mockResolvedValueOnce({ created: false, reason: "customer_not_found" });
    const client = await connect(await makeServer());
    sendMessage(client.ws);

    await expect(client.nextJson()).resolves.toMatchObject({ type: "agent.error", code: "customer_not_found" });
    expect(mockedInvokeSalesGraphWithEvents).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed JSON", "{"],
    ["non-object JSON", "null"],
    ["whitespace", JSON.stringify({ type: "message", content: "   " })],
    ["too long", JSON.stringify({ type: "message", content: "x".repeat(4_001) })],
    ["unknown field", JSON.stringify({ type: "message", content: "hi", language: "french" })],
    ["forged state", JSON.stringify({ type: "message", content: "hi", conversationId: "forged" })],
    ["unknown type", JSON.stringify({ type: "command", content: "hi" })],
  ])("6/8/9/10/11: %s -> invalid_payload", async (_label, payload) => {
    const client = await connect(await makeServer());
    client.ws.send(payload);

    await expect(client.nextJson()).resolves.toMatchObject({ type: "agent.error", code: "invalid_payload" });
    expect(mockedCreateChatSession).not.toHaveBeenCalled();
    expect(mockedInvokeSalesGraphWithEvents).not.toHaveBeenCalled();
  });

  it("7: rejects binary frames without invoking the graph", async () => {
    const client = await connect(await makeServer());
    client.ws.send(Buffer.from('{"type":"message","content":"hi"}'), { binary: true });

    await expect(client.nextJson()).resolves.toMatchObject({ type: "agent.error", code: "invalid_payload" });
    expect(mockedInvokeSalesGraphWithEvents).not.toHaveBeenCalled();
  });
});

describe("/ws/chat session and graph integration", () => {
  it("12/13/17/18/19/20/21: lazily creates a session, builds full fresh state, and returns the newest assistant reply", async () => {
    const client = await connect(await makeServer());
    expect(mockedCreateChatSession).not.toHaveBeenCalled();

    sendMessage(client.ws, "  Bghit veste  ");
    await expect(client.nextJson()).resolves.toEqual({ type: "agent.message", content: "Marhba!" });

    expect(mockedCreateChatSession).toHaveBeenCalledExactlyOnceWith("KENZA-001");
    expect(mockedInvokeSalesGraphWithEvents).toHaveBeenCalledTimes(1);
    expect(mockedInvokeSalesGraphWithEvents).toHaveBeenCalledWith({
      threadId: SESSION.threadId,
      conversationId: null,
      customerId: null,
      customerMemory: null,
      messages: [{ role: "customer", content: "Bghit veste" }],
      summary: null,
      language: "unknown",
      intent: "unknown",
      extraction: {
        productQuery: null, family: null, color: null, size: null, quantity: null,
        city: null, address: null, paymentMethod: null, confirmation: null,
      },
      cart: null,
      promotion: null,
      delivery: null,
      alternatives: [],
      cartTotalCents: null,
      nextAction: null,
      activePlan: [],
      executedSteps: [],
      iterationCount: 0,
      lastResult: null,
      lastError: null,
      authorized: null,
      clarificationNeeded: false,
      humanInterventionNeeded: false,
      guardrailReasons: [],
      orderId: null,
      escalationId: null,
      followupId: null,
    }, expect.any(Function));
  });

  it("14: reuses one session for later messages on the same socket", async () => {
    const client = await connect(await makeServer());
    sendMessage(client.ws, "one");
    await client.nextJson();
    replyWith("Second reply");
    sendMessage(client.ws, "two");
    await expect(client.nextJson()).resolves.toEqual({ type: "agent.message", content: "Second reply" });

    expect(mockedCreateChatSession).toHaveBeenCalledTimes(1);
    expect(mockedInvokeSalesGraphWithEvents).toHaveBeenCalledTimes(2);
    expect((mockedInvokeSalesGraphWithEvents.mock.calls[1]?.[0] as M3AKState).threadId).toBe(SESSION.threadId);
  });

  it("15: two sockets for one customer receive different server-issued threads", async () => {
    const secondSession = { ...SESSION, conversationId: "conversation-2", threadId: "thread-2" };
    mockedCreateChatSession.mockResolvedValueOnce(SESSION).mockResolvedValueOnce(secondSession);
    const server = await makeServer();
    const first = await connect(server);
    const second = await connect(server);

    sendMessage(first.ws, "one");
    await first.nextJson();
    replyWith("two");
    sendMessage(second.ws, "two");
    await second.nextJson();

    expect(mockedCreateChatSession).toHaveBeenCalledTimes(2);
    expect((mockedInvokeSalesGraphWithEvents.mock.calls[0]?.[0] as M3AKState).threadId).toBe(SESSION.threadId);
    expect((mockedInvokeSalesGraphWithEvents.mock.calls[1]?.[0] as M3AKState).threadId).toBe("thread-2");
  });

  it("16: retries session creation after a transient rejection", async () => {
    mockedCreateChatSession.mockRejectedValueOnce(new Error("temporary SQL failure")).mockResolvedValueOnce(SESSION);
    const client = await connect(await makeServer());
    sendMessage(client.ws, "one");
    await expect(client.nextJson()).resolves.toMatchObject({ type: "agent.error", code: "session_error" });
    sendMessage(client.ws, "two");
    await expect(client.nextJson()).resolves.toEqual({ type: "agent.message", content: "Marhba!" });

    expect(mockedCreateChatSession).toHaveBeenCalledTimes(2);
    expect(mockedInvokeSalesGraphWithEvents).toHaveBeenCalledTimes(1);
  });
});

describe("/ws/chat output, failures, and concurrency", () => {
  it("22/23: never falls back to an old assistant message", async () => {
    mockedInvokeSalesGraphWithEvents.mockReset();
    mockedInvokeSalesGraphWithEvents.mockImplementationOnce(async (input) => {
      const state = input as M3AKState;
      return {
        ...state,
        messages: [
          { role: "assistant", content: "old answer" },
          ...state.messages,
        ],
      };
    });
    const client = await connect(await makeServer());
    sendMessage(client.ws);

    await expect(client.nextJson()).resolves.toMatchObject({ type: "agent.error", code: "no_assistant_response" });
  });

  it("24/25: graph failures produce a safe error without raw technical details", async () => {
    mockedInvokeSalesGraphWithEvents.mockReset();
    mockedInvokeSalesGraphWithEvents.mockRejectedValueOnce(new Error("secret database stack detail"));
    const client = await connect(await makeServer());
    sendMessage(client.ws);

    const response = await client.nextJson();
    expect(response).toMatchObject({ type: "agent.error", code: "graph_error" });
    expect(JSON.stringify(response)).not.toContain("secret database stack detail");
  });

  it("26/27/28/29: enforces one active graph call per connection and clears busy in finally", async () => {
    mockedInvokeSalesGraphWithEvents.mockReset();
    let releaseFirst!: (state: M3AKState) => void;
    mockedInvokeSalesGraphWithEvents.mockImplementationOnce(
      (input) => new Promise<M3AKState>((resolve) => {
        const state = input as M3AKState;
        releaseFirst = () => resolve({ ...state, messages: [...state.messages, { role: "assistant", content: "first" }] });
      }),
    );
    const client = await connect(await makeServer());
    sendMessage(client.ws, "first");
    sendMessage(client.ws, "second");

    await expect(client.nextJson()).resolves.toMatchObject({ type: "agent.error", code: "busy" });
    expect(mockedInvokeSalesGraphWithEvents).toHaveBeenCalledTimes(1);

    releaseFirst({} as M3AKState);
    await expect(client.nextJson()).resolves.toEqual({ type: "agent.message", content: "first" });
    replyWith("third");
    sendMessage(client.ws, "third");
    await expect(client.nextJson()).resolves.toEqual({ type: "agent.message", content: "third" });
    expect(mockedInvokeSalesGraphWithEvents).toHaveBeenCalledTimes(2);
  });

  it("disconnect does not cancel an already-started graph invocation", async () => {
    mockedInvokeSalesGraphWithEvents.mockReset();
    let resolveGraph!: (state: M3AKState) => void;
    const completed = new Promise<void>((resolve) => {
      mockedInvokeSalesGraphWithEvents.mockImplementationOnce(
        (input) => new Promise<M3AKState>((resolveInvocation) => {
          const state = input as M3AKState;
          resolveGraph = (result) => {
            resolveInvocation(result);
            resolve();
          };
        }),
      );
    });
    const client = await connect(await makeServer());
    sendMessage(client.ws);
    await vi.waitFor(() => expect(mockedInvokeSalesGraphWithEvents).toHaveBeenCalledTimes(1));
    client.ws.terminate();
    const state = mockedInvokeSalesGraphWithEvents.mock.calls[0]?.[0] as M3AKState;
    resolveGraph({ ...state, messages: [...state.messages, { role: "assistant", content: "done" }] });
    await completed;

    expect(mockedInvokeSalesGraphWithEvents).toHaveBeenCalledTimes(1);
  });
});

describe("/ws/chat TASK-030 public activity and audit", () => {
  it("delivers status, tool, and guardrail events in natural order before the unchanged final message", async () => {
    mockedInvokeSalesGraphWithEvents.mockReset();
    replyWithActivities("Final reply", (sink) => {
      sink({ kind: "public", event: { type: "agent.status", status: "loading_context" } });
      sink({ kind: "public", event: { type: "agent.tool", tool: "searchProducts", status: "started" } });
      sink({
        kind: "public",
        event: { type: "agent.tool", tool: "searchProducts", status: "completed", outcome: "positive" },
      });
      sink({
        kind: "public",
        event: { type: "agent.guardrail", status: "allowed", categories: [] },
      });
    });
    const client = await connect(await makeServer());
    sendMessage(client.ws);

    await expect(client.nextJson()).resolves.toEqual({ type: "agent.status", status: "loading_context" });
    await expect(client.nextJson()).resolves.toEqual({ type: "agent.tool", tool: "searchProducts", status: "started" });
    await expect(client.nextJson()).resolves.toEqual({
      type: "agent.tool", tool: "searchProducts", status: "completed", outcome: "positive",
    });
    await expect(client.nextJson()).resolves.toEqual({
      type: "agent.guardrail", status: "allowed", categories: [],
    });
    await expect(client.nextJson()).resolves.toEqual({ type: "agent.message", content: "Final reply" });
  });

  it("flushes all projected audit records in one call after a successful turn", async () => {
    mockedInvokeSalesGraphWithEvents.mockReset();
    replyWithActivities("Done", (sink) => {
      sink({ kind: "public", event: { type: "agent.status", status: "planning" } });
      sink({ kind: "public", event: { type: "agent.tool", tool: "createOrder", status: "started" } });
      sink({
        kind: "public",
        event: { type: "agent.tool", tool: "createOrder", status: "completed", outcome: "positive" },
      });
      sink({ kind: "escalation_created" });
    });
    const client = await connect(await makeServer());
    sendMessage(client.ws);
    for (let index = 0; index < 3; index += 1) await client.nextJson();
    await expect(client.nextJson()).resolves.toEqual({ type: "agent.message", content: "Done" });
    await vi.waitFor(() => expect(mockedPersistAgentEvents).toHaveBeenCalledTimes(1));

    expect(mockedPersistAgentEvents).toHaveBeenCalledWith(SESSION.conversationId, [
      { eventType: "node_started", payload: { stage: "planning" } },
      { eventType: "tool_called", payload: { tool: "createOrder" } },
      { eventType: "tool_succeeded", payload: { tool: "createOrder", outcome: "positive" } },
      { eventType: "order_created", payload: {} },
      { eventType: "escalation_created", payload: {} },
    ]);
  });

  it("flushes collected records after graph failure while preserving the safe graph_error", async () => {
    mockedInvokeSalesGraphWithEvents.mockReset();
    mockedInvokeSalesGraphWithEvents.mockImplementationOnce(async (_input, sink) => {
      sink({ kind: "public", event: { type: "agent.tool", tool: "getAvailability", status: "failed" } });
      throw new Error("private technical detail");
    });
    const client = await connect(await makeServer());
    sendMessage(client.ws);

    await expect(client.nextJson()).resolves.toEqual({
      type: "agent.tool", tool: "getAvailability", status: "failed",
    });
    const terminal = await client.nextJson();
    expect(terminal).toMatchObject({ type: "agent.error", code: "graph_error" });
    expect(JSON.stringify(terminal)).not.toContain("private technical detail");
    await vi.waitFor(() => expect(mockedPersistAgentEvents).toHaveBeenCalledWith(SESSION.conversationId, [
      { eventType: "tool_failed", payload: { tool: "getAvailability" } },
    ]));
  });

  it("a synchronous activity send failure does not alter graph completion", async () => {
    mockedInvokeSalesGraphWithEvents.mockReset();
    replyWithActivities("Still succeeds", (sink) => {
      sink({ kind: "public", event: { type: "agent.status", status: "planning" } });
    });
    const server = await makeServer();
    const client = await connect(server);
    const serverSocket = [...server.websocketServer.clients][0];
    if (!serverSocket) throw new Error("expected injected server socket");
    vi.spyOn(serverSocket, "send").mockImplementationOnce(() => {
      throw new Error("socket delivery failed");
    });
    sendMessage(client.ws);

    await expect(client.nextJson()).resolves.toEqual({ type: "agent.message", content: "Still succeeds" });
    expect(mockedInvokeSalesGraphWithEvents).toHaveBeenCalledTimes(1);
  });

  it("audit persistence failure does not replace the terminal business result", async () => {
    mockedInvokeSalesGraphWithEvents.mockReset();
    mockedPersistAgentEvents.mockRejectedValueOnce(new Error("audit database unavailable"));
    replyWithActivities("Business result", (sink) => {
      sink({ kind: "public", event: { type: "agent.status", status: "planning" } });
    });
    const client = await connect(await makeServer());
    sendMessage(client.ws);

    await client.nextJson();
    await expect(client.nextJson()).resolves.toEqual({ type: "agent.message", content: "Business result" });
    await vi.waitFor(() => expect(mockedPersistAgentEvents).toHaveBeenCalledTimes(1));
    expect(mockedInvokeSalesGraphWithEvents).toHaveBeenCalledTimes(1);
  });

  it("keeps the per-connection busy flag active through the final audit flush", async () => {
    mockedInvokeSalesGraphWithEvents.mockReset();
    replyWithActivities("First result", (sink) => {
      sink({ kind: "public", event: { type: "agent.status", status: "planning" } });
    });
    let releaseAudit!: () => void;
    mockedPersistAgentEvents.mockImplementationOnce(
      () => new Promise<void>((resolve) => { releaseAudit = resolve; }),
    );
    const client = await connect(await makeServer());
    sendMessage(client.ws, "first");
    await client.nextJson();
    await expect(client.nextJson()).resolves.toEqual({ type: "agent.message", content: "First result" });
    await vi.waitFor(() => expect(mockedPersistAgentEvents).toHaveBeenCalledTimes(1));

    sendMessage(client.ws, "while auditing");
    await expect(client.nextJson()).resolves.toMatchObject({ type: "agent.error", code: "busy" });
    expect(mockedInvokeSalesGraphWithEvents).toHaveBeenCalledTimes(1);

    releaseAudit();
    await new Promise<void>((resolve) => setImmediate(resolve));
    replyWith("After audit");
    sendMessage(client.ws, "after auditing");
    await expect(client.nextJson()).resolves.toEqual({ type: "agent.message", content: "After audit" });
    expect(mockedInvokeSalesGraphWithEvents).toHaveBeenCalledTimes(2);
  });
});
