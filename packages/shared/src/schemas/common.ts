import { z } from "zod";

// Identifiants applicatifs : chaînes non vides. Pas d'UUID imposé tant
// qu'aucune décision d'architecture ne l'exige.
export const IdSchema = z.string().min(1);

// Timestamps transportables : chaînes ISO-8601 (offset explicite autorisé),
// jamais d'objet `Date` directement dans un contrat sérialisable en JSON.
export const IsoDateTimeSchema = z.string().datetime({ offset: true });

// Dates calendaires strictes (YYYY-MM-DD, sans heure) : promotions.csv du
// dataset Kenza officiel exprime ses bornes en dates métier, pas en
// timestamps précis. `z.string().date()` rejette un timestamp complet.
export const IsoDateSchema = z.string().date();
