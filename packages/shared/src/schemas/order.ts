import { z } from "zod";
import { IdSchema, IsoDateTimeSchema } from "./common";

// Statut volontairement réduit à la seule valeur documentée : une commande
// n'est créée qu'après confirmation explicite (design.md §15), et aucun
// autre état du cycle de vie n'est encore défini dans spec.md/design.md/
// tasks.md. Décision temporaire — le cycle de vie complet (annulation,
// livraison, etc.) sera réévalué lors de TASK-006/TASK-012 à partir des
// vraies données et règles métier.
export const OrderStatusSchema = z.enum(["confirmed"]);

export type OrderStatus = z.infer<typeof OrderStatusSchema>;

// Seul le paiement à la livraison est dans le périmètre du MVP (spec.md §12
// exclut le paiement en ligne réel ; design.md ne mentionne que le COD).
export const PaymentMethodSchema = z.enum(["cash_on_delivery"]);

export type PaymentMethod = z.infer<typeof PaymentMethodSchema>;

export const OrderItemSchema = z
  .object({
    productRef: IdSchema,
    quantity: z.number().int().positive(),
    unitPrice: z.number().nonnegative().finite(),
  })
  .strict();

export type OrderItem = z.infer<typeof OrderItemSchema>;

// Aucun calcul dans ce schema : productsTotal/deliveryFee/total sont acceptés
// tels que fournis, sans vérifier leur cohérence arithmétique entre eux.
export const OrderSchema = z
  .object({
    id: IdSchema,
    customerId: IdSchema,
    conversationId: IdSchema,
    status: OrderStatusSchema,
    productsTotal: z.number().nonnegative().finite(),
    deliveryFee: z.number().nonnegative().finite(),
    total: z.number().nonnegative().finite(),
    city: z.string().min(1),
    paymentMethod: PaymentMethodSchema,
    items: z.array(OrderItemSchema).min(1),
    createdAt: IsoDateTimeSchema,
  })
  .strict();

export type Order = z.infer<typeof OrderSchema>;
