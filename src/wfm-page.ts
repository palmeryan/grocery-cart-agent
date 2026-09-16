import type { Locator, Page } from "playwright";

export interface ProductCandidate {
  id: string;
  productName: string;
  packageSize: string | null;
  price: string | null;
  available: boolean | null;
  text: string;
}

export class WfmPageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WfmPageError";
  }
}

export class UnknownControlError extends WfmPageError {}

const SEARCH_URL = "https://www.wholefoodsmarket.com/grocery/search";
const WFM_HOSTS = new Set(["www.wholefoodsmarket.com", "wholefoodsmarket.com"]);

function ensureWfmPage(page: Page, searchPage = false): void {
  const url = new URL(page.url());
  if (!WFM_HOSTS.has(url.hostname)) {
    throw new WfmPageError(`Refusing to operate outside Whole Foods: ${page.url()}`);
  }
  if (searchPage && !url.pathname.startsWith("/grocery/search")) {
    throw new WfmPageError(`Expected Whole Foods search page, got ${page.url()}`);
  }
}

function asinFromHref(href: string | null): string | null {
  const match = href?.match(/\/grocery\/product\/[^/?#]+-([A-Za-z0-9]{10})(?:[?/#]|$)/i);
  return match?.[1] ?? null;
}

function cardLocators(page: Page): Locator {
  // Current WFM renders each result as a product link with its Add button in
  // the immediately containing generic div (there is no stable card role).
  return page.locator("a[href*='/grocery/product/']").locator("..");
}

/** Search the current WFM search page and wait for cards or an empty-result message. */
export async function searchProducts(page: Page, query: string): Promise<ProductCandidate[]> {
  ensureWfmPage(page, true);
  const input = page.getByRole("combobox", { name: "Search" }).first();
  if (await input.count() === 0) {
    throw new UnknownControlError("Whole Foods search textbox was not found");
  }
  await input.fill(query);
  const expected = new URL(SEARCH_URL);
  expected.searchParams.set("k", query);
  await input.press("Enter");
  // WFM updates `k` during the search navigation. Waiting for that transition
  // prevents an already-rendered result card from being returned for a new
  // query. If the transition does not occur, fail rather than return stale
  // results from the preceding search.
  await page.waitForURL(
    (url) => url.hostname.endsWith("wholefoodsmarket.com") &&
      url.pathname.startsWith("/grocery/search") &&
      url.searchParams.get("k") === expected.searchParams.get("k"),
    { timeout: 10_000 },
  );
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  ensureWfmPage(page);
  await page.waitForFunction(
    () => document.querySelector("a[href*='/grocery/product/']") !== null ||
      /(?:no|0) results|couldn.t find|did not match/i.test(document.body.innerText),
    undefined,
    { timeout: 10_000 },
  );
  return extractCandidates(page);
}

/** Read visible, ASIN-addressable WFM result cards. */
export async function extractCandidates(page: Page): Promise<ProductCandidate[]> {
  ensureWfmPage(page, true);
  const cards = cardLocators(page);
  const count = await cards.count();
  const result: ProductCandidate[] = [];
  for (let index = 0; index < count; index += 1) {
    const card = cards.nth(index);
    if (!(await card.isVisible().catch(() => false))) continue;
    const data = await card.evaluate((node) => {
      const element = node as HTMLElement;
      const link = element.querySelector<HTMLAnchorElement>("a[href*='/grocery/product/']") ??
        (element.matches("a[href*='/grocery/product/']") ? element as HTMLAnchorElement : null);
      const asin = element.getAttribute("data-asin") ?? element.getAttribute("data-product-asin");
      const text = element.innerText.replace(/\s+/g, " ").trim();
      const labelled = (selector: string): string | null =>
        element.querySelector<HTMLElement>(selector)?.innerText.trim() || null;
      return {
        asin: asin ?? (link ? link.getAttribute("href") : null),
        name: labelled("[data-testid*='product-name'], [data-testid*='productName'], h2, h3") ??
          (link?.innerText.split("\n").map((line) => line.trim()).filter(Boolean)[1] ?? ""),
        size: labelled("[data-testid*='size'], [data-testid*='Size'], [class*='size']") ??
          (link?.innerText.match(/\b\d+(?:\.\d+)?\s*(?:oz|ounce|ounces|lb|lbs|pound|pounds|g|kg)\b/i)?.[0] ?? null),
        price: labelled("[data-testid*='price'], [data-testid*='Price'], [class*='price']") ??
          (text.match(/\$\s*\d+(?:\.\d{2})?/)?.[0] ?? null),
        text,
        hasAdd: [...element.querySelectorAll("button")].some((button) => /add\s*to\s*cart/i.test(button.innerText || button.getAttribute("aria-label") || "")),
        hasIncrease: [...element.querySelectorAll("button")].some((button) => /increase quantity/i.test(button.getAttribute("aria-label") || button.innerText)),
      };
    });
    const id = data.asin?.includes("/product/") ? asinFromHref(data.asin) : data.asin;
    if (!id) continue;
    const availability = /out of stock|unavailable|not available/i.test(data.text)
      ? false
      : data.hasAdd || data.hasIncrease || /in stock|available/i.test(data.text)
        ? true
        : null;
    result.push({
      id,
      productName: data.name,
      packageSize: data.size,
      price: data.price,
      available: availability,
      text: data.text,
    });
  }
  return result;
}

function safeId(id: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new WfmPageError(`Invalid candidate ID: ${id}`);
}

function candidateCard(page: Page, id: string): Locator {
  safeId(id);
  return page.locator(`a[href*="/grocery/product/"][href*="-${id}"]`).locator("..").first();
}

/** Add a current result-card candidate; quantity controls must be card-associated. */
export async function addCandidate(
  page: Page,
  candidate: ProductCandidate | string,
  quantity = 1,
  option?: string,
): Promise<void> {
  ensureWfmPage(page, true);
  const id = typeof candidate === "string" ? candidate : candidate.id;
  safeId(id);
  if (!Number.isInteger(quantity) || quantity < 1) throw new WfmPageError("Quantity must be a positive integer");
  const card = candidateCard(page, id);
  if (await card.count() === 0 || !(await card.isVisible().catch(() => false))) {
    throw new WfmPageError(`Candidate ${id} is not in the current visible results`);
  }
  if (option !== undefined) {
    const optionControl = card.getByRole("combobox", { name: /size|option|varian/i }).first();
    if (await optionControl.count() === 0) throw new UnknownControlError(`No option control for candidate ${id}`);
    await optionControl.selectOption({ label: option });
  }
  const qtyInput = card.locator("input[type='number'], input[aria-label*='quantity' i]").first();
  const hasQtyInput = await qtyInput.count() > 0 && await qtyInput.isVisible().catch(() => false);
  const add = card.getByRole("button", { name: /add\s*(to cart)?/i }).first();
  const hasAdd = await add.count() > 0 && await add.isVisible().catch(() => false);
  if (hasAdd && hasQtyInput) await qtyInput.fill(String(quantity));
  if (hasAdd) await add.click();
  const increase = card.getByRole("button", { name: "Increase quantity" });
  if (!hasAdd && await increase.count() === 0) {
    throw new UnknownControlError(`No add or increase control for candidate ${id}`);
  }
  const increases = hasAdd && hasQtyInput ? 0 : hasAdd ? quantity - 1 : quantity;
  for (let count = 0; count < increases; count += 1) {
    await increase.waitFor({ state: "visible", timeout: 5_000 });
    await increase.click();
  }
}
