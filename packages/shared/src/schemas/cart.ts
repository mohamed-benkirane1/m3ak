import { z } from "zod";
import { IdSchema } from "./common";

export const CartItemSchema = z
  .object({
    productRef: IdSchema,
    quantity: z.number().int().positive(),
    unitPrice: z.number().nonnegative().finite(),
  })
  .strict();

export type CartItem = z.infer<typeof CartItemSchema>;

// `status` reste une chaîne libre non vide : aucune valeur de statut de
// panier n'est encore définie dans spec.md/design.md. Fermer cet enum
// maintenant reviendrait à inventer un vocabulaire métier non validé.
export const CartSchema = z
  .object({
    id: IdSchema,
    conversationId: IdSchema,
    status: z.string().min(1),
    version: z.number().int().nonnegative(),
    items: z.array(CartItemSchema),
  })
  .strict();

export type Cart = z.infer<typeof CartSchema>;
