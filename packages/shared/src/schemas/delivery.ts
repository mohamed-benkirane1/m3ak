import { z } from "zod";

export const DeliveryZoneSchema = z
  .object({
    city: z.string().min(1),
    fee: z.number().nonnegative().finite(),
    delayHours: z.number().positive().finite(),
    cashOnDelivery: z.boolean(),
    storePickup: z.boolean(),
  })
  .strict();

export type DeliveryZone = z.infer<typeof DeliveryZoneSchema>;
