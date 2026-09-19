import type { Cart } from "@m3ak/shared";
import { findAlternatives } from "../catalogue/alternatives";
import { getApplicablePromotion, validateDiscount } from "../catalogue/promotions";
import { getAvailability, getProduct, searchProducts } from "../catalogue/products";
import { addCartItem, createCart, removeCartItem, updateCartItem } from "../cart/cart";
import { getDeliveryOptions } from "../delivery/delivery";
import { madToCentimes } from "../infrastructure/money";
import { createOrder } from "../order/order";
import type { AllowedAction } from "./orchestrator";
import type { M3AKState } from "./state";

type CartSnapshot = NonNullable<M3AKState["cart"]>;

export interface ActionOutcome {
  ok: boolean;
  result: unknown;
  resolvedRef: string | null;
  // Safe deterministic patches this loop is explicitly authorized to promote
  // (TASK-020 HACK-CTRL): the cart snapshot after CREATE_CART/ADD_TO_CART,
  // and the real order id after CREATE_ORDER. Never fabricated — only ever
  // set from a real deterministic tool's own return value.
  cartPatch?: CartSnapshot;
  orderId?: string;
  // TASK-035 (AC-03 "sans recommencer la conversation depuis zéro"): fills a
  // slot the customer left unstated this turn from a real, already-known,
  // unambiguous source (the single existing cart item) — never invented, and
  // never overwrites a slot extraction already supplied. Merged into
  // state.extraction the same way conversation()'s own merge already works.
  extractionPatch?: Partial<M3AKState["extraction"]>;
}

function missingInput(resolvedRef: string | null): ActionOutcome {
  return { ok: false, result: { reason: "missing_required_input" }, resolvedRef };
}

// Only trusts a JSON-safe string resolvedRef already present in the prior
// observation — never invents one. state.lastResult is arbitrary JSON, not a
// schema-enforced shape, so this is defensive narrowing, not a real cast.
function extractCarriedResolvedRef(lastResult: M3AKState["lastResult"]): string | null {
  if (typeof lastResult === "object" && lastResult !== null && !Array.isArray(lastResult)) {
    const value = (lastResult as { resolvedRef?: unknown }).resolvedRef;
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return null;
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

// TASK-025: current-turn extraction.city always wins; customerMemory.city is
// a fallback used ONLY to supply this CHECK_DELIVERY lookup's input. It is
// never written back into extraction and never consumed by CREATE_ORDER,
// which keeps reading state.extraction.city directly, unchanged.
function resolveDeliveryCity(state: M3AKState): string | null {
  return state.extraction.city ?? state.customerMemory?.city ?? null;
}

function toCartSnapshot(cart: Cart): CartSnapshot {
  return {
    id: cart.id,
    version: cart.version,
    items: cart.items.map((item) => ({
      productRef: item.productRef,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
    })),
  };
}

// One flat switch, one deterministic tool call per action, no framework. Every
// branch resolves its inputs ONLY from already-validated state/extraction/
// carried resolvedRef/system date — never fabricates a missing argument.
export async function executeAction(action: AllowedAction, state: M3AKState): Promise<ActionOutcome> {
  const carriedRef = extractCarriedResolvedRef(state.lastResult);

  switch (action) {
    case "SEARCH_PRODUCTS": {
      const criteria: Record<string, string> = {};
      if (state.extraction.family) {
        criteria.family = state.extraction.family;
      } else if (state.extraction.productQuery && (!state.cart || state.cart.items.length === 0)) {
        // TASK-037: Darija extraction may correctly identify the requested
        // product text without promoting it to the catalogue's family slot.
        // Keep that explicit customer text on the deterministic tool path
        // instead of degrading to an ambiguous color/size-only search.
        criteria.model = state.extraction.productQuery;
      }
      if (state.extraction.color) criteria.color = state.extraction.color;
      if (state.extraction.size) criteria.size = state.extraction.size;

      // TASK-035 (AC-03): a change-of-mind follow-up ("finalement taille M")
      // may not restate a family/color the customer already established.
      // When the cart already holds exactly one real item, its own real
      // attributes (read fresh via getProduct, never invented) fill the gap
      // — never applied when the cart is empty or already ambiguous (more
      // than one item), matching REMOVE_CART_ITEM's own "never guess" rule.
      const extractionPatch: Partial<M3AKState["extraction"]> = {};
      if ((!criteria.family || !criteria.color) && state.cart?.items.length === 1) {
        const cartItem = state.cart.items[0] as CartSnapshot["items"][number];
        const cartProductResult = await getProduct(cartItem.productRef);
        if (cartProductResult.found) {
          if (!criteria.family) {
            criteria.family = cartProductResult.product.family;
            extractionPatch.family = cartProductResult.product.family;
          }
          if (!criteria.color && cartProductResult.product.color) {
            criteria.color = cartProductResult.product.color;
            extractionPatch.color = cartProductResult.product.color;
          }
        }
      }

      if (Object.keys(criteria).length === 0) {
        return missingInput(carriedRef);
      }
      const products = await searchProducts(criteria);
      const [onlyProduct] = products;
      // A fresh search deliberately resets focus: ambiguous (0 or >1) results
      // never fall back to whatever was resolved before this search.
      const resolvedRef = products.length === 1 && onlyProduct ? onlyProduct.ref : null;
      const outcome: ActionOutcome = { ok: products.length > 0, result: products, resolvedRef };
      if (Object.keys(extractionPatch).length > 0) outcome.extractionPatch = extractionPatch;
      return outcome;
    }

    case "CHECK_STOCK": {
      if (!carriedRef) return missingInput(carriedRef);
      const result = await getAvailability(carriedRef);
      const ok = result.found && result.available;
      return { ok, result, resolvedRef: carriedRef };
    }

    case "FIND_ALTERNATIVES": {
      if (!carriedRef) return missingInput(carriedRef);
      const result = await findAlternatives(carriedRef);
      const ok = result.found && result.alternatives.length > 0;
      // Never auto-promotes an alternative's ref, even when exactly one is
      // returned: which alternative (if any) the customer wants is not this
      // executor's decision to make.
      return { ok, result, resolvedRef: carriedRef };
    }

    case "CHECK_PROMOTION": {
      if (!carriedRef) return missingInput(carriedRef);
      const result = await getApplicablePromotion(carriedRef, todayIsoDate());
      return { ok: result.found, result, resolvedRef: carriedRef };
    }

    case "CHECK_DELIVERY": {
      const deliveryCity = resolveDeliveryCity(state);
      if (!deliveryCity) return missingInput(carriedRef);
      const result = await getDeliveryOptions(deliveryCity);
      return { ok: result.found, result, resolvedRef: carriedRef };
    }

    case "CREATE_CART": {
      if (!state.conversationId) return missingInput(carriedRef);
      const result = await createCart(state.conversationId);
      if (result.created) {
        return { ok: true, result, resolvedRef: carriedRef, cartPatch: toCartSnapshot(result.cart) };
      }
      return { ok: false, result, resolvedRef: carriedRef };
    }

    case "ADD_TO_CART": {
      if (!state.cart || !carriedRef || !state.extraction.quantity) return missingInput(carriedRef);
      const result = await addCartItem(state.cart.id, carriedRef, state.extraction.quantity, todayIsoDate());
      if (result.ok) {
        return { ok: true, result, resolvedRef: carriedRef, cartPatch: toCartSnapshot(result.cart) };
      }
      return { ok: false, result, resolvedRef: carriedRef };
    }

    // TASK-035 (AC-03): a pure quantity change on a product ref already in the
    // cart. Deliberately updateCartItem (replace), never addCartItem
    // (accumulate) — the customer said "3 instead of 2", not "3 more".
    case "UPDATE_CART_ITEM": {
      if (!state.cart || !carriedRef || !state.extraction.quantity) return missingInput(carriedRef);
      const result = await updateCartItem(state.cart.id, carriedRef, state.extraction.quantity);
      if (result.ok) {
        return { ok: true, result, resolvedRef: carriedRef, cartPatch: toCartSnapshot(result.cart) };
      }
      return { ok: false, result, resolvedRef: carriedRef };
    }

    // TASK-035 (AC-03): a size/color/product change means a different
    // catalogue ref (cart_items is keyed by (cart_id, product_ref)), so the
    // old variant must be dropped before the newly resolved one is added.
    // Only ever removes when exactly one cart item is stale relative to the
    // freshly resolved carriedRef — which item the customer means is never
    // guessed when the cart holds more than one, or when nothing in it
    // actually differs from what was just resolved.
    case "REMOVE_CART_ITEM": {
      if (!state.cart || !carriedRef) return missingInput(carriedRef);
      const staleItems = state.cart.items.filter((item) => item.productRef !== carriedRef);
      if (staleItems.length !== 1) return missingInput(carriedRef);
      const staleItem = staleItems[0] as CartSnapshot["items"][number];
      const result = await removeCartItem(state.cart.id, staleItem.productRef);
      if (result.removed) {
        const outcome: ActionOutcome = { ok: true, result, resolvedRef: carriedRef, cartPatch: toCartSnapshot(result.cart) };
        // TASK-035 (AC-03): "finalement taille M" never restates a quantity
        // the customer already gave — the item being replaced is the only
        // real source for it, captured here before it is gone from the cart.
        if (state.extraction.quantity === null) {
          outcome.extractionPatch = { quantity: staleItem.quantity };
        }
        return outcome;
      }
      return { ok: false, result, resolvedRef: carriedRef };
    }

    // TASK-036 (AC-04): purely a real-truth query — never decides
    // authorization itself, only asks validateDiscount() and reports its
    // real answer. requestedPriceMad is transcribed customer text, converted
    // to cents deterministically (never by the LLM) right before the call.
    case "VALIDATE_DISCOUNT": {
      if (!carriedRef || !state.extraction.requestedPriceMad) return missingInput(carriedRef);
      const result = await validateDiscount(carriedRef, madToCentimes(state.extraction.requestedPriceMad), todayIsoDate());
      return { ok: result.allowed, result, resolvedRef: carriedRef };
    }

    case "CREATE_ORDER": {
      if (
        !state.cart ||
        state.extraction.confirmation === null ||
        !state.extraction.city ||
        !state.extraction.paymentMethod
      ) {
        return missingInput(carriedRef);
      }
      const result = await createOrder(
        state.cart.id,
        state.extraction.confirmation,
        state.extraction.city,
        state.extraction.paymentMethod,
        todayIsoDate(),
      );
      if (result.created) {
        return { ok: true, result, resolvedRef: carriedRef, orderId: result.order.id };
      }
      return { ok: false, result, resolvedRef: carriedRef };
    }

    case "RESPOND":
    case "ESCALATE":
    default:
      throw new Error(`executeAction must never be called with a terminal or unrecognized action: ${String(action)}`);
  }
}
