import { z } from "zod";
import { IdSchema, IsoDateTimeSchema } from "./common";

// Validations strictement structurelles : aucun calcul de remise, aucune
// vérification "active aujourd'hui", aucune priorité/stacking (tâche métier
// ultérieure). Les deux refine ci-dessous ne font que vérifier la cohérence
// interne des valeurs fournies (prix promo <= prix normal, fin >= début).
export const PromotionSchema = z
  .object({
    id: IdSchema,
    productRef: IdSchema,
    normalPrice: z.number().nonnegative().finite(),
    promoPrice: z.number().nonnegative().finite(),
    startsAt: IsoDateTimeSchema,
    endsAt: IsoDateTimeSchema,
    condition: z.string().min(1).optional(),
  })
  .strict()
  .refine((promotion) => promotion.promoPrice <= promotion.normalPrice, {
    message: "promoPrice must not exceed normalPrice",
    path: ["promoPrice"],
  })
  .refine(
    (promotion) => new Date(promotion.endsAt).getTime() >= new Date(promotion.startsAt).getTime(),
    {
      message: "endsAt must not be before startsAt",
      path: ["endsAt"],
    },
  );

export type Promotion = z.infer<typeof PromotionSchema>;
