import { z } from "zod";
import { IdSchema, IsoDateTimeSchema } from "./common";

export const FollowupStatusSchema = z.enum(["scheduled", "executed", "cancelled", "failed"]);

export type FollowupStatus = z.infer<typeof FollowupStatusSchema>;

// executedAt et message sont optionnels (absents) tant que la relance n'a
// pas été exécutée : design.md §21 place la génération du message APRÈS le
// délai/worker, pas au moment de la planification.
export const FollowupSchema = z
  .object({
    id: IdSchema,
    conversationId: IdSchema,
    scheduledAt: IsoDateTimeSchema,
    executedAt: IsoDateTimeSchema.optional(),
    status: FollowupStatusSchema,
    message: z.string().min(1).optional(),
  })
  .strict();

export type Followup = z.infer<typeof FollowupSchema>;
