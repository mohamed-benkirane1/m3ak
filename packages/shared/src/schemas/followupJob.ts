import { z } from "zod";

// TASK-026: the BullMQ contract for followup jobs — distinct from FollowupSchema
// (the followups table's own domain shape, ./followup.ts). Producer (@m3ak/api)
// and consumer (@m3ak/worker) both import these constants/schema so the queue
// name, job name, and payload shape can never drift independently between them.
export const FOLLOWUP_QUEUE_NAME = "followups";
export const FOLLOWUP_JOB_NAME = "execute-followup";

// followups.id is a real PostgreSQL UUID column — the payload transports only
// this durable identifier. Everything else (conversation, customer, message,
// eligibility, scheduledAt, state) is re-read from PostgreSQL at execution
// time; BullMQ/Redis never becomes a second copy of business truth.
export const FollowupJobDataSchema = z
  .object({
    followupId: z.string().uuid(),
  })
  .strict();

export type FollowupJobData = z.infer<typeof FollowupJobDataSchema>;
