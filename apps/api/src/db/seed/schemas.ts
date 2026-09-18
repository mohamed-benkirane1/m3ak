import { z } from "zod";

// Raw row shape validation only: every field is the exact source string, unconverted.
// .strict() also acts as a header-shape guard — an unexpected/missing column fails loudly.

export const RawCatalogueRowSchema = z
  .object({
    ref: z.string().min(1),
    modele: z.string().min(1),
    famille: z.string().min(1),
    genre: z.string().min(1),
    couleur: z.string().min(1),
    taille: z.string().min(1),
    matiere: z.string().min(1),
    saison: z.string().min(1),
    prix_mad: z.string().min(1),
    stock: z.string().min(1),
    delai_reassort_jours: z.string(),
    code_barre: z.string().min(1),
    poids_g: z.string().min(1),
  })
  .strict();

export const RawClientRowSchema = z
  .object({
    client_id: z.string().min(1),
    nom: z.string().min(1),
    telephone: z.string().min(1),
    ville: z.string().min(1),
    langue_preferee: z.string().min(1),
    premier_achat: z.string().min(1),
    nb_commandes: z.string().min(1),
    segment: z.string().min(1),
  })
  .strict();

export const RawCommandeRowSchema = z
  .object({
    commande_id: z.string().min(1),
    client_id: z.string().min(1),
    date: z.string().min(1),
    canal: z.string().min(1),
    statut: z.string().min(1),
    total_articles_mad: z.string().min(1),
    frais_livraison_mad: z.string().min(1),
    total_mad: z.string().min(1),
    ville_livraison: z.string().min(1),
    paiement: z.string().min(1),
  })
  .strict();

export const RawLigneRowSchema = z
  .object({
    commande_id: z.string().min(1),
    ref: z.string().min(1),
    modele: z.string().min(1),
    taille: z.string().min(1),
    quantite: z.string().min(1),
    prix_unitaire_mad: z.string().min(1),
  })
  .strict();

export const RawLivraisonRowSchema = z
  .object({
    ville: z.string().min(1),
    frais_mad: z.string().min(1),
    delai_heures: z.string().min(1),
    paiement_a_la_livraison: z.string().min(1),
    retrait_boutique: z.string().min(1),
  })
  .strict();

export const RawPromotionRowSchema = z
  .object({
    ref: z.string().min(1),
    modele: z.string().min(1),
    prix_normal_mad: z.string().min(1),
    prix_promo_mad: z.string().min(1),
    debut: z.string().min(1),
    fin: z.string().min(1),
    condition: z.string().min(1),
  })
  .strict();
