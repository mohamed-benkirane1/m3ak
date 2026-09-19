import { END, START, StateGraph } from "@langchain/langgraph";
import { LlmError } from "../llm/reasoningClient";
import { executeAction } from "./actionExecutor";
import { type AllowedAction, deriveLastOutcomeOk, OrchestratorError, planNextActions } from "./orchestrator";
import { M3AKStateObjectSchema, M3AKStateSchema, type M3AKState } from "./state";

// Every TASK-018 node is a structural no-op: it proves graph topology only.
// Real node behavior belongs to later tasks (see design.md §7, tasks.md §8-9).
function noop(_state: M3AKState) {
  return {};
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

// Uncompiled builder: topology only, no side effects. TASK-024 can compile
// this same builder with a checkpointer without touching node/edge wiring.
export function buildSalesGraph() {
  return new StateGraph(M3AKStateObjectSchema)
    .addNode("loadContext", noop)
    .addNode("conversation", noop)
    .addNode("router", router)
    .addNode("tool", tool)
    .addNode("guardrail", noop)
    .addNode("response", noop)
    .addNode("persist", noop)
    .addEdge(START, "loadContext")
    .addEdge("loadContext", "conversation")
    .addEdge("conversation", "router")
    .addConditionalEdges("router", routeAfterRouter, { tool: "tool", guardrail: "guardrail" })
    .addEdge("tool", "router")
    .addEdge("guardrail", "response")
    .addEdge("response", "persist")
    .addEdge("persist", END);
}

export function compileSalesGraph() {
  return buildSalesGraph().compile();
}

// M3AKStateObjectSchema (used above for LangGraph channel construction) does
// not reproduce M3AKStateSchema's whole-root JSON-safety boundary, so both
// entry and exit are validated explicitly through the outer schema here.
export async function invokeSalesGraph(input: unknown): Promise<M3AKState> {
  const validatedInput = M3AKStateSchema.parse(input);
  const compiled = compileSalesGraph();
  const result = await compiled.invoke(validatedInput);
  return M3AKStateSchema.parse(result);
}
