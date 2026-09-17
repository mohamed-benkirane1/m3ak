import { describe, expect, it } from "vitest";
import { FollowupSchema } from "./followup";

describe("FollowupSchema", () => {
  it("accepts a scheduled followup without executedAt", () => {
    const result = FollowupSchema.safeParse({
      id: "followup-1",
      conversationId: "conv-1",
      scheduledAt: "2026-01-01T10:00:00Z",
      status: "scheduled",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown status", () => {
    const result = FollowupSchema.safeParse({
      id: "followup-1",
      conversationId: "conv-1",
      scheduledAt: "2026-01-01T10:00:00Z",
      status: "pending",
    });
    expect(result.success).toBe(false);
  });
});
