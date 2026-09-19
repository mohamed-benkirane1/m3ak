import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../catalogue/products", () => ({
  searchProducts: vi.fn(),
  getAvailability: vi.fn(),
  getProduct: vi.fn(),
}));
vi.mock("../catalogue/alternatives", () => ({
  findAlternatives: vi.fn(),
}));
vi.mock("../catalogue/promotions", () => ({
  getApplicablePromotion: vi.fn(),
  validateDiscount: vi.fn(),
}));
vi.mock("../delivery/delivery", () => ({
  getDeliveryOptions: vi.fn(),
}));
vi.mock("../cart/cart", () => ({
  createCart: vi.fn(),
  addCartItem: vi.fn(),
  updateCartItem: vi.fn(),
  removeCartItem: vi.fn(),
}));
vi.mock("../order/order", () => ({
  createOrder: vi.fn(),
}));

import { findAlternatives } from "../catalogue/alternatives";
import { getApplicablePromotion, validateDiscount } from "../catalogue/promotions";
import { getAvailability, getProduct, searchProducts } from "../catalogue/products";
import { addCartItem, createCart, removeCartItem, updateCartItem } from "../cart/cart";
import { getDeliveryOptions } from "../delivery/delivery";
import { createOrder } from "../order/order";
import { executeAction } from "./actionExecutor";
import type { M3AKState } from "./state";

const mockedSearchProducts = vi.mocked(searchProducts);
const mockedGetAvailability = vi.mocked(getAvailability);
const mockedGetProduct = vi.mocked(getProduct);
const mockedFindAlternatives = vi.mocked(findAlternatives);
const mockedGetApplicablePromotion = vi.mocked(getApplicablePromotion);
const mockedValidateDiscount = vi.mocked(validateDiscount);
const mockedGetDeliveryOptions = vi.mocked(getDeliveryOptions);
const mockedCreateCart = vi.mocked(createCart);
const mockedAddCartItem = vi.mocked(addCartItem);
const mockedUpdateCartItem = vi.mocked(updateCartItem);
const mockedRemoveCartItem = vi.mocked(removeCartItem);
const mockedCreateOrder = vi.mocked(createOrder);

const product = {
  ref: "REF-001", model: "Veste Hiver", family: "vestes", gender: "homme",
  color: "noir", size: "M", material: "laine", season: "hiver",
  price: 199.95, stock: 5, barcode: "000", weight: 800,
};

const baseState: M3AKState = {
  threadId: "thread-020",
  conversationId: "conversation-020",
  customerId: null,
  customerMemory: null,
  messages: [],
  summary: null,
  language: "french",
  intent: "product_search",
  extraction: {
    productQuery: "veste", family: "vestes", color: "noir", size: "M", quantity: 2,
    city: "Casablanca", address: null, paymentMethod: "cash_on_delivery", confirmation: true,
    requestedPriceMad: null,
  },
  cart: null,
  promotion: null,
  delivery: null,
  alternatives: [],
  cartTotalCents: null,
  nextAction: null,
  activePlan: [],
  executedSteps: [],
  iterationCount: 0,
  lastResult: null,
  lastError: null,
  authorized: null,
  clarificationNeeded: false,
  humanInterventionNeeded: false,
  guardrailReasons: [],
  orderId: null,
  escalationId: null,
  followupId: null,
};

const stateWithRef: M3AKState = {
  ...baseState,
  lastResult: { action: "SEARCH_PRODUCTS", ok: true, result: [product], resolvedRef: "REF-001" },
};

const stateWithCart: M3AKState = {
  ...stateWithRef,
  cart: { id: "cart-1", version: 0, items: [] },
};

// TASK-035 (AC-03): carriedRef is REF-001 (from stateWithRef's lastResult) —
// this cart already holds that SAME ref, matching a pure quantity change.
const stateWithMatchingCartItem: M3AKState = {
  ...stateWithRef,
  cart: { id: "cart-1", version: 1, items: [{ productRef: "REF-001", quantity: 1, unitPrice: 199.95 }] },
};

// TASK-035 (AC-03): carriedRef is REF-001 (freshly resolved), but the cart
// still holds a DIFFERENT, now-stale ref — matching a size/color/product
// change-of-mind where the old variant must be dropped.
const stateWithStaleCartItem: M3AKState = {
  ...stateWithRef,
  cart: { id: "cart-1", version: 1, items: [{ productRef: "REF-OLD-SIZE-L", quantity: 1, unitPrice: 189.95 }] },
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

afterEach(() => {
  vi.resetAllMocks();
});

describe("executeAction — SEARCH_PRODUCTS", () => {
  it("success with exactly one result resolves the ref", async () => {
    mockedSearchProducts.mockResolvedValueOnce([product]);
    const outcome = await executeAction("SEARCH_PRODUCTS", baseState);
    expect(outcome.ok).toBe(true);
    expect(outcome.resolvedRef).toBe("REF-001");
    expect(outcome.result).toEqual([product]);
    expect(mockedSearchProducts).toHaveBeenCalledWith({ family: "vestes", color: "noir", size: "M" });
  });

  it("multiple results leave resolvedRef null, discarding any carried ref", async () => {
    mockedSearchProducts.mockResolvedValueOnce([product, { ...product, ref: "REF-002" }]);
    const outcome = await executeAction("SEARCH_PRODUCTS", stateWithRef);
    expect(outcome.ok).toBe(true);
    expect(outcome.resolvedRef).toBeNull();
  });

  it("TASK-037: uses explicit Darija product text as the model criterion when family extraction is null", async () => {
    const darijaState: M3AKState = {
      ...baseState,
      language: "darija",
      messages: [{ role: "customer", content: "Bghit veste beige taille M" }],
      extraction: { ...baseState.extraction, productQuery: "veste", family: null, color: "beige", size: "M" },
    };
    mockedSearchProducts.mockResolvedValueOnce([{ ...product, ref: "REF-0036", model: "Veste beige", color: "beige" }]);

    const outcome = await executeAction("SEARCH_PRODUCTS", darijaState);

    expect(mockedSearchProducts).toHaveBeenCalledExactlyOnceWith({ model: "veste", color: "beige", size: "M" });
    expect(outcome.resolvedRef).toBe("REF-0036");
  });

  it("removes a redundant extracted size suffix from the model criterion", async () => {
    const state: M3AKState = {
      ...baseState,
      extraction: {
        ...baseState.extraction,
        productQuery: "veste beige taille M",
        family: null,
        color: "beige",
        size: "M",
        requestedPriceMad: 1050,
      },
    };
    mockedSearchProducts.mockResolvedValueOnce([{ ...product, ref: "REF-0036", model: "Veste beige", color: "beige" }]);

    const outcome = await executeAction("SEARCH_PRODUCTS", state);

    expect(mockedSearchProducts).toHaveBeenCalledExactlyOnceWith({ model: "veste beige", color: "beige", size: "M" });
    expect(outcome.resolvedRef).toBe("REF-0036");
  });

  it("zero results -> ok:false, resolvedRef null", async () => {
    mockedSearchProducts.mockResolvedValueOnce([]);
    const outcome = await executeAction("SEARCH_PRODUCTS", baseState);
    expect(outcome.ok).toBe(false);
    expect(outcome.resolvedRef).toBeNull();
  });

  it("missing input (no family/color/size) -> no tool call", async () => {
    const stateNoCriteria: M3AKState = {
      ...baseState,
      extraction: { ...baseState.extraction, productQuery: null, family: null, color: null, size: null },
    };
    const outcome = await executeAction("SEARCH_PRODUCTS", stateNoCriteria);
    expect(outcome).toEqual({ ok: false, result: { reason: "missing_required_input" }, resolvedRef: null });
    expect(mockedSearchProducts).not.toHaveBeenCalled();
  });

  describe("cart-derived fallback (TASK-035, AC-03 'sans recommencer la conversation depuis zéro')", () => {
    const cartProduct = { ...product, ref: "REF-OLD-SIZE-S", family: "Caftan", color: "bordeaux", size: "S" };

    it("fills a missing family/color from the single real cart item when the customer only restates size", async () => {
      const stateChangeOfMind: M3AKState = {
        ...baseState,
        extraction: { ...baseState.extraction, family: null, color: null, size: "M" },
        cart: { id: "cart-1", version: 1, items: [{ productRef: "REF-OLD-SIZE-S", quantity: 1, unitPrice: 250 }] },
      };
      mockedGetProduct.mockResolvedValueOnce({ found: true, product: cartProduct });
      mockedSearchProducts.mockResolvedValueOnce([{ ...cartProduct, ref: "REF-NEW-SIZE-M", size: "M" }]);

      const outcome = await executeAction("SEARCH_PRODUCTS", stateChangeOfMind);

      expect(mockedGetProduct).toHaveBeenCalledWith("REF-OLD-SIZE-S");
      expect(mockedSearchProducts).toHaveBeenCalledWith({ family: "Caftan", color: "bordeaux", size: "M" });
      expect(outcome.ok).toBe(true);
      expect(outcome.resolvedRef).toBe("REF-NEW-SIZE-M");
      // The real family/color, now known, become durable state — not just a
      // one-off query argument — so later steps this same turn see them too.
      expect(outcome.extractionPatch).toEqual({ family: "Caftan", color: "bordeaux" });
    });

    it("never overrides a family/color the customer explicitly stated this turn", async () => {
      const state: M3AKState = {
        ...baseState,
        extraction: { ...baseState.extraction, family: "Robe", color: "ivoire", size: "M" },
        cart: { id: "cart-1", version: 1, items: [{ productRef: "REF-OLD-SIZE-S", quantity: 1, unitPrice: 250 }] },
      };
      mockedSearchProducts.mockResolvedValueOnce([product]);

      await executeAction("SEARCH_PRODUCTS", state);

      expect(mockedGetProduct).not.toHaveBeenCalled();
      expect(mockedSearchProducts).toHaveBeenCalledWith({ family: "Robe", color: "ivoire", size: "M" });
    });

    it("never guesses when the cart holds more than one item", async () => {
      const state: M3AKState = {
        ...baseState,
        extraction: { ...baseState.extraction, family: null, color: null, size: "M" },
        cart: {
          id: "cart-1", version: 1,
          items: [
            { productRef: "REF-A", quantity: 1, unitPrice: 100 },
            { productRef: "REF-B", quantity: 1, unitPrice: 200 },
          ],
        },
      };
      mockedSearchProducts.mockResolvedValueOnce([]);

      await executeAction("SEARCH_PRODUCTS", state);

      expect(mockedGetProduct).not.toHaveBeenCalled();
      expect(mockedSearchProducts).toHaveBeenCalledWith({ size: "M" });
    });

    it("never fabricates family/color when the cart item itself cannot be found — searches on whatever was already stated", async () => {
      const stateChangeOfMind: M3AKState = {
        ...baseState,
        extraction: { ...baseState.extraction, family: null, color: null, size: "M" },
        cart: { id: "cart-1", version: 1, items: [{ productRef: "REF-GONE", quantity: 1, unitPrice: 250 }] },
      };
      mockedGetProduct.mockResolvedValueOnce({ found: false });
      mockedSearchProducts.mockResolvedValueOnce([]);

      const outcome = await executeAction("SEARCH_PRODUCTS", stateChangeOfMind);

      expect(mockedSearchProducts).toHaveBeenCalledWith({ size: "M" });
      expect(outcome.extractionPatch).toBeUndefined();
    });
  });
});

describe("executeAction — CHECK_STOCK", () => {
  it("success carries forward resolvedRef and derives ok from found && available", async () => {
    mockedGetAvailability.mockResolvedValueOnce({ found: true, ref: "REF-001", stock: 5, available: true });
    const outcome = await executeAction("CHECK_STOCK", stateWithRef);
    expect(outcome.ok).toBe(true);
    expect(outcome.resolvedRef).toBe("REF-001");
    expect(mockedGetAvailability).toHaveBeenCalledWith("REF-001");
  });

  it("insufficient stock is a business-negative outcome, ref preserved", async () => {
    mockedGetAvailability.mockResolvedValueOnce({ found: true, ref: "REF-001", stock: 0, available: false });
    const outcome = await executeAction("CHECK_STOCK", stateWithRef);
    expect(outcome.ok).toBe(false);
    expect(outcome.resolvedRef).toBe("REF-001");
  });

  it("missing resolvedRef -> no tool call", async () => {
    const outcome = await executeAction("CHECK_STOCK", baseState);
    expect(outcome).toEqual({ ok: false, result: { reason: "missing_required_input" }, resolvedRef: null });
    expect(mockedGetAvailability).not.toHaveBeenCalled();
  });

  it("revalidates the sole real cart item on a later order-confirmation turn", async () => {
    const state: M3AKState = {
      ...baseState,
      cart: { id: "cart-1", version: 1, items: [{ productRef: "REF-0036", quantity: 1, unitPrice: 1140 }] },
    };
    mockedGetAvailability.mockResolvedValueOnce({ found: true, ref: "REF-0036", stock: 14, available: true });

    const outcome = await executeAction("CHECK_STOCK", state);

    expect(mockedGetAvailability).toHaveBeenCalledExactlyOnceWith("REF-0036");
    expect(outcome).toEqual({
      ok: true,
      result: { found: true, ref: "REF-0036", stock: 14, available: true },
      resolvedRef: "REF-0036",
    });
  });

  it("never guesses a stock ref from an ambiguous multi-item cart", async () => {
    const state: M3AKState = {
      ...baseState,
      cart: {
        id: "cart-1",
        version: 1,
        items: [
          { productRef: "REF-A", quantity: 1, unitPrice: 100 },
          { productRef: "REF-B", quantity: 1, unitPrice: 200 },
        ],
      },
    };

    const outcome = await executeAction("CHECK_STOCK", state);

    expect(outcome).toEqual({ ok: false, result: { reason: "missing_required_input" }, resolvedRef: null });
    expect(mockedGetAvailability).not.toHaveBeenCalled();
  });
});

describe("executeAction — FIND_ALTERNATIVES", () => {
  it("success with alternatives -> ok:true, ref preserved, never auto-switched", async () => {
    mockedFindAlternatives.mockResolvedValueOnce({ found: true, source: product, alternatives: [{ ...product, ref: "REF-ALT" }] });
    const outcome = await executeAction("FIND_ALTERNATIVES", stateWithRef);
    expect(outcome.ok).toBe(true);
    expect(outcome.resolvedRef).toBe("REF-001");
  });

  it("no eligible alternatives -> ok:false", async () => {
    mockedFindAlternatives.mockResolvedValueOnce({ found: true, source: product, alternatives: [] });
    const outcome = await executeAction("FIND_ALTERNATIVES", stateWithRef);
    expect(outcome.ok).toBe(false);
    expect(outcome.resolvedRef).toBe("REF-001");
  });

  it("missing resolvedRef -> no tool call", async () => {
    const outcome = await executeAction("FIND_ALTERNATIVES", baseState);
    expect(mockedFindAlternatives).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(false);
  });
});

describe("executeAction — CHECK_PROMOTION", () => {
  it("success -> ok:true from found, system date supplied", async () => {
    mockedGetApplicablePromotion.mockResolvedValueOnce({ found: true, product, promotion: null });
    const outcome = await executeAction("CHECK_PROMOTION", stateWithRef);
    expect(outcome.ok).toBe(true);
    expect(mockedGetApplicablePromotion).toHaveBeenCalledWith("REF-001", expect.stringMatching(ISO_DATE));
  });

  it("product not found -> ok:false", async () => {
    mockedGetApplicablePromotion.mockResolvedValueOnce({ found: false, reason: "product_not_found", ref: "REF-001" });
    const outcome = await executeAction("CHECK_PROMOTION", stateWithRef);
    expect(outcome.ok).toBe(false);
  });

  it("missing resolvedRef -> no tool call", async () => {
    await executeAction("CHECK_PROMOTION", baseState);
    expect(mockedGetApplicablePromotion).not.toHaveBeenCalled();
  });
});

describe("executeAction — VALIDATE_DISCOUNT (TASK-036)", () => {
  const stateWithDiscountRequest: M3AKState = {
    ...stateWithRef,
    extraction: { ...stateWithRef.extraction, requestedPriceMad: 150 },
  };

  it("converts the requested MAD price to cents deterministically (never by the LLM) before calling the real tool", async () => {
    mockedValidateDiscount.mockResolvedValueOnce({
      allowed: true, productRef: "REF-001", basePriceCents: 19995, minimumAllowedPriceCents: 17996,
      requestedPriceCents: 15000, reason: "within_discretionary_limit",
    });

    const outcome = await executeAction("VALIDATE_DISCOUNT", stateWithDiscountRequest);

    expect(mockedValidateDiscount).toHaveBeenCalledWith("REF-001", 15000, expect.stringMatching(ISO_DATE));
    expect(outcome.ok).toBe(true);
    expect(outcome.resolvedRef).toBe("REF-001");
  });

  it("a discount within the system's own limit is a positive outcome", async () => {
    mockedValidateDiscount.mockResolvedValueOnce({
      allowed: true, productRef: "REF-001", basePriceCents: 19995, minimumAllowedPriceCents: 17996,
      requestedPriceCents: 18000, reason: "within_discretionary_limit",
    });
    const outcome = await executeAction("VALIDATE_DISCOUNT", stateWithDiscountRequest);
    expect(outcome.ok).toBe(true);
  });

  it("a discount exceeding the system's limit is a negative outcome requiring escalation — never authorized here", async () => {
    mockedValidateDiscount.mockResolvedValueOnce({
      allowed: false, requiresEscalation: true, productRef: "REF-001", basePriceCents: 19995,
      minimumAllowedPriceCents: 17996, requestedPriceCents: 10000, reason: "discount_exceeds_limit",
    });
    const outcome = await executeAction("VALIDATE_DISCOUNT", stateWithDiscountRequest);
    expect(outcome.ok).toBe(false);
    expect((outcome.result as { requiresEscalation: boolean }).requiresEscalation).toBe(true);
  });

  it("missing resolvedRef -> no tool call", async () => {
    const outcome = await executeAction("VALIDATE_DISCOUNT", { ...baseState, extraction: { ...baseState.extraction, requestedPriceMad: 150 } });
    expect(mockedValidateDiscount).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(false);
  });

  it("missing requestedPriceMad -> no tool call (never invents a discount request)", async () => {
    const outcome = await executeAction("VALIDATE_DISCOUNT", stateWithRef);
    expect(mockedValidateDiscount).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(false);
  });
});

describe("executeAction — CHECK_DELIVERY", () => {
  it("success -> ok:true from found, city sourced from extraction", async () => {
    mockedGetDeliveryOptions.mockResolvedValueOnce({
      found: true,
      zone: { city: "Casablanca", fee: 25, delayHours: 24, cashOnDelivery: true, storePickup: false },
      feeCents: 2500,
    });
    const outcome = await executeAction("CHECK_DELIVERY", baseState);
    expect(outcome.ok).toBe(true);
    expect(mockedGetDeliveryOptions).toHaveBeenCalledWith("Casablanca");
  });

  it("city not in delivery grid -> ok:false", async () => {
    mockedGetDeliveryOptions.mockResolvedValueOnce({ found: false, city: "Casablanca", reason: "city_not_in_delivery_grid" });
    const outcome = await executeAction("CHECK_DELIVERY", baseState);
    expect(outcome.ok).toBe(false);
  });

  it("missing city -> no tool call", async () => {
    const stateNoCity: M3AKState = { ...baseState, extraction: { ...baseState.extraction, city: null } };
    const outcome = await executeAction("CHECK_DELIVERY", stateNoCity);
    expect(mockedGetDeliveryOptions).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(false);
  });
});

describe("executeAction — CHECK_DELIVERY customerMemory city fallback (TASK-025)", () => {
  const SAMPLE_MEMORY = {
    city: "Marrakech",
    preferredLanguage: null,
    totalKnownOrders: 1,
    latestOrderDate: null,
    recentProducts: [],
  };

  it("1: extraction.city present + a different memory.city -> extraction.city wins", async () => {
    mockedGetDeliveryOptions.mockResolvedValueOnce({
      found: true,
      zone: { city: "Casablanca", fee: 25, delayHours: 24, cashOnDelivery: true, storePickup: false },
      feeCents: 2500,
    });
    const state: M3AKState = { ...baseState, customerMemory: SAMPLE_MEMORY };

    await executeAction("CHECK_DELIVERY", state);

    expect(mockedGetDeliveryOptions).toHaveBeenCalledWith("Casablanca");
  });

  it("2: extraction.city null + memory.city present -> memory city is used for CHECK_DELIVERY", async () => {
    mockedGetDeliveryOptions.mockResolvedValueOnce({
      found: true,
      zone: { city: "Marrakech", fee: 25, delayHours: 24, cashOnDelivery: true, storePickup: false },
      feeCents: 2500,
    });
    const state: M3AKState = {
      ...baseState,
      extraction: { ...baseState.extraction, city: null },
      customerMemory: SAMPLE_MEMORY,
    };

    const outcome = await executeAction("CHECK_DELIVERY", state);

    expect(mockedGetDeliveryOptions).toHaveBeenCalledWith("Marrakech");
    expect(outcome.ok).toBe(true);
  });

  it("3: both extraction.city and customerMemory absent -> existing missing-input behavior unchanged", async () => {
    const state: M3AKState = {
      ...baseState,
      extraction: { ...baseState.extraction, city: null },
      customerMemory: null,
    };

    const outcome = await executeAction("CHECK_DELIVERY", state);

    expect(mockedGetDeliveryOptions).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(false);
    expect(outcome.result).toEqual({ reason: "missing_required_input" });
  });

  it("4: falling back to memory city never mutates state.extraction.city", async () => {
    mockedGetDeliveryOptions.mockResolvedValueOnce({
      found: true,
      zone: { city: "Marrakech", fee: 25, delayHours: 24, cashOnDelivery: true, storePickup: false },
      feeCents: 2500,
    });
    const state: M3AKState = {
      ...baseState,
      extraction: { ...baseState.extraction, city: null },
      customerMemory: SAMPLE_MEMORY,
    };

    await executeAction("CHECK_DELIVERY", state);

    expect(state.extraction.city).toBeNull();
  });

  it("5: other actions remain unaffected by a populated customerMemory", async () => {
    const stateWithMemory: M3AKState = { ...stateWithRef, customerMemory: SAMPLE_MEMORY };
    mockedGetAvailability.mockResolvedValueOnce({ found: true, ref: "REF-001", stock: 5, available: true });

    const outcome = await executeAction("CHECK_STOCK", stateWithMemory);

    expect(outcome.ok).toBe(true);
    expect(mockedGetAvailability).toHaveBeenCalledWith("REF-001");
  });
});

describe("executeAction — CREATE_CART", () => {
  it("success promotes a real cart snapshot (id, version, items)", async () => {
    mockedCreateCart.mockResolvedValueOnce({
      created: true,
      cart: { id: "cart-1", conversationId: "conversation-020", status: "active", version: 0, items: [] },
    });
    const outcome = await executeAction("CREATE_CART", baseState);
    expect(outcome.ok).toBe(true);
    expect(outcome.cartPatch).toEqual({ id: "cart-1", version: 0, items: [] });
    expect(mockedCreateCart).toHaveBeenCalledWith("conversation-020");
  });

  it("conversation not found -> ok:false, no cartPatch", async () => {
    mockedCreateCart.mockResolvedValueOnce({ created: false, conversationId: "conversation-020", reason: "conversation_not_found" });
    const outcome = await executeAction("CREATE_CART", baseState);
    expect(outcome.ok).toBe(false);
    expect(outcome.cartPatch).toBeUndefined();
  });

  it("missing conversationId -> no tool call", async () => {
    const stateNoConversation: M3AKState = { ...baseState, conversationId: null };
    const outcome = await executeAction("CREATE_CART", stateNoConversation);
    expect(mockedCreateCart).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(false);
  });
});

describe("executeAction — ADD_TO_CART", () => {
  it("success promotes the updated cart snapshot", async () => {
    mockedAddCartItem.mockResolvedValueOnce({
      ok: true,
      cart: {
        id: "cart-1", conversationId: "conversation-020", status: "active", version: 1,
        items: [{ productRef: "REF-001", quantity: 2, unitPrice: 199.95 }],
      },
    });
    const outcome = await executeAction("ADD_TO_CART", stateWithCart);
    expect(outcome.ok).toBe(true);
    expect(outcome.cartPatch).toEqual({ id: "cart-1", version: 1, items: [{ productRef: "REF-001", quantity: 2, unitPrice: 199.95 }] });
    expect(mockedAddCartItem).toHaveBeenCalledWith("cart-1", "REF-001", 2, expect.stringMatching(ISO_DATE));
  });

  it("insufficient stock -> ok:false, no cartPatch", async () => {
    mockedAddCartItem.mockResolvedValueOnce({ ok: false, reason: "insufficient_stock", requestedQuantity: 2, availableStock: 1 });
    const outcome = await executeAction("ADD_TO_CART", stateWithCart);
    expect(outcome.ok).toBe(false);
    expect(outcome.cartPatch).toBeUndefined();
  });

  it("no cart yet -> no tool call", async () => {
    const outcome = await executeAction("ADD_TO_CART", stateWithRef);
    expect(mockedAddCartItem).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(false);
  });

  it("missing quantity -> no tool call", async () => {
    const stateNoQuantity: M3AKState = { ...stateWithCart, extraction: { ...stateWithCart.extraction, quantity: null } };
    const outcome = await executeAction("ADD_TO_CART", stateNoQuantity);
    expect(mockedAddCartItem).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(false);
  });
});

describe("executeAction — UPDATE_CART_ITEM (TASK-035)", () => {
  it("success promotes the updated cart snapshot, replacing (not accumulating) the quantity", async () => {
    mockedUpdateCartItem.mockResolvedValueOnce({
      ok: true,
      cart: {
        id: "cart-1", conversationId: "conversation-020", status: "active", version: 2,
        items: [{ productRef: "REF-001", quantity: 3, unitPrice: 199.95 }],
      },
    });
    const state: M3AKState = { ...stateWithMatchingCartItem, extraction: { ...stateWithMatchingCartItem.extraction, quantity: 3 } };

    const outcome = await executeAction("UPDATE_CART_ITEM", state);

    expect(outcome.ok).toBe(true);
    expect(outcome.cartPatch).toEqual({ id: "cart-1", version: 2, items: [{ productRef: "REF-001", quantity: 3, unitPrice: 199.95 }] });
    expect(mockedUpdateCartItem).toHaveBeenCalledWith("cart-1", "REF-001", 3);
  });

  it("insufficient stock -> ok:false, no cartPatch", async () => {
    mockedUpdateCartItem.mockResolvedValueOnce({ ok: false, reason: "insufficient_stock", requestedQuantity: 9, availableStock: 2 });
    const state: M3AKState = { ...stateWithMatchingCartItem, extraction: { ...stateWithMatchingCartItem.extraction, quantity: 9 } };

    const outcome = await executeAction("UPDATE_CART_ITEM", state);

    expect(outcome.ok).toBe(false);
    expect(outcome.cartPatch).toBeUndefined();
  });

  it("no cart yet -> no tool call", async () => {
    const outcome = await executeAction("UPDATE_CART_ITEM", stateWithRef);
    expect(mockedUpdateCartItem).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(false);
  });

  it("missing quantity -> no tool call", async () => {
    const stateNoQuantity: M3AKState = { ...stateWithMatchingCartItem, extraction: { ...stateWithMatchingCartItem.extraction, quantity: null } };
    const outcome = await executeAction("UPDATE_CART_ITEM", stateNoQuantity);
    expect(mockedUpdateCartItem).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(false);
  });

  it("no carriedRef -> no tool call", async () => {
    const stateNoRef: M3AKState = { ...baseState, cart: { id: "cart-1", version: 1, items: [{ productRef: "REF-001", quantity: 1, unitPrice: 199.95 }] } };
    const outcome = await executeAction("UPDATE_CART_ITEM", stateNoRef);
    expect(mockedUpdateCartItem).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(false);
  });
});

describe("executeAction — REMOVE_CART_ITEM (TASK-035)", () => {
  it("removes exactly the stale item (a different ref than the freshly resolved one) and promotes the updated cart", async () => {
    mockedRemoveCartItem.mockResolvedValueOnce({
      removed: true,
      cart: { id: "cart-1", conversationId: "conversation-020", status: "active", version: 2, items: [] },
    });

    const outcome = await executeAction("REMOVE_CART_ITEM", stateWithStaleCartItem);

    expect(outcome.ok).toBe(true);
    expect(outcome.cartPatch).toEqual({ id: "cart-1", version: 2, items: [] });
    // The OLD ref is what gets removed — never the freshly resolved carriedRef.
    expect(mockedRemoveCartItem).toHaveBeenCalledWith("cart-1", "REF-OLD-SIZE-L");
    expect(mockedRemoveCartItem).not.toHaveBeenCalledWith("cart-1", "REF-001");
    // extraction.quantity was already known (baseState: 2) — never overridden.
    expect(outcome.extractionPatch).toBeUndefined();
  });

  it("TASK-035: carries the removed item's real quantity forward when the customer never restated one", async () => {
    const stateNoQuantity: M3AKState = {
      ...stateWithStaleCartItem,
      extraction: { ...stateWithStaleCartItem.extraction, quantity: null },
      cart: { id: "cart-1", version: 1, items: [{ productRef: "REF-OLD-SIZE-L", quantity: 3, unitPrice: 189.95 }] },
    };
    mockedRemoveCartItem.mockResolvedValueOnce({
      removed: true,
      cart: { id: "cart-1", conversationId: "conversation-020", status: "active", version: 2, items: [] },
    });

    const outcome = await executeAction("REMOVE_CART_ITEM", stateNoQuantity);

    expect(outcome.extractionPatch).toEqual({ quantity: 3 });
  });

  it("item not in cart -> ok:false, no cartPatch", async () => {
    mockedRemoveCartItem.mockResolvedValueOnce({ removed: false, reason: "item_not_in_cart" });
    const outcome = await executeAction("REMOVE_CART_ITEM", stateWithStaleCartItem);
    expect(outcome.ok).toBe(false);
    expect(outcome.cartPatch).toBeUndefined();
  });

  it("no cart yet -> no tool call", async () => {
    const outcome = await executeAction("REMOVE_CART_ITEM", stateWithRef);
    expect(mockedRemoveCartItem).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(false);
  });

  it("no carriedRef -> no tool call", async () => {
    const stateNoRef: M3AKState = { ...baseState, cart: { id: "cart-1", version: 1, items: [{ productRef: "REF-OLD-SIZE-L", quantity: 1, unitPrice: 189.95 }] } };
    const outcome = await executeAction("REMOVE_CART_ITEM", stateNoRef);
    expect(mockedRemoveCartItem).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(false);
  });

  it("nothing stale (cart already matches carriedRef) -> no tool call, never guesses", async () => {
    const outcome = await executeAction("REMOVE_CART_ITEM", stateWithMatchingCartItem);
    expect(mockedRemoveCartItem).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(false);
  });

  it("ambiguous (more than one stale item) -> no tool call, never guesses which one", async () => {
    const stateAmbiguous: M3AKState = {
      ...stateWithRef,
      cart: {
        id: "cart-1", version: 1,
        items: [
          { productRef: "REF-OLD-A", quantity: 1, unitPrice: 189.95 },
          { productRef: "REF-OLD-B", quantity: 1, unitPrice: 179.95 },
        ],
      },
    };
    const outcome = await executeAction("REMOVE_CART_ITEM", stateAmbiguous);
    expect(mockedRemoveCartItem).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(false);
  });
});

describe("executeAction — CREATE_ORDER", () => {
  it("success promotes the real order id", async () => {
    mockedCreateOrder.mockResolvedValueOnce({
      created: true,
      replayed: false,
      order: {
        id: "order-1", customerId: "customer-1", conversationId: "conversation-020", status: "confirmed",
        productsTotal: 199.95, deliveryFee: 25, total: 224.95, city: "Casablanca", paymentMethod: "cash_on_delivery",
        items: [{ productRef: "REF-001", quantity: 2, unitPrice: 199.95 }], createdAt: "2026-09-19T00:00:00.000Z",
      },
    });
    const outcome = await executeAction("CREATE_ORDER", stateWithCart);
    expect(outcome.ok).toBe(true);
    expect(outcome.orderId).toBe("order-1");
    expect(mockedCreateOrder).toHaveBeenCalledWith("cart-1", true, "Casablanca", "cash_on_delivery", expect.stringMatching(ISO_DATE));
  });

  it("empty cart -> ok:false, no orderId", async () => {
    mockedCreateOrder.mockResolvedValueOnce({ created: false, reason: "empty_cart" });
    const outcome = await executeAction("CREATE_ORDER", stateWithCart);
    expect(outcome.ok).toBe(false);
    expect(outcome.orderId).toBeUndefined();
  });

  it("missing confirmation (null, unknown) -> no tool call", async () => {
    const stateNoConfirmation: M3AKState = { ...stateWithCart, extraction: { ...stateWithCart.extraction, confirmation: null } };
    const outcome = await executeAction("CREATE_ORDER", stateNoConfirmation);
    expect(mockedCreateOrder).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(false);
  });

  it("no cart yet -> no tool call", async () => {
    const outcome = await executeAction("CREATE_ORDER", stateWithRef);
    expect(mockedCreateOrder).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(false);
  });

  it("6 (TASK-025): a null extraction.city is NOT filled in from customerMemory.city — CREATE_ORDER's contract is not broadened", async () => {
    const stateNoCityWithMemory: M3AKState = {
      ...stateWithCart,
      extraction: { ...stateWithCart.extraction, city: null },
      customerMemory: { city: "Marrakech", preferredLanguage: null, totalKnownOrders: 1, latestOrderDate: null, recentProducts: [] },
    };

    const outcome = await executeAction("CREATE_ORDER", stateNoCityWithMemory);

    expect(mockedCreateOrder).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(false);
    expect(outcome.result).toEqual({ reason: "missing_required_input" });
  });
});

describe("executeAction — terminal actions never dispatch", () => {
  it("RESPOND throws instead of executing", async () => {
    await expect(executeAction("RESPOND", baseState)).rejects.toThrow();
  });

  it("ESCALATE throws instead of executing", async () => {
    await expect(executeAction("ESCALATE", baseState)).rejects.toThrow();
  });
});

describe("executeAction — unexpected errors propagate", () => {
  it("an unexpected thrown error from the underlying tool is not swallowed", async () => {
    mockedGetAvailability.mockRejectedValueOnce(new Error("DB connection lost"));
    await expect(executeAction("CHECK_STOCK", stateWithRef)).rejects.toThrow("DB connection lost");
  });
});

describe("executeAction — JSON-safety", () => {
  it("every outcome is JSON-serializable", async () => {
    mockedSearchProducts.mockResolvedValueOnce([product]);
    const outcome = await executeAction("SEARCH_PRODUCTS", baseState);
    expect(() => JSON.stringify(outcome)).not.toThrow();
    const roundTripped = JSON.parse(JSON.stringify(outcome)) as unknown;
    expect(roundTripped).toEqual(JSON.parse(JSON.stringify(outcome)));
  });
});
