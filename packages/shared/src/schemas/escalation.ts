import { z } from "zod";
import { IdSchema, IsoDateTimeSchema } from "./common";

export const EscalationStatusSchema = z.enum(["open", "resolved"]);

export type EscalationStatus = z.infer<typeof EscalationStatusSchema>;

// `reason` reste une chaîne libre : nous ne connaissons pas encore
// l'ensemble exhaustif des motifs d'escalade (instruction explicite §15).
export const EscalationSchema = z
  .object({
    id: IdSchema,
    conversationId: IdSchema,
    reason: z.string().min(1),
    contextSummary: z.string().min(1),
    status: EscalationStatusSchema,
    createdAt: IsoDateTimeSchema,
  })
  .strict();

export type Escalation = z.infer<typeof EscalationSchema>;
