import type { Cart } from "@m3ak/shared";
import { findAlternatives } from "../catalogue/alternatives";
import { getApplicablePromotion } from "../catalogue/promotions";
import { getAvailability, searchProducts } from "../catalogue/products";
import { addCartItem, createCart } from "../cart/cart";
import { getDeliveryOptions } from "../delivery/delivery";
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
      if (state.extraction.family) criteria.family = state.extraction.family;
      if (state.extraction.color) criteria.color = state.extraction.color;
      if (state.extraction.size) criteria.size = state.extraction.size;
      if (Object.keys(criteria).length === 0) {
        return missingInput(carriedRef);
      }
      const products = await searchProducts(criteria);
      const [onlyProduct] = products;
      // A fresh search deliberately resets focus: ambiguous (0 or >1) results
      // never fall back to whatever was resolved before this search.
      const resolvedRef = products.length === 1 && onlyProduct ? onlyProduct.ref : null;
      return { ok: products.length > 0, result: products, resolvedRef };
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
      if (!state.extraction.city) return missingInput(carriedRef);
      const result = await getDeliveryOptions(state.extraction.city);
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
