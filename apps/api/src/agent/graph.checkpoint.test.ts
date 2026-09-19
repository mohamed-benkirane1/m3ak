import { END, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import { z } from "zod";

// TASK-024 regression proof (independent of M3AK's real graph/nodes, exactly
// like the TASK-024C runtime experiment it preserves): on LangGraph 1.4.16,
// resuming a thread whose second node threw on its first pass must NOT
// replay the already-completed first node, must re-enter the failed node,
// and must hand it the state that first node already wrote — proving
// `compiled.invoke(null, { configurable: { thread_id } })` genuinely resumes
// an interrupted run rather than restarting from START. If LangGraph's
// resume mechanics ever regress, this test — not graph.test.ts — is what
// catches it.
describe("LangGraph 1.4.16 interrupted-run resume mechanics (TASK-024 regression proof)", () => {
  it("resumes the incomplete node without replaying the completed one, restoring its written state", async () => {
    const Schema = z.object({ marker: z.string() });

    let nodeARuns = 0;
    let nodeBRuns = 0;
    const nodeBReceivedMarkers: string[] = [];

    const graph = new StateGraph(Schema)
      .addNode("nodeA", async () => {
        nodeARuns += 1;
        return { marker: "from-A" };
      })
      .addNode("nodeB", async (state) => {
        nodeBRuns += 1;
        nodeBReceivedMarkers.push(state.marker);
        if (nodeBRuns === 1) {
          throw new Error("intentional-test-failure");
        }
        return { marker: "from-B-success" };
      })
      .addEdge(START, "nodeA")
      .addEdge("nodeA", "nodeB")
      .addEdge("nodeB", END);

    const compiled = graph.compile({ checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: "task-024-regression-proof" } };

    await expect(compiled.invoke({ marker: "initial" }, config)).rejects.toThrow("intentional-test-failure");

    const result = await compiled.invoke(null, config);

    expect(nodeARuns).toBe(1);
    expect(nodeBRuns).toBe(2);
    expect(nodeBReceivedMarkers).toEqual(["from-A", "from-A"]);
    expect(result).toEqual({ marker: "from-B-success" });
  });
});
