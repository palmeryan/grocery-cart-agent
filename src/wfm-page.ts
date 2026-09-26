import type { Locator, Page } from "playwright";

export interface ProductCandidate {
  id: string;
  productName: string;
  packageSize: string | null;
  price: string | null;
  available: boolean | null;
  text: string;
}

export interface QuantityOption {
  quantity: number;
  label: string;
}

export interface AddCandidateResult {
  quantity: number;
  weighted: boolean;
}

export function parseSelectedPackSize(text: string): string | null {
  return /Select Size:\s*(\d+(?:\.\d+)?\s*(?:Pounds?|lbs?|Ounces?|oz|kg|g)(?:\s*\(Pack of \d+\))?)/i.exec(text)?.[1] ?? null;
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
  ensureWfmPage(page);
  const expected = new URL(SEARCH_URL);
  expected.searchParams.set("k", query);
  await page.goto(expected.toString(), { waitUntil: "domcontentloaded" });
  ensureWfmPage(page, true);
  if (new URL(page.url()).searchParams.get("k") !== query) {
    throw new WfmPageError(`Whole Foods search opened the wrong query: ${page.url()}`);
  }
  await page.waitForFunction(
    (searchQuery) => {
      const body = document.body.innerText.toLowerCase();
      if (!body.includes(`results for "${searchQuery}"`)) return false;
      if (/(?:^|\n)(?:0|no) results\b/.test(body)) return true;
      for (const link of document.querySelectorAll("a[href*='/grocery/product/']")) {
        if (link.getClientRects().length > 0) return true;
      }
      return false;
    },
    query.toLowerCase(),
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
      const nameElement = element.querySelector<HTMLElement>("[data-testid*='product-name'], [data-testid*='productName'], h2, h3");
      const sizeElement = element.querySelector<HTMLElement>("[data-testid*='size'], [data-testid*='Size'], [class*='size']");
      const priceElement = element.querySelector<HTMLElement>("[data-testid*='price'], [data-testid*='Price'], [class*='price']");
      let fallbackName = "";
      if (link) {
        const lines = link.innerText.split("\n");
        fallbackName = (lines[1] ?? lines[0] ?? "").trim();
      }
      let hasAdd = false;
      let hasIncrease = false;
      for (const button of element.querySelectorAll("button")) {
        const label = button.getAttribute("aria-label") || button.innerText;
        if (/add\s*to\s*cart/i.test(label)) hasAdd = true;
        if (/increase quantity/i.test(label)) hasIncrease = true;
      }
      return {
        asin: asin ?? (link ? link.getAttribute("href") : null),
        name: nameElement?.innerText.trim() || fallbackName,
        size: sizeElement?.innerText.trim() ||
          (link?.innerText.match(/\b\d+(?:\.\d+)?\s*(?:oz|ounce|ounces|lb|lbs|pound|pounds|g|kg)\b/i)?.[0] ?? null),
        price: priceElement?.innerText.trim() ||
          (text.match(/\$\s*\d+(?:\.\d{2})?/)?.[0] ?? null),
        text,
        hasAdd,
        hasIncrease,
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
  chooseWeightedQuantity?: (options: readonly QuantityOption[], selectedPackSize: string | null) => Promise<number>,
): Promise<AddCandidateResult> {
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
  const chooser = card.getByRole("listbox", { name: "Select quantity" });
  let chooserVisible = await chooser.isVisible().catch(() => false);
  if (!chooserVisible && /\/\s*(?:lb|pound)\b/i.test(typeof candidate === "string" ? "" : candidate.text)) {
    chooserVisible = await chooser.waitFor({ state: "visible", timeout: 2_000 })
      .then(() => true, () => false);
  }
  if (chooserVisible) {
    if (!chooseWeightedQuantity) throw new UnknownControlError(`Weighted quantity chooser needs a decision for candidate ${id}`);
    const options: QuantityOption[] = [];
    const choices = chooser.getByRole("option");
    for (let index = 0; index < await choices.count(); index += 1) {
      const label = (await choices.nth(index).innerText()).replace(/\s+/g, " ").trim();
      const count = Number(/^\d+/.exec(label)?.[0]);
      if (Number.isSafeInteger(count) && count > 0) options.push({ quantity: count, label });
    }
    if (options.length === 0) throw new UnknownControlError(`No readable weighted quantity options for candidate ${id}`);
    const productUrl = await card.locator('a[href*="/grocery/product/"]').first().getAttribute("href");
    let selectedPackSize: string | null = null;
    if (productUrl) {
      const details = await page.context().newPage();
      try {
        await details.goto(new URL(productUrl, page.url()).toString(), { waitUntil: "domcontentloaded" });
        await details.getByText(/Select Size:/i).first().waitFor({ timeout: 5_000 }).catch(() => undefined);
        selectedPackSize = parseSelectedPackSize(await details.locator("body").innerText());
      } finally {
        await details.close();
      }
    }
    const selected = await chooseWeightedQuantity(options, selectedPackSize);
    const selectedOption = options.find(({ quantity: count }) => count === selected);
    if (!selectedOption) throw new UnknownControlError(`Unlisted weighted quantity ${selected} for candidate ${id}`);
    await chooser.getByRole("option", { name: selectedOption.label, exact: true }).click();
    await add.waitFor({ state: "visible", timeout: 5_000 });
    await add.click();
    return { quantity: selected, weighted: true };
  }
  const increase = card.getByRole("button", { name: "Increase quantity" });
  if (!hasAdd && await increase.count() === 0) {
    throw new UnknownControlError(`No add or increase control for candidate ${id}`);
  }
  const increases = hasAdd && hasQtyInput ? 0 : hasAdd ? quantity - 1 : quantity;
  for (let count = 0; count < increases; count += 1) {
    await increase.waitFor({ state: "visible", timeout: 5_000 });
    await increase.click();
  }
  return { quantity, weighted: false };
}
