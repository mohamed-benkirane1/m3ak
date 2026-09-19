import { END, START, StateGraph } from "@langchain/langgraph";
import { LlmError } from "../llm/reasoningClient";
import { OrchestratorError, planNextActions } from "./orchestrator";
import { M3AKStateObjectSchema, M3AKStateSchema, type M3AKState } from "./state";

// Every TASK-018 node is a structural no-op: it proves graph topology only.
// Real node behavior belongs to later tasks (see design.md §7, tasks.md §8-9).
function noop(_state: M3AKState) {
  return {};
}

// TASK-019: produces and validates a multi-step plan limited to allowed
// actions. Does not execute any step of that plan — see TASK-020 for
// execution, observation, revision and MAX_AGENT_STEPS.
async function router(state: M3AKState) {
  try {
    const { plan } = await planNextActions(state);
    return {
      activePlan: plan,
      nextAction: plan[0] ?? null,
      lastError: null,
    };
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

// Uncompiled builder: topology only, no side effects. TASK-024 can compile
// this same builder with a checkpointer without touching node/edge wiring.
export function buildSalesGraph() {
  return new StateGraph(M3AKStateObjectSchema)
    .addNode("loadContext", noop)
    .addNode("conversation", noop)
    .addNode("router", router)
    .addNode("tool", noop)
    .addNode("guardrail", noop)
    .addNode("response", noop)
    .addNode("persist", noop)
    .addEdge(START, "loadContext")
    .addEdge("loadContext", "conversation")
    .addEdge("conversation", "router")
    .addEdge("router", "tool")
    .addEdge("tool", "guardrail")
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
