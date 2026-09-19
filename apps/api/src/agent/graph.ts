import { END, START, StateGraph, type BaseCheckpointSaver } from "@langchain/langgraph";
import { loadConversationContext, persistConversation } from "../conversation/conversation";
import { langgraphCheckpointer } from "../infrastructure/langgraphCheckpointer";
import { LlmError } from "../llm/reasoningClient";
import { createEscalation } from "../escalation/escalation";
import { executeAction } from "./actionExecutor";
import { evaluateCommercialGuardrails } from "./guardrails";
import { type AllowedAction, deriveLastOutcomeOk, OrchestratorError, planNextActions } from "./orchestrator";
import { M3AKStateObjectSchema, M3AKStateSchema, type M3AKState } from "./state";

// Every TASK-018 node is a structural no-op: it proves graph topology only.
// Real node behavior belongs to later tasks (see design.md §7, tasks.md §8-9).
function noop(_state: M3AKState) {
  return {};
}

// TASK-023: rehydrates an EXISTING conversation found by threadId. Never
// creates one (conversations.customer_id is NOT NULL and nothing upstream
// can currently supply a trusted customer identity — TASK-023A §10). Persisted
// history is prepended to whatever messages this invocation was already
// given, never dropped.
async function loadContext(state: M3AKState) {
  const result = await loadConversationContext(state.threadId);

  if (!result.found) {
    return {};
  }

  return {
    conversationId: result.conversation.id,
    customerId: result.conversation.customerId,
    language: result.conversation.language,
    messages: [
      ...result.messages.map((message) => ({ role: message.role, content: message.content })),
      ...state.messages,
    ],
    cart: result.cart,
    escalationId: result.escalationId,
  };
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
  "CREATE_ORDER",
]);

function isExecutableAction(value: string | null): value is AllowedAction {
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
async function tool(state: M3AKState) {
  if (!isExecutableAction(state.nextAction)) {
    throw new Error(`tool node reached with a non-executable nextAction: ${String(state.nextAction)}`);
  }
  const action = state.nextAction;

  const outcome = await executeAction(action, state);

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

  return patch;
}

// TASK-021: reads the loop's final observation and writes only the four
// guardrail state fields (plus the narrowly-scoped promotion/delivery
// patches) — never touches activePlan/nextAction/executedSteps/etc.
function guardrail(state: M3AKState) {
  const decision = evaluateCommercialGuardrails(state);

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
async function escalation(state: M3AKState) {
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

  const result = await createEscalation(state.conversationId, reason, contextSummary);

  if (!result.created) {
    return { lastError: `escalation_creation_failed: ${result.reason}` };
  }

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
async function persist(state: M3AKState) {
  if (state.conversationId === null) {
    if (state.lastError !== null) {
      return {};
    }
    return { lastError: "conversation_persistence_skipped: missing_conversation_id" };
  }

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

// Uncompiled builder: topology only, no side effects. compileSalesGraph()
// compiles this same builder with a checkpointer without touching node/edge
// wiring (TASK-024).
export function buildSalesGraph() {
  return new StateGraph(M3AKStateObjectSchema)
    .addNode("loadContext", loadContext)
    .addNode("conversation", noop)
    .addNode("router", router)
    .addNode("tool", tool)
    .addNode("guardrail", guardrail)
    .addNode("escalation", escalation)
    .addNode("response", noop)
    .addNode("persist", persist)
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
export function compileSalesGraph(checkpointer: BaseCheckpointSaver = langgraphCheckpointer) {
  return buildSalesGraph().compile({ checkpointer });
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
