import { END, START, StateGraph, type BaseCheckpointSaver } from "@langchain/langgraph";
import type { Product } from "@m3ak/shared";
import { loadConversationContext, persistConversation } from "../conversation/conversation";
import { getCustomerMemory } from "../customer/customerMemory";
import { langgraphCheckpointer } from "../infrastructure/langgraphCheckpointer";
import { ExtractionError, extractCustomerRequest } from "../llm/extraction";
import { LlmError } from "../llm/reasoningClient";
import { createEscalation } from "../escalation/escalation";
import { executeAction } from "./actionExecutor";
import {
  createGuardrailEvent,
  emitAgentActivity,
  NOOP_AGENT_ACTIVITY_SINK,
  PUBLIC_TOOL_BY_ACTION,
  type AgentActivitySink,
  type PublicToolAction,
} from "./events";
import { evaluateCommercialGuardrails } from "./guardrails";
import { deriveLastOutcomeOk, OrchestratorError, planNextActions } from "./orchestrator";
import { generateResponse } from "./responder";
import { M3AKStateObjectSchema, M3AKStateSchema, type M3AKState } from "./state";

// TASK-025: a current-conversation language (loaded fresh by TASK-023, just
// below) always wins over durable customer memory. Memory is only a fallback
// when the conversation's own language is still "unknown" AND the memory's
// own preferredLanguage is itself a real, known value — a historical
// preference must never overwrite a fresher signal from the current
// conversation, and "unknown" memory is not real information either way.
function resolveLanguage(
  conversationLanguage: M3AKState["language"],
  customerMemory: M3AKState["customerMemory"],
): M3AKState["language"] {
  if (conversationLanguage !== "unknown") {
    return conversationLanguage;
  }
  if (customerMemory !== null && customerMemory.preferredLanguage !== null && customerMemory.preferredLanguage !== "unknown") {
    return customerMemory.preferredLanguage;
  }
  return conversationLanguage;
}

// TASK-023: rehydrates an EXISTING conversation found by threadId. Never
// creates one (conversations.customer_id is NOT NULL and nothing upstream
// can currently supply a trusted customer identity — TASK-023A §10). Persisted
// history is prepended to whatever messages this invocation was already
// given, never dropped.
//
// TASK-025: once a conversation (and therefore its customerId, always
// non-null per the conversations schema) is resolved, a durable customer
// memory read model is loaded fresh from PostgreSQL every turn — never
// carried over from a stale checkpoint (TASK-024 full-state-reinvoke
// semantics already guarantee this). loadConversationContext()/TASK-023's
// own queries are untouched by this addition.
async function loadContext(state: M3AKState) {
  const result = await loadConversationContext(state.threadId);

  if (!result.found) {
    return {};
  }

  const memoryResult = await getCustomerMemory(result.conversation.customerId);
  const customerMemory = memoryResult.found ? memoryResult.memory : null;

  return {
    conversationId: result.conversation.id,
    customerId: result.conversation.customerId,
    customerMemory,
    language: resolveLanguage(result.conversation.language, customerMemory),
    messages: [
      ...result.messages.map((message) => ({ role: message.role, content: message.content })),
      ...state.messages,
    ],
    cart: result.cart,
    escalationId: result.escalationId,
  };
}

// Searches backward rather than trusting the tail: robust even if a stray
// assistant/merchant message were ever the array's last entry. Mirrors
// responder.ts's own latestCustomerMessage exactly, but not shared across
// modules — this stays a small, self-contained helper like the rest of this
// file's node-local functions.
function latestCustomerMessage(messages: M3AKState["messages"]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "customer") return message.content;
  }
  return null;
}

// TASK-P1: turns the latest raw customer message into structured
// intent/extraction/language via the existing TASK-016 extractor, so the
// planner — whose own payload (orchestrator.ts's PlannerPayload) never
// carries raw message text — has real search/slot criteria to plan from.
// Never decides SEARCH_PRODUCTS or any other action itself, never touches
// activePlan/executedSteps/guardrail state, never mutates messages: that
// remains planNextActions's and the loop's job entirely.
//
// language: the conversation's own already-resolved language (loadContext's
// resolveLanguage already ran before this node) always wins if it is not
// "unknown" — a single ambiguous later message must never override an
// already-established conversation language. Only when it is still
// "unknown" (a brand-new conversation with no persisted language and no
// customerMemory fallback) does this turn's own freshly-inferred language
// get used, exactly mirroring resolveLanguage's own "known beats unknown"
// precedence one tier further down.
//
// extraction: merged, not replaced — a later message that does not restate
// an earlier slot (e.g. size after color was already given) must not erase
// what a prior turn already captured (spec.md AC-01: "demander uniquement
// les informations manquantes").
async function conversation(state: M3AKState): Promise<Partial<M3AKState>> {
  const customerMessage = latestCustomerMessage(state.messages);
  if (customerMessage === null) {
    return {};
  }

  try {
    const extracted = await extractCustomerRequest(customerMessage);
    return {
      intent: extracted.intent,
      language: state.language !== "unknown" ? state.language : extracted.language,
      extraction: {
        productQuery: extracted.productQuery ?? state.extraction.productQuery,
        family: extracted.family ?? state.extraction.family,
        color: extracted.color ?? state.extraction.color,
        size: extracted.size ?? state.extraction.size,
        quantity: extracted.quantity ?? state.extraction.quantity,
        city: extracted.city ?? state.extraction.city,
        address: extracted.address ?? state.extraction.address,
        paymentMethod: extracted.paymentMethod ?? state.extraction.paymentMethod,
        confirmation: extracted.confirmation ?? state.extraction.confirmation,
        requestedPriceMad: extracted.requestedPriceMad ?? state.extraction.requestedPriceMad,
      },
    };
  } catch (error) {
    // Mirrors planFresh's own established convention exactly: only the
    // expected structural/transport failure classes degrade gracefully into
    // a bounded lastError (never the raw provider error) — anything else is
    // a programmer bug and must propagate unchanged.
    if (error instanceof ExtractionError || error instanceof LlmError) {
      return { lastError: `conversation_extraction_failed: ${error.category}` };
    }
    throw error;
  }
}

// Design decision, not an official sourced value (TASK-020A): no config
// framework exists or is warranted for one variable. Read lazily, only at
// graph-execution time (inside the conditional-edge routing function and
// router's own body), never at buildSalesGraph()/module-load time.
function getMaxAgentSteps(): number {
  const raw = process.env.MAX_AGENT_STEPS?.trim();

  if (!raw) {
    return 6;
  }

  const parsed = Number(raw);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid MAX_AGENT_STEPS: must be a positive integer, got "${raw}"`);
  }

  return parsed;
}

const EXECUTABLE_ACTIONS = new Set<string>([
  "SEARCH_PRODUCTS",
  "CHECK_STOCK",
  "FIND_ALTERNATIVES",
  "CHECK_PROMOTION",
  "CHECK_DELIVERY",
  "CREATE_CART",
  "ADD_TO_CART",
  "UPDATE_CART_ITEM",
  "REMOVE_CART_ITEM",
  "VALIDATE_DISCOUNT",
  "CREATE_ORDER",
]);

function isExecutableAction(value: string | null): value is PublicToolAction {
  return value !== null && EXECUTABLE_ACTIONS.has(value);
}

async function planFresh(state: M3AKState) {
  try {
    const { plan } = await planNextActions(state);
    return { activePlan: plan, nextAction: plan[0] ?? null, lastError: null };
  } catch (error) {
    // Only expected planner/transport failures degrade gracefully into
    // lastError; anything else is a programmer bug and must propagate.
    if (error instanceof OrchestratorError || error instanceof LlmError) {
      return {
        activePlan: [],
        nextAction: null,
        lastError: `orchestrator_planning_failed: ${error.category}`,
      };
    }
    throw error;
  }
}

// TASK-019/020: produces and revises a multi-step plan limited to allowed
// actions, hybrid-bounded: continues an already-valid plan deterministically
// (no LLM call) and only calls planNextActions again (real "révision") when
// the plan is exhausted or the latest tool observation failed.
async function router(state: M3AKState) {
  // TASK-038: once semantic extraction has identified an out-of-domain
  // request, no sales tool or unconstrained response path is appropriate.
  // Route deterministically to the existing persisted human-escalation path,
  // regardless of any stale plan that may exist in the incoming state.
  if (state.intent === "out_of_domain") {
    return {
      activePlan: ["ESCALATE" as const],
      nextAction: "ESCALATE" as const,
      lastError: null,
    };
  }

  if (state.iterationCount >= getMaxAgentSteps()) {
    return {
      nextAction: null,
      lastError: "agent_step_limit_reached",
    };
  }

  const latestOutcomeOk = deriveLastOutcomeOk(state.lastResult);

  if (latestOutcomeOk === false) {
    // The remaining plan was built before this failure and is no longer
    // trustworthy — this is the real revision step. The stale failure is
    // naturally consumed once `tool` writes a fresh lastResult on the next
    // executed step, so no extra "consumed" bookkeeping is needed.
    return planFresh(state);
  }

  if (state.activePlan.length > 0) {
    return {
      nextAction: state.activePlan[0] ?? null,
      lastError: null,
    };
  }

  return planFresh(state);
}

function routeAfterRouter(state: M3AKState): "tool" | "guardrail" {
  if (state.iterationCount >= getMaxAgentSteps()) return "guardrail";
  if (!isExecutableAction(state.nextAction)) return "guardrail";
  return "tool";
}

// Pure execution + bookkeeping: control-flow decisions (limit, terminal,
// empty plan) already happened in router/routeAfterRouter, so tool only ever
// runs when routeAfterRouter has already confirmed a real, dispatchable
// action and remaining budget.
async function tool(state: M3AKState, activitySink: AgentActivitySink) {
  if (!isExecutableAction(state.nextAction)) {
    throw new Error(`tool node reached with a non-executable nextAction: ${String(state.nextAction)}`);
  }
  const action = state.nextAction;
  const publicTool = PUBLIC_TOOL_BY_ACTION[action];

  emitAgentActivity(activitySink, {
    kind: "public",
    event: { type: "agent.tool", tool: publicTool, status: "started" },
  });

  let outcome;
  try {
    outcome = await executeAction(action, state);
  } catch (error) {
    emitAgentActivity(activitySink, {
      kind: "public",
      event: { type: "agent.tool", tool: publicTool, status: "failed" },
    });
    throw error;
  }

  emitAgentActivity(activitySink, {
    kind: "public",
    event: {
      type: "agent.tool",
      tool: publicTool,
      status: "completed",
      outcome: outcome.ok ? "positive" : "negative",
    },
  });

  const patch: Partial<M3AKState> = {
    executedSteps: [...state.executedSteps, action],
    iterationCount: state.iterationCount + 1,
    activePlan: state.activePlan.slice(1),
    // outcome.result is `unknown` by the executor's own contract (TASK-020A),
    // but always real, already-parsed tool return data (or a controlled
    // {reason} object) — genuinely JSON-safe at runtime, just not provable
    // through `unknown` to the type checker.
    lastResult: {
      action,
      ok: outcome.ok,
      result: outcome.result,
      resolvedRef: outcome.resolvedRef,
    } as M3AKState["lastResult"],
  };

  if (outcome.cartPatch) {
    patch.cart = outcome.cartPatch;
  }
  if (outcome.orderId) {
    patch.orderId = outcome.orderId;
  }
  // TASK-035 (AC-03): merges in exactly the same "supplied wins, unstated
  // falls back" shape conversation()'s own extraction merge already uses —
  // never overwrites a slot the customer stated this turn (executeAction
  // itself only ever proposes a patch for a slot it found still null).
  if (outcome.extractionPatch) {
    patch.extraction = { ...state.extraction, ...outcome.extractionPatch };
  }
  // TASK-034: captured once, right when FIND_ALTERNATIVES actually succeeds —
  // never re-derived later from `lastResult`, which a subsequent same-turn
  // action (e.g. a planner-issued re-check of the original ref) is free to
  // overwrite. Only a real {ok:true} outcome ever populates this; a missing-
  // input/negative outcome leaves it at its already-cleared per-turn default.
  if (action === "FIND_ALTERNATIVES" && outcome.ok) {
    const result = outcome.result as { alternatives: Product[] };
    // Mirrors responder.ts's own sanitizeProduct allowlist: a real catalogue
    // row always has color/size, but a product missing either is dropped
    // rather than smuggled through with a fabricated placeholder value.
    patch.alternatives = result.alternatives
      .filter((product): product is Product & { color: string; size: string } =>
        typeof product.color === "string" && typeof product.size === "string",
      )
      .map((product) => ({
        ref: product.ref,
        model: product.model,
        family: product.family,
        color: product.color,
        size: product.size,
        price: product.price,
        stock: product.stock,
      }));
  }

  return patch;
}

// TASK-021: reads the loop's final observation and writes only the four
// guardrail state fields (plus the narrowly-scoped promotion/delivery
// patches) — never touches activePlan/nextAction/executedSteps/etc.
function guardrail(state: M3AKState, activitySink: AgentActivitySink) {
  const decision = evaluateCommercialGuardrails(state);

  emitAgentActivity(activitySink, { kind: "public", event: createGuardrailEvent(decision) });

  const patch: Partial<M3AKState> = {
    authorized: decision.authorized,
    clarificationNeeded: decision.clarificationNeeded,
    humanInterventionNeeded: decision.humanInterventionNeeded,
    guardrailReasons: decision.reasons,
  };

  if ("promotionPatch" in decision) {
    patch.promotion = decision.promotionPatch;
  }
  if ("deliveryPatch" in decision) {
    patch.delivery = decision.deliveryPatch;
  }

  return patch;
}

// TASK-022: creates/replays a human escalation exactly when guardrail set
// humanInterventionNeeded. Reason/summary are derived deterministically from
// already-safe state fields — no LLM, no re-evaluation of guardrails, no
// inspection of customer text.
async function escalation(state: M3AKState, activitySink: AgentActivitySink) {
  if (state.conversationId === null) {
    return { lastError: "escalation_creation_failed: missing_conversation_id" };
  }

  const reason =
    state.guardrailReasons.length > 0 ? state.guardrailReasons.join(", ") : "orchestrator_requested_escalation";

  const contextSummary =
    `intent=${state.intent}; ` +
    `executedSteps=[${state.executedSteps.join(",")}]; ` +
    `guardrailReasons=[${state.guardrailReasons.join(",")}]; ` +
    `lastError=${state.lastError ?? "none"}`;

  emitAgentActivity(activitySink, {
    kind: "public",
    event: { type: "agent.status", status: "escalating_to_human" },
  });
  const result = await createEscalation(state.conversationId, reason, contextSummary);

  if (!result.created) {
    return { lastError: `escalation_creation_failed: ${result.reason}` };
  }

  emitAgentActivity(activitySink, { kind: "escalation_created" });
  return { escalationId: result.escalation.id };
}

function routeAfterGuardrail(state: M3AKState): "escalation" | "response" {
  return state.humanInterventionNeeded ? "escalation" : "response";
}

// TASK-023: persists the final conversational state. Skips (never fabricates
// an ID) when no conversation was ever loaded/established this turn.
// TASK-023B: runs last in the topology, so it must never overwrite an
// already-present upstream lastError (escalation/orchestrator/step-limit) —
// a controlled persistence skip/failure is only recorded when no earlier
// node has already reported something more important. Unexpected thrown
// DB/programmer errors are never caught here and still propagate as-is.
async function persist(state: M3AKState, activitySink: AgentActivitySink) {
  if (state.conversationId === null) {
    if (state.lastError !== null) {
      return {};
    }
    return { lastError: "conversation_persistence_skipped: missing_conversation_id" };
  }

  emitAgentActivity(activitySink, {
    kind: "public",
    event: { type: "agent.status", status: "saving_conversation" },
  });
  const result = await persistConversation(
    state.conversationId,
    state.language,
    state.escalationId !== null,
    state.messages,
  );

  if (!result.persisted) {
    if (state.lastError !== null) {
      return {};
    }
    return { lastError: `conversation_persistence_failed: ${result.reason}` };
  }

  return {};
}

// BLOCKER-R1: turns already-computed, guardrail-approved state into a
// grounded customer-facing assistant message via the responder module. Never
// executes a tool, never re-derives guardrail authorization — mode/evidence
// are supplied by generateResponse() reading only already-approved state. A
// successful response must never blindly clear an existing meaningful
// lastError (e.g. a failed escalation write): lastError is only patched when
// the responder itself returns one.
async function response(state: M3AKState): Promise<Partial<M3AKState>> {
  const result = await generateResponse(state);

  if (result.content === null) {
    return result.lastError !== undefined ? { lastError: result.lastError } : {};
  }

  const patch: Partial<M3AKState> = {
    messages: [...state.messages, { role: "assistant", content: result.content }],
  };
  if (result.lastError !== undefined) {
    patch.lastError = result.lastError;
  }
  return patch;
}

// Uncompiled builder: topology only, no side effects. compileSalesGraph()
// compiles this same builder with a checkpointer without touching node/edge
// wiring (TASK-024).
export function buildSalesGraph(activitySink: AgentActivitySink = NOOP_AGENT_ACTIVITY_SINK) {
  return new StateGraph(M3AKStateObjectSchema)
    .addNode("loadContext", (state) => {
      emitAgentActivity(activitySink, {
        kind: "public",
        event: { type: "agent.status", status: "loading_context" },
      });
      return loadContext(state);
    })
    .addNode("conversation", (state) => conversation(state))
    .addNode("router", (state) => {
      emitAgentActivity(activitySink, {
        kind: "public",
        event: { type: "agent.status", status: "planning" },
      });
      return router(state);
    })
    .addNode("tool", (state) => tool(state, activitySink))
    .addNode("guardrail", (state) => guardrail(state, activitySink))
    .addNode("escalation", (state) => escalation(state, activitySink))
    .addNode("response", (state) => response(state))
    .addNode("persist", (state) => persist(state, activitySink))
    .addEdge(START, "loadContext")
    .addEdge("loadContext", "conversation")
    .addEdge("conversation", "router")
    .addConditionalEdges("router", routeAfterRouter, { tool: "tool", guardrail: "guardrail" })
    .addEdge("tool", "router")
    .addConditionalEdges("guardrail", routeAfterGuardrail, { escalation: "escalation", response: "response" })
    .addEdge("escalation", "response")
    .addEdge("response", "persist")
    .addEdge("persist", END);
}

// TASK-024: defaults to the production PostgreSQL checkpointer singleton;
// tests inject a MemorySaver (or a mock) instead — never a second production
// checkpointer/pool.
export function compileSalesGraph(
  checkpointer: BaseCheckpointSaver = langgraphCheckpointer,
  activitySink: AgentActivitySink = NOOP_AGENT_ACTIVITY_SINK,
) {
  return buildSalesGraph(activitySink).compile({ checkpointer });
}

// M3AKStateObjectSchema (used above for LangGraph channel construction) does
// not reproduce M3AKStateSchema's whole-root JSON-safety boundary, so both
// entry and exit are validated explicitly through the outer schema here.
//
// TASK-024: an ordinary invoke is always a NEW business turn — the full,
// fresh M3AKState is transmitted every time (never a partial/delta state),
// and state.threadId is transmitted as configurable.thread_id so the run is
// checkpointed under the conversation's own LangGraph thread. This is not
// the interrupted-run resume path — see resumeInterruptedSalesGraph below.
export async function invokeSalesGraph(input: unknown): Promise<M3AKState> {
  const validatedInput = M3AKStateSchema.parse(input);
  const compiled = compileSalesGraph();
  const result = await compiled.invoke(validatedInput, {
    configurable: { thread_id: validatedInput.threadId },
  });
  return M3AKStateSchema.parse(result);
}

// TASK-030: same invocation/checkpoint contract as invokeSalesGraph, with a
// synchronous, sanitized observational sink. The sink is defensively isolated
// by emitAgentActivity and cannot change graph business execution.
export async function invokeSalesGraphWithEvents(input: unknown, activitySink: AgentActivitySink): Promise<M3AKState> {
  const validatedInput = M3AKStateSchema.parse(input);
  const compiled = compileSalesGraph(langgraphCheckpointer, activitySink);
  const result = await compiled.invoke(validatedInput, {
    configurable: { thread_id: validatedInput.threadId },
  });
  return M3AKStateSchema.parse(result);
}

// TASK-024: resumes a run that was interrupted mid-execution (e.g. a process
// restart) on the SAME thread_id — this is never a new business turn, so it
// deliberately takes only a threadId, never messages/conversationId/cart/
// intent/etc: a partial/delta business state is explicitly out of scope.
// Passing `null` as input (proven empirically, TASK-024C) makes LangGraph
// skip START and re-enter the last incomplete task directly, restoring
// whatever channel values the interrupted run's already-completed steps had
// checkpointed. A missing/never-started checkpoint or a genuine checkpointer/
// DB/programmer error is never caught here — it propagates unchanged, exactly
// like invokeSalesGraph.
export async function resumeInterruptedSalesGraph(rawThreadId: unknown): Promise<M3AKState> {
  const threadId = M3AKStateObjectSchema.shape.threadId.parse(rawThreadId);
  const compiled = compileSalesGraph();
  const result = await compiled.invoke(null, {
    configurable: { thread_id: threadId },
  });
  return M3AKStateSchema.parse(result);
}
