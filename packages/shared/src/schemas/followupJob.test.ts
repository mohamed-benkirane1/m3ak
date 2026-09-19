import { describe, expect, it } from "vitest";
import { FOLLOWUP_JOB_NAME, FOLLOWUP_QUEUE_NAME, FollowupJobDataSchema } from "./followupJob";

describe("FOLLOWUP_QUEUE_NAME / FOLLOWUP_JOB_NAME", () => {
  it("are the exact closed constants", () => {
    expect(FOLLOWUP_QUEUE_NAME).toBe("followups");
    expect(FOLLOWUP_JOB_NAME).toBe("execute-followup");
  });
});

describe("FollowupJobDataSchema", () => {
  it("accepts a valid UUID followupId", () => {
    const result = FollowupJobDataSchema.safeParse({ followupId: "11111111-1111-4111-8111-111111111111" });
    expect(result.success).toBe(true);
  });

  it("rejects a non-UUID followupId", () => {
    const result = FollowupJobDataSchema.safeParse({ followupId: "not-a-uuid" });
    expect(result.success).toBe(false);
  });

  it("rejects a missing followupId", () => {
    const result = FollowupJobDataSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects extra business-snapshot fields (strict schema)", () => {
    const result = FollowupJobDataSchema.safeParse({
      followupId: "11111111-1111-4111-8111-111111111111",
      conversationId: "conversation-1",
      customerId: "customer-1",
      message: "leaked message content",
    });
    expect(result.success).toBe(false);
  });
});
