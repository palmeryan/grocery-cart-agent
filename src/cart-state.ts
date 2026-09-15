import type { Page } from "playwright";
import type { CartItemSnapshot } from "./types.js";

/** A small seam that works with Playwright, a CDP-backed page, or a test double. */
export interface CartPageAdapter {
  getUrl(): string | Promise<string>;
  evaluate<T>(pageFunction: () => T): Promise<T>;
  /** Navigation is optional so read-only inspection can be limited to the current page. */
  navigate?(url: string): Promise<void>;
}

/** The deliberately plain data returned by the browser-side DOM reader. */
export interface CartPageObservation {
  rows: CartItemRow[];
  emptyState: boolean;
  displayedItemCount: number | null;
  bodyText: string;
  extractionStatus: "complete" | "degraded";
  extractionDiagnostic: string | null;
}

export interface CartItemRow {
  productName?: unknown;
  quantity?: unknown;
  text?: unknown;
}

export interface CartInspectionResult {
  items: CartItemSnapshot[];
  totalItemCount: number;
  url: string;
  bodyText: string;
  extractionStatus?: "complete" | "degraded";
  extractionDiagnostic?: string | null;
}

export interface InspectCartOptions {
  /** The only URL this module may navigate to. */
  cartUrl?: string;
  /** Defaults to true; navigation is one isolated, non-mutating goto before inspection. */
  navigateToCart?: boolean;
}

export type CartVerificationErrorCode =
  | "unsupported_page"
  | "navigation_unavailable"
  | "cart_page_unverified"
  | "item_extraction_unreliable"
  | "count_mismatch";

export class CartStateVerificationError extends Error {
  constructor(
    message: string,
    readonly code: CartVerificationErrorCode,
  ) {
    super(message);
    this.name = "CartStateVerificationError";
  }
}

const DEFAULT_CART_URL = "https://www.wholefoodsmarket.com/grocery/cart";
const WHOLE_FOODS_HOST = /(^|\.)wholefoodsmarket\.com$/i;

function asTrimmedText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > 0 ? text : null;
}

/** Parse only unambiguous positive integer quantities; prices and decimals are rejected. */
export function parseCartQuantity(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  const text = asTrimmedText(value);
  if (text === null) return null;

  if (/^\d+$/.test(text)) {
    const quantity = Number(text);
    return Number.isSafeInteger(quantity) && quantity > 0 ? quantity : null;
  }

  const labelled = [...text.matchAll(/\b(?:qty|quantity)\s*(?::|=|is)?\s*(\d+)\b/gi)];
  if (labelled.length !== 1) return null;
  const quantity = Number(labelled[0]?.[1]);
  return Number.isSafeInteger(quantity) && quantity > 0 ? quantity : null;
}

/** Product names are kept human-readable but normalized for safe comparisons. */
export function parseCartProductName(value: unknown): string | null {
  const text = asTrimmedText(value);
  if (text === null) return null;
  if (/^(?:your\s+)?cart(?:\s+items?)?$/i.test(text)) return null;
  return text;
}

function productKey(productName: string): string {
  return productName.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function aggregateItems(items: readonly CartItemSnapshot[]): Map<string, CartItemSnapshot> {
  const result = new Map<string, CartItemSnapshot>();
  for (const item of items) {
    const productName = parseCartProductName(item.productName);
    const quantity = parseCartQuantity(item.quantity);
    if (productName === null || quantity === null) {
      throw new CartStateVerificationError(
        "Cart item snapshot has an invalid product name or quantity",
        "item_extraction_unreliable",
      );
    }
    const key = productKey(productName);
    const previous = result.get(key);
    result.set(key, {
      productName: previous?.productName ?? productName,
      quantity: (previous?.quantity ?? 0) + quantity,
    });
  }
  return result;
}

/**
 * Convert browser-extracted rows into verified snapshots.
 *
 * A row without both an unambiguous name and quantity fails the whole read. That
 * conservative behavior prevents a partial DOM read from being mistaken for a
 * safe cart baseline.
 */
export function parseCartItemRows(rows: readonly CartItemRow[]): CartItemSnapshot[] {
  return rows.map((row) => {
    const productName = parseCartProductName(row.productName);
    const quantity = parseCartQuantity(row.quantity) ?? parseCartQuantity(row.text);
    if (productName === null || quantity === null) {
      throw new CartStateVerificationError(
        "One or more cart rows could not be verified as a product and positive quantity",
        "item_extraction_unreliable",
      );
    }
    return { productName, quantity };
  });
}

/** Alias named for callers that already have raw cart-item records. */
export const parseCartItemSnapshots = parseCartItemRows;

export function getTotalItemCount(items: readonly CartItemSnapshot[]): number {
  return [...aggregateItems(items).values()].reduce((total, item) => total + item.quantity, 0);
}

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const normalizedSearchLines = (value: string): string[] =>
  value
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0);

/**
 * Match an agent-reported item against visible cart text. This is deliberately
 * a final read-only check: the agent chooses the product, while the harness
 * confirms that the reported name and quantity are visible in the cart.
 */
export function cartTextContainsSelection(
  bodyText: string,
  productName: string,
  quantity: number,
): boolean {
  if (!productName.trim() || !Number.isSafeInteger(quantity) || quantity < 1) {
    return false;
  }
  const lines = normalizedSearchLines(bodyText);
  const namePattern = productName
    .trim()
    .split(/\s+/)
    .map(escapeRegExp)
    .join("\\s+");
  const nameRegex = new RegExp(`(?:^|[^\\p{L}\\p{N}])${namePattern}(?=$|[^\\p{L}\\p{N}])`, "iu");
  const quantityPattern = escapeRegExp(String(quantity));
  const labelledQuantity = new RegExp(
    `\\b(?:current\\s+)?(?:quantity|qty)\\s*[:=]?\\s*${quantityPattern}\\b`,
    "i",
  );
  const itemCount = new RegExp(
    `\\b${quantityPattern}\\b\\s*(?:item|items|quantity)\\b`,
    "i",
  );
  const standaloneQuantity = new RegExp(`^\\s*${quantityPattern}\\s*$`, "i");

  for (let index = 0; index < lines.length; index += 1) {
    if (!nameRegex.test(lines[index] ?? "")) continue;
    // Cart rows are normally represented by a few adjacent text lines. Keep
    // the fallback local so a quantity from a different item cannot satisfy
    // this result merely because it appears elsewhere on the page.
    const nearbyLines = lines.slice(index, index + 3);
    const nearbyText = nearbyLines.join(" ");
    if (labelledQuantity.test(nearbyText) || itemCount.test(nearbyText)) return true;
    if (nearbyLines.some((line) => standaloneQuantity.test(line))) return true;
  }
  return false;
}

/**
 * Return only newly added units. Existing items are preserved, and a quantity
 * increase is represented by its positive difference (not the final quantity).
 * Decreases are never treated as additions.
 */
export function computeCartDelta(
  before: readonly CartItemSnapshot[],
  after: readonly CartItemSnapshot[],
): CartItemSnapshot[] {
  const beforeByProduct = aggregateItems(before);
  const afterByProduct = aggregateItems(after);
  const delta: CartItemSnapshot[] = [];

  for (const [key, finalItem] of afterByProduct) {
    const previousQuantity = beforeByProduct.get(key)?.quantity ?? 0;
    const increase = finalItem.quantity - previousQuantity;
    if (increase > 0) {
      delta.push({ productName: finalItem.productName, quantity: increase });
    }
  }
  return delta;
}

function parseCartUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CartStateVerificationError(`Unsupported browser URL: ${value}`, "unsupported_page");
  }
  if (url.protocol !== "https:" || !WHOLE_FOODS_HOST.test(url.hostname)) {
    throw new CartStateVerificationError(
      `Cart inspection is restricted to wholefoodsmarket.com, got ${url.origin}`,
      "unsupported_page",
    );
  }
  return url;
}

function isCartUrl(value: string): boolean {
  const url = parseCartUrl(value);
  return /(?:^|\/)cart(?:\/|$)/i.test(url.pathname);
}

/**
 * Browser-side, product-agnostic DOM extraction. It anchors each row on a
 * product-title node, then finds the smallest ancestor containing exactly one
 * quantity control. The function has no navigation or click side effects.
 *
 * Extraction is deliberately best-effort: the body text is still returned if
 * the structured rows cannot be established, with a local diagnostic for the
 * caller to decide whether to note or fail.
 */
export function collectCartPageObservation(): CartPageObservation {
  const bodyText = document.body?.innerText ?? "";
  const emptyState = /(?:your\s+)?cart\s+is\s+empty|no\s+items?\s+in\s+(?:your\s+)?cart/i.test(bodyText);
  const titleSelector = '[class*="cart-item-image-title-container" i]';
  const quantityCandidateSelector = '[aria-label="Enter Quantity"]';
  const rows: CartItemRow[] = [];
  const diagnostics: string[] = [];
  const seenGroups = new Set<Element>();
  const titleNodes = document.querySelectorAll(titleSelector);

  for (const titleNode of titleNodes) {
    const productName =
      titleNode.textContent?.replace(/\s+/g, " ").trim() ||
      titleNode.getAttribute("aria-label") ||
      undefined;
    let group: Element | null = null;
    let control: Element | null = null;

    for (let ancestor = titleNode.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
      const controls = ancestor.querySelectorAll(quantityCandidateSelector);
      if (controls.length === 1) {
        group = ancestor;
        control = controls[0] ?? null;
        break;
      }
    }

    if (group === null || control === null) {
      diagnostics.push("A product-title node had no ancestor with exactly one quantity control");
      continue;
    }
    // A nested title marker can point at the same item group; do not duplicate it.
    if (seenGroups.has(group)) continue;
    seenGroups.add(group);

    const rowText = group.textContent?.replace(/\s+/g, " ").trim() || undefined;
    const tagName = control.tagName.toLowerCase();
    const controlValue = (control as HTMLInputElement | HTMLSelectElement).value;
    let quantity: string | undefined = controlValue || undefined;
    if (quantity === undefined && tagName === "select") {
      quantity =
        (control as HTMLSelectElement).selectedOptions[0]?.textContent?.replace(/\s+/g, " ").trim() ||
        undefined;
    }
    if (quantity === undefined) {
      quantity =
        control.getAttribute("value") ||
        control.getAttribute("aria-label") ||
        control.getAttribute("title") ||
        control.textContent?.replace(/\s+/g, " ").trim() ||
        rowText?.match(/\b(?:qty|quantity)\s*(?::|=|is)?\s*\d+\b/i)?.[0];
    }
    if (productName === undefined || quantity === undefined) {
      diagnostics.push("A product-title group was missing a product name or quantity value");
    }
    if (productName !== undefined || quantity !== undefined) {
      rows.push({ productName, quantity, text: rowText });
    }
  }

  if (titleNodes.length === 0 && !emptyState) {
    diagnostics.push("The cart page did not expose any product-title nodes");
  }

  const countElement = document.querySelector(
    '[data-testid*="cart-count" i], [id*="cart-count" i]',
  );
  const countText =
    countElement?.getAttribute("aria-label") ||
    countElement?.textContent?.replace(/\s+/g, " ").trim();
  const countMatch = countText?.match(/\b(\d+)\b/);
  // Keep this conversion local: Playwright serializes this evaluator into the page.
  const parsedCount = countMatch?.[1] === undefined ? null : Number(countMatch[1]);
  const displayedItemCount =
    parsedCount !== null && Number.isSafeInteger(parsedCount) && parsedCount >= 0
      ? parsedCount
      : null;
  return {
    rows,
    emptyState,
    displayedItemCount,
    bodyText,
    extractionStatus: diagnostics.length === 0 ? "complete" : "degraded",
    extractionDiagnostic: diagnostics.length === 0 ? null : diagnostics.join("; "),
  };
}

/** Inspect the current Whole Foods cart without clicking, adding, removing, or changing quantities. */
export async function inspectCartState(
  adapter: CartPageAdapter,
  options: InspectCartOptions = {},
): Promise<CartInspectionResult> {
  const cartUrl = options.cartUrl ?? DEFAULT_CART_URL;
  parseCartUrl(cartUrl);
  let url = await adapter.getUrl();
  parseCartUrl(url);

  if (!isCartUrl(url)) {
    if (options.navigateToCart === false) {
      throw new CartStateVerificationError(
        "Current Whole Foods page is not the cart and navigation was disabled",
        "cart_page_unverified",
      );
    }
    if (adapter.navigate === undefined) {
      throw new CartStateVerificationError(
        "Current page is not the cart and the injected adapter cannot navigate",
        "navigation_unavailable",
      );
    }
    await adapter.navigate(cartUrl);
    url = await adapter.getUrl();
    parseCartUrl(url);
  }

  if (!isCartUrl(url)) {
    throw new CartStateVerificationError(
      `Navigation did not leave the browser on a Whole Foods cart page: ${url}`,
      "cart_page_unverified",
    );
  }

  const observation = await adapter.evaluate(collectCartPageObservation);
  if (!observation || !Array.isArray(observation.rows)) {
    throw new CartStateVerificationError(
      "The cart page returned no verifiable item-row observation",
      "cart_page_unverified",
    );
  }
  const observationStatus = observation.extractionStatus ??
    (observation.rows.length === 0 && !observation.emptyState ? "degraded" : "complete");
  const observationDiagnostic = observation.extractionDiagnostic ??
    (observationStatus === "degraded"
      ? "The cart page did not expose verifiable item rows or an explicit empty-cart state"
      : null);
  if (observationStatus === "degraded") {
    return {
      items: [],
      totalItemCount: 0,
      url,
      bodyText: observation.bodyText,
      extractionStatus: "degraded",
      extractionDiagnostic: observationDiagnostic,
    };
  }

  let items: CartItemSnapshot[];
  try {
    items = parseCartItemRows(observation.rows);
  } catch (error) {
    return {
      items: [],
      totalItemCount: 0,
      url,
      bodyText: observation.bodyText,
      extractionStatus: "degraded",
      extractionDiagnostic:
        error instanceof Error
          ? error.message
          : "The cart page returned an unreliable item-row observation",
    };
  }
  const totalItemCount = getTotalItemCount(items);
  if (
    observation.displayedItemCount !== null &&
    observation.displayedItemCount !== totalItemCount
  ) {
    return {
      items: [],
      totalItemCount: 0,
      url,
      bodyText: observation.bodyText,
      extractionStatus: "degraded",
      extractionDiagnostic:
        `Cart count mismatch: page displayed ${observation.displayedItemCount}, extracted ${totalItemCount}`,
    };
  }
  return {
    items,
    totalItemCount,
    url,
    bodyText: observation.bodyText,
    extractionStatus: "complete",
    extractionDiagnostic: null,
  };
}

/** Adapt an already-connected Playwright Page; this function never launches a browser. */
export function createPlaywrightCartPageAdapter(
  page: Pick<Page, "url" | "evaluate" | "goto">,
): CartPageAdapter {
  return {
    getUrl: () => page.url(),
    evaluate: <T>(pageFunction: () => T) => page.evaluate(pageFunction),
    navigate: async (url) => {
      let lastError: unknown;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await page.goto(url, { waitUntil: "domcontentloaded" });
          return;
        } catch (error) {
          lastError = error;
          // Whole Foods can abort a client-side navigation after the document
          // has already reached the cart. Do not retry or fail in that case.
          if (isCartUrl(page.url())) return;
          if (attempt === 0) {
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        }
      }
      throw lastError instanceof Error
        ? lastError
        : new Error(`Could not navigate to the cart: ${url}`);
    },
  };
}
