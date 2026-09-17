import { z } from "zod";

// Attributs descriptifs (gender/color/size/material/season) volontairement
// modélisés en chaînes libres, pas en enums fermés : leurs valeurs réelles
// proviennent du dataset Kenza (TASK-006), pas encore importé à ce stade.
// Inventer un ensemble fermé maintenant risquerait de rejeter des données
// réelles valides (zéro hallucination métier, CLAUDE.md §10).
export const ProductSchema = z
  .object({
    ref: z.string().min(1),
    model: z.string().min(1),
    family: z.string().min(1),
    gender: z.string().min(1).optional(),
    color: z.string().min(1).optional(),
    size: z.string().min(1).optional(),
    material: z.string().min(1).optional(),
    season: z.string().min(1).optional(),
    price: z.number().nonnegative().finite(),
    stock: z.number().int().nonnegative(),
    barcode: z.string().min(1).optional(),
    weight: z.number().nonnegative().finite().optional(),
  })
  .strict();

export type Product = z.infer<typeof ProductSchema>;
