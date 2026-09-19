import { z } from "zod";
import { CartSchema, DeliveryZoneSchema, IdSchema, LanguageSchema, MessageSchema, PromotionSchema } from "@m3ak/shared";
import { CustomerMemorySchema } from "../customer/customerMemory";
import { ExtractionSchema } from "../llm/extraction";

const TextSchema = z.string().trim().min(1);
const CentsSchema = z.number().int().nonnegative();
const JsonSchema = z.json();

// Inspect descriptors before Zod can read properties or recurse. Track only
// ancestors: sharing an object between siblings is valid JSON, unlike a cycle.
function isJsonData(input: unknown): boolean {
  const ancestors = new WeakSet<object>();
  function visit(value: unknown): boolean {
    if (value === null || typeof value === "string" || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value !== "object") return false;

    const array = Array.isArray(value);
    const prototype: unknown = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return false;
    if (ancestors.has(value)) return false;

    const keys = Reflect.ownKeys(value);
    const length = array ? (value as unknown[]).length : 0;
    // Sparse arrays and additional array properties do not round-trip intact.
    if (array && keys.length !== length + 1) return false;
    ancestors.add(value);
    for (const key of keys) {
      if (typeof key !== "string") return false;
      if (array && key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return false;
      if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length)) return false;
      if (!visit(descriptor.value)) return false;
    }
    ancestors.delete(value);
    return true;
  }

  try {
    return visit(input);
  } catch {
    return false;
  }
}

const JsonInputSchema = z.custom<z.infer<typeof JsonSchema>>(isJsonData, {
  message: "Expected acyclic JSON data without accessors or runtime objects",
});
// Validate without replacing the observation: z.json() strips own __proto__
// keys from its parsed copy, although those are legal string keys in JSON.
const JsonValueSchema = JsonInputSchema.refine((value) => JsonSchema.safeParse(value).success, {
  message: "Expected a JSON value",
});
const StateMessageSchema = MessageSchema.pick({ role: true, content: true }).strict();
const RequestExtractionSchema = ExtractionSchema.omit({ language: true, intent: true }).strict();
const CartSnapshotSchema = CartSchema.pick({ id: true, version: true, items: true }).strict();
const PromotionSnapshotSchema = z.object({
  id: PromotionSchema.shape.id,
  productRef: PromotionSchema.shape.productRef,
  promoPrice: PromotionSchema.shape.promoPrice,
}).strict();
const DeliverySnapshotSchema = z.object({
  city: DeliveryZoneSchema.shape.city,
  feeCents: CentsSchema,
  delayHours: DeliveryZoneSchema.shape.delayHours,
  cashOnDelivery: DeliveryZoneSchema.shape.cashOnDelivery,
  storePickup: DeliveryZoneSchema.shape.storePickup,
}).strict();

// Protect every state field before object parsing, including snapshot inputs.
// Exported separately (pre-pipe) so LangGraph's StateGraph can read a bare
// ZodObject for channel construction; JsonInputSchema's whole-root safety
// checks below are not reproduced by that per-field usage — see graph.ts.
export const M3AKStateObjectSchema = z.object({
  threadId: IdSchema,
  conversationId: IdSchema.nullable(),
  customerId: IdSchema.nullable(),
  // TASK-025: deterministic PostgreSQL read model, distinct from summary/
  // extraction/messages — see customerMemory.ts. Never written by the LLM.
  customerMemory: CustomerMemorySchema.nullable(),
  messages: z.array(StateMessageSchema),
  summary: TextSchema.nullable(),
  language: LanguageSchema,
  intent: ExtractionSchema.shape.intent,
  extraction: RequestExtractionSchema,
  cart: CartSnapshotSchema.nullable(),
  promotion: PromotionSnapshotSchema.nullable(),
  delivery: DeliverySnapshotSchema.nullable(),
  // Validated products subtotal in centimes; excludes delivery. Null is unknown.
  cartTotalCents: CentsSchema.nullable(),
  nextAction: TextSchema.nullable(),
  activePlan: z.array(TextSchema),
  executedSteps: z.array(TextSchema),
  iterationCount: z.number().int().nonnegative(),
  lastResult: JsonValueSchema,
  lastError: TextSchema.nullable(),
  // Null means unevaluated for the current action; false means denied.
  authorized: z.boolean().nullable(),
  clarificationNeeded: z.boolean(),
  humanInterventionNeeded: z.boolean(),
  guardrailReasons: z.array(TextSchema),
  orderId: IdSchema.nullable(),
  escalationId: IdSchema.nullable(),
  followupId: IdSchema.nullable(),
}).strict();

export const M3AKStateSchema = JsonInputSchema.pipe(M3AKStateObjectSchema);

export type M3AKState = z.infer<typeof M3AKStateSchema>;
