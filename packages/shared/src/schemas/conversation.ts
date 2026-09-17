import { z } from "zod";
import { IdSchema, IsoDateTimeSchema } from "./common";
import { LanguageSchema } from "./language";

// Statuts volontairement minimaux (spec/design ne justifient que ces trois-là) :
// active en cours, completed conclue, escalated transférée à un humain.
export const ConversationStatusSchema = z.enum(["active", "completed", "escalated"]);

export type ConversationStatus = z.infer<typeof ConversationStatusSchema>;

export const ConversationSchema = z
  .object({
    id: IdSchema,
    customerId: IdSchema,
    status: ConversationStatusSchema,
    language: LanguageSchema,
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();

export type Conversation = z.infer<typeof ConversationSchema>;
