import { z } from "zod";

// Identifiants applicatifs : chaînes non vides. Pas d'UUID imposé tant
// qu'aucune décision d'architecture ne l'exige.
export const IdSchema = z.string().min(1);

// Timestamps transportables : chaînes ISO-8601 (offset explicite autorisé),
// jamais d'objet `Date` directement dans un contrat sérialisable en JSON.
export const IsoDateTimeSchema = z.string().datetime({ offset: true });
