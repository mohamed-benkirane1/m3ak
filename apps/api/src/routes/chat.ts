import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  MAX_AGENT_EVENT_BATCH_SIZE,
  persistAgentEvents,
  toDurableAgentEventRecords,
  toPublicAgentEvent,
  type AgentActivitySink,
  type DurableAgentEventRecord,
  type PublicAgentEvent,
} from "../agent/events";
import { invokeSalesGraphWithEvents } from "../agent/graph";
import { M3AKStateSchema, type M3AKState } from "../agent/state";
import { createChatSession, CustomerRefSchema, type CreateChatSessionResult } from "../conversation/chatSession";

const ChatQuerySchema = z.object({ customerRef: CustomerRefSchema }).strict();
const IncomingMessageSchema = z
  .object({
    type: z.literal("message"),
    content: z.string().trim().min(1).max(4_000),
  })
  .strict();

type ErrorCode =
  | "invalid_payload"
  | "customer_not_found"
  | "busy"
  | "graph_error"
  | "no_assistant_response"
  | "session_error";

interface ErrorEnvelope {
  type: "agent.error";
  code: ErrorCode;
  message: string;
}

function createFreshState(threadId: string, content: string): M3AKState {
  return M3AKStateSchema.parse({
    threadId,
    conversationId: null,
    customerId: null,
    customerMemory: null,
    messages: [{ role: "customer", content }],
    summary: null,
    language: "unknown",
    intent: "unknown",
    extraction: {
      productQuery: null,
      family: null,
      color: null,
      size: null,
      quantity: null,
      city: null,
      address: null,
      paymentMethod: null,
      confirmation: null,
      requestedPriceMad: null,
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
  });
}

function parseIncomingMessage(data: unknown, isBinary: boolean): z.infer<typeof IncomingMessageSchema> | null {
  if (isBinary || !Buffer.isBuffer(data)) {
    return null;
  }

  try {
    const json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
    const parsed = IncomingMessageSchema.safeParse(json);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function newestAssistantContent(result: M3AKState): string | null {
  const lastMessage = result.messages.at(-1);
  if (lastMessage?.role !== "assistant" || lastMessage.content.trim().length === 0) {
    return null;
  }
  return lastMessage.content;
}

export function registerChatRoute(server: FastifyInstance): void {
  server.get("/ws/chat", { websocket: true }, (socket, request) => {
    const query = ChatQuerySchema.safeParse(request.query);

    const sendError = (code: ErrorCode, message: string): void => {
      if (socket.readyState !== 1) return;
      const envelope: ErrorEnvelope = { type: "agent.error", code, message };
      socket.send(JSON.stringify(envelope));
    };

    const sendActivity = (event: PublicAgentEvent): void => {
      if (socket.readyState !== 1) return;
      try {
        socket.send(JSON.stringify(event));
      } catch {
        request.log.warn({ eventType: event.type }, "public agent activity delivery failed");
      }
    };

    if (!query.success) {
      sendError("invalid_payload", "A valid customerRef query parameter is required.");
      socket.close(1008, "Invalid customerRef");
      return;
    }

    const customerRef = query.data.customerRef;
    let sessionPromise: Promise<CreateChatSessionResult> | null = null;
    let busy = false;

    const getSession = (): Promise<CreateChatSessionResult> => {
      if (sessionPromise === null) {
        const pending = createChatSession(customerRef);
        sessionPromise = pending;
        void pending.catch(() => {
          if (sessionPromise === pending) sessionPromise = null;
        });
      }
      return sessionPromise;
    };

    socket.on("message", (data, isBinary) => {
      const incoming = parseIncomingMessage(data, isBinary);
      if (incoming === null) {
        sendError("invalid_payload", "Message payload must be valid text JSON with type and content only.");
        return;
      }

      if (busy) {
        sendError("busy", "Please wait for the current message to finish processing.");
        return;
      }

      busy = true;
      void (async () => {
        let auditConversationId: string | null = null;
        const auditRecords: DurableAgentEventRecord[] = [];
        try {
          let session: CreateChatSessionResult;
          try {
            session = await getSession();
          } catch (error) {
            request.log.error({ err: error }, "chat session creation failed");
            sendError("session_error", "The chat session could not be created. Please try again.");
            return;
          }

          if (!session.created) {
            sendError("customer_not_found", "The selected customer was not found.");
            socket.close(1008, "Unknown customer");
            return;
          }

          auditConversationId = session.conversationId;
          const activitySink: AgentActivitySink = (activity) => {
            const publicEvent = toPublicAgentEvent(activity);
            if (publicEvent !== null) sendActivity(publicEvent);

            const records = toDurableAgentEventRecords(activity);
            const remainingCapacity = MAX_AGENT_EVENT_BATCH_SIZE - auditRecords.length;
            if (records.length <= remainingCapacity) {
              auditRecords.push(...records);
            } else {
              request.log.warn("agent activity audit batch capacity reached");
            }
          };

          let result: M3AKState;
          try {
            result = await invokeSalesGraphWithEvents(
              createFreshState(session.threadId, incoming.content),
              activitySink,
            );
          } catch (error) {
            request.log.error(
              { err: error, conversationId: session.conversationId, threadId: session.threadId },
              "sales graph invocation failed",
            );
            sendError("graph_error", "The assistant could not process this message. Please try again.");
            return;
          }

          const content = newestAssistantContent(result);
          if (content === null) {
            request.log.error(
              { conversationId: session.conversationId, threadId: session.threadId },
              "sales graph returned no new assistant response",
            );
            sendError("no_assistant_response", "The assistant did not produce a response.");
            return;
          }

          if (socket.readyState === 1) {
            socket.send(JSON.stringify({ type: "agent.message", content }));
          }
        } catch (error) {
          request.log.error({ err: error }, "unexpected chat message processing failure");
          sendError("graph_error", "The assistant could not process this message. Please try again.");
        } finally {
          if (auditConversationId !== null && auditRecords.length > 0) {
            try {
              await persistAgentEvents(auditConversationId, auditRecords);
            } catch (error) {
              request.log.error({ err: error }, "agent activity audit persistence failed");
            }
          }
          busy = false;
        }
      })();
    });
  });
}
