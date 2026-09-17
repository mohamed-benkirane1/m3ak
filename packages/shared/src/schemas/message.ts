import { z } from "zod";
import { IdSchema, IsoDateTimeSchema } from "./common";

// "system" volontairement exclu : aucun message métier persistant ne le
// justifie ici, et il ne faut pas confondre un rôle de message avec les
// prompts système internes du LLM (CLAUDE.md §17).
export const MessageRoleSchema = z.enum(["customer", "assistant", "merchant"]);

export type MessageRole = z.infer<typeof MessageRoleSchema>;

export const MessageSchema = z
  .object({
    id: IdSchema,
    conversationId: IdSchema,
    role: MessageRoleSchema,
    content: z.string().min(1),
    createdAt: IsoDateTimeSchema,
  })
  .strict();

export type Message = z.infer<typeof MessageSchema>;
