import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../agent/graph", () => ({
  invokeSalesGraph: vi.fn(),
}));

vi.mock("../conversation/chatSession", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../conversation/chatSession")>();
  return { ...actual, createChatSession: vi.fn() };
});

import websocketPlugin from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { invokeSalesGraph } from "../agent/graph";
import type { M3AKState } from "../agent/state";
import { createChatSession } from "../conversation/chatSession";
import { registerChatRoute } from "./chat";

const mockedInvokeSalesGraph = vi.mocked(invokeSalesGraph);
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
  mockedInvokeSalesGraph.mockImplementationOnce(async (input) => {
    const state = input as M3AKState;
    return { ...state, messages: [...state.messages, { role: "assistant", content }] };
  });
}

function sendMessage(socket: WebSocket, content = "Salam"): void {
  socket.send(JSON.stringify({ type: "message", content }));
}

beforeEach(() => {
  mockedCreateChatSession.mockResolvedValue(SESSION);
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
    expect(mockedInvokeSalesGraph).not.toHaveBeenCalled();
  });

  it("4: reports an unknown customer without invoking the graph", async () => {
    mockedCreateChatSession.mockResolvedValueOnce({ created: false, reason: "customer_not_found" });
    const client = await connect(await makeServer());
    sendMessage(client.ws);

    await expect(client.nextJson()).resolves.toMatchObject({ type: "agent.error", code: "customer_not_found" });
    expect(mockedInvokeSalesGraph).not.toHaveBeenCalled();
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
    expect(mockedInvokeSalesGraph).not.toHaveBeenCalled();
  });

  it("7: rejects binary frames without invoking the graph", async () => {
    const client = await connect(await makeServer());
    client.ws.send(Buffer.from('{"type":"message","content":"hi"}'), { binary: true });

    await expect(client.nextJson()).resolves.toMatchObject({ type: "agent.error", code: "invalid_payload" });
    expect(mockedInvokeSalesGraph).not.toHaveBeenCalled();
  });
});

describe("/ws/chat session and graph integration", () => {
  it("12/13/17/18/19/20/21: lazily creates a session, builds full fresh state, and returns the newest assistant reply", async () => {
    const client = await connect(await makeServer());
    expect(mockedCreateChatSession).not.toHaveBeenCalled();

    sendMessage(client.ws, "  Bghit veste  ");
    await expect(client.nextJson()).resolves.toEqual({ type: "agent.message", content: "Marhba!" });

    expect(mockedCreateChatSession).toHaveBeenCalledExactlyOnceWith("KENZA-001");
    expect(mockedInvokeSalesGraph).toHaveBeenCalledTimes(1);
    expect(mockedInvokeSalesGraph).toHaveBeenCalledWith({
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
    });
  });

  it("14: reuses one session for later messages on the same socket", async () => {
    const client = await connect(await makeServer());
    sendMessage(client.ws, "one");
    await client.nextJson();
    replyWith("Second reply");
    sendMessage(client.ws, "two");
    await expect(client.nextJson()).resolves.toEqual({ type: "agent.message", content: "Second reply" });

    expect(mockedCreateChatSession).toHaveBeenCalledTimes(1);
    expect(mockedInvokeSalesGraph).toHaveBeenCalledTimes(2);
    expect((mockedInvokeSalesGraph.mock.calls[1]?.[0] as M3AKState).threadId).toBe(SESSION.threadId);
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
    expect((mockedInvokeSalesGraph.mock.calls[0]?.[0] as M3AKState).threadId).toBe(SESSION.threadId);
    expect((mockedInvokeSalesGraph.mock.calls[1]?.[0] as M3AKState).threadId).toBe("thread-2");
  });

  it("16: retries session creation after a transient rejection", async () => {
    mockedCreateChatSession.mockRejectedValueOnce(new Error("temporary SQL failure")).mockResolvedValueOnce(SESSION);
    const client = await connect(await makeServer());
    sendMessage(client.ws, "one");
    await expect(client.nextJson()).resolves.toMatchObject({ type: "agent.error", code: "session_error" });
    sendMessage(client.ws, "two");
    await expect(client.nextJson()).resolves.toEqual({ type: "agent.message", content: "Marhba!" });

    expect(mockedCreateChatSession).toHaveBeenCalledTimes(2);
    expect(mockedInvokeSalesGraph).toHaveBeenCalledTimes(1);
  });
});

describe("/ws/chat output, failures, and concurrency", () => {
  it("22/23: never falls back to an old assistant message", async () => {
    mockedInvokeSalesGraph.mockReset();
    mockedInvokeSalesGraph.mockImplementationOnce(async (input) => {
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
    mockedInvokeSalesGraph.mockReset();
    mockedInvokeSalesGraph.mockRejectedValueOnce(new Error("secret database stack detail"));
    const client = await connect(await makeServer());
    sendMessage(client.ws);

    const response = await client.nextJson();
    expect(response).toMatchObject({ type: "agent.error", code: "graph_error" });
    expect(JSON.stringify(response)).not.toContain("secret database stack detail");
  });

  it("26/27/28/29: enforces one active graph call per connection and clears busy in finally", async () => {
    mockedInvokeSalesGraph.mockReset();
    let releaseFirst!: (state: M3AKState) => void;
    mockedInvokeSalesGraph.mockImplementationOnce(
      (input) => new Promise<M3AKState>((resolve) => {
        const state = input as M3AKState;
        releaseFirst = () => resolve({ ...state, messages: [...state.messages, { role: "assistant", content: "first" }] });
      }),
    );
    const client = await connect(await makeServer());
    sendMessage(client.ws, "first");
    sendMessage(client.ws, "second");

    await expect(client.nextJson()).resolves.toMatchObject({ type: "agent.error", code: "busy" });
    expect(mockedInvokeSalesGraph).toHaveBeenCalledTimes(1);

    releaseFirst({} as M3AKState);
    await expect(client.nextJson()).resolves.toEqual({ type: "agent.message", content: "first" });
    replyWith("third");
    sendMessage(client.ws, "third");
    await expect(client.nextJson()).resolves.toEqual({ type: "agent.message", content: "third" });
    expect(mockedInvokeSalesGraph).toHaveBeenCalledTimes(2);
  });

  it("disconnect does not cancel an already-started graph invocation", async () => {
    mockedInvokeSalesGraph.mockReset();
    let resolveGraph!: (state: M3AKState) => void;
    const completed = new Promise<void>((resolve) => {
      mockedInvokeSalesGraph.mockImplementationOnce(
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
    await vi.waitFor(() => expect(mockedInvokeSalesGraph).toHaveBeenCalledTimes(1));
    client.ws.terminate();
    const state = mockedInvokeSalesGraph.mock.calls[0]?.[0] as M3AKState;
    resolveGraph({ ...state, messages: [...state.messages, { role: "assistant", content: "done" }] });
    await completed;

    expect(mockedInvokeSalesGraph).toHaveBeenCalledTimes(1);
  });
});
