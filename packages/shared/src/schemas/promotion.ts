import { z } from "zod";
import { IdSchema, IsoDateSchema } from "./common";

// Validations strictement structurelles : aucun calcul de remise, aucune
// vérification "active aujourd'hui", aucune priorité/stacking (tâche métier
// ultérieure). Les deux refine ci-dessous ne font que vérifier la cohérence
// interne des valeurs fournies (prix promo <= prix normal, fin >= début).
//
// startsAt/endsAt sont des dates calendaires (YYYY-MM-DD), pas des timestamps :
// promotions.csv (dataset Kenza officiel) exprime ses bornes en dates métier.
export const PromotionSchema = z
  .object({
    id: IdSchema,
    productRef: IdSchema,
    normalPrice: z.number().nonnegative().finite(),
    promoPrice: z.number().nonnegative().finite(),
    startsAt: IsoDateSchema,
    endsAt: IsoDateSchema,
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
