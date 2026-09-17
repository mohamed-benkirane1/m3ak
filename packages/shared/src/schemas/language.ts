import { z } from "zod";

// darija / arabe / français / mixte / inconnu (spec.md §10, design.md §9).
// L'anglais n'appartient pas au périmètre du MVP.
export const LanguageSchema = z.enum(["darija", "arabic", "french", "mixed", "unknown"]);

export type Language = z.infer<typeof LanguageSchema>;
