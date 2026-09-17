import { z } from "zod";
import { IdSchema, IsoDateTimeSchema } from "./common";
import { LanguageSchema } from "./language";

// Champs réellement optionnels : rien n'est inventé lorsqu'une information
// n'est pas encore connue (pas de nom "Client" par défaut, etc.).
export const CustomerSchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1).optional(),
    phone: z.string().min(1).optional(),
    city: z.string().min(1).optional(),
    preferredLanguage: LanguageSchema.optional(),
    segment: z.string().min(1).optional(),
    createdAt: IsoDateTimeSchema,
  })
  .strict();

export type Customer = z.infer<typeof CustomerSchema>;
