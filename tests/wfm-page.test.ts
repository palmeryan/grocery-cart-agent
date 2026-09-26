import { chromium, type Browser, type Page } from "playwright";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addCandidate, extractCandidates, parseSelectedPackSize, searchProducts, UnknownControlError, WfmPageError } from "../src/wfm-page.js";

let browser: Browser | undefined;
let page: Page;
const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browserExecutable = chromePath;
const runBrowserFixtures = process.env.WFM_BROWSER_FIXTURES === "1";

beforeAll(async () => {
  if (!runBrowserFixtures) return;
  browser = await chromium.launch({ headless: true, executablePath: browserExecutable });
  page = await (await browser.newContext()).newPage();
  await page.route("**/*", async (route) => {
    const query = new URL(route.request().url()).searchParams.get("k");
    const body = query === null ? "<html><body></body></html>"
      : query === "unlikely ingredient" ? `<p>0 results for "${query}"</p>`
      : `<p>1 results for "${query}"</p><div><a href="/grocery/product/${query === "rice" ? "rice-b0xyz12345" : "soy-b0soy12345"}"><h2>${query === "rice" ? "Rice" : "Soy sauce"}</h2></a><button>Add to Cart</button></div>`;
    await route.fulfill({ status: 200, contentType: "text/html", body });
  });
  await page.goto("https://www.wholefoodsmarket.com/grocery/search");
});
afterAll(async () => await browser?.close());

describe("WFM page adapter", () => {
  it("reads the selected product size, not the other available variants", () => {
    expect(parseSelectedPackSize("Select Size: 3 Pound (Pack of 1)\n1.5 Pound (Pack of 1)\n3 Pound (Pack of 1)"))
      .toBe("3 Pound (Pack of 1)");
  });
  it.skipIf(!runBrowserFixtures)("extracts cards in the CLI's tsx runtime", () => {
    execFileSync(
      fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url)),
      [fileURLToPath(new URL("fixtures/tsx-wfm-page-smoke.ts", import.meta.url))],
      { timeout: 15_000, stdio: "pipe" },
    );
  });

  it.skipIf(!runBrowserFixtures)("extracts ASIN-addressable card evidence", async () => {
    await page.setContent(`<div><a href="/grocery/product/organic-beans-b0abc12345"><h2>Organic beans</h2><span data-testid="size">15 oz</span><span data-testid="price">$2.99</span></a><button>Add to cart</button><p>In stock</p></div>`);
    await page.evaluate(() => history.replaceState(null, "", "/grocery/search"));
    await expect(extractCandidates(page)).resolves.toEqual([expect.objectContaining({ id: "b0abc12345", productName: "Organic beans", packageSize: "15 oz", price: "$2.99", available: true })]);
  });

  it.skipIf(!runBrowserFixtures)("opens the encoded query URL and returns its cards", async () => {
    const products = await searchProducts(page, "rice");
    expect(products[0]?.id).toBe("b0xyz12345");
    expect(new URL(page.url()).searchParams.get("k")).toBe("rice");
  });

  it.skipIf(!runBrowserFixtures)("returns an empty result set so the model can request a revised query", async () => {
    await expect(searchProducts(page, "unlikely ingredient")).resolves.toEqual([]);
  });

  it.skipIf(!runBrowserFixtures)("waits for results for the new query rather than stale cards", async () => {
    const handler = async (route: import("playwright").Route) => route.fulfill({ status: 200, contentType: "text/html", body: `<p id="results">1 results for "old query"</p><div id="card"><a href="/grocery/product/old-b0old12345"><h2>Old result</h2></a><button>Add to Cart</button></div><script>setTimeout(()=>{document.querySelector('#results').textContent='1 results for "soy sauce"';document.querySelector('#card').innerHTML='<a href="/grocery/product/soy-b0soy12345"><h2>Soy sauce</h2></a><button>Add to Cart</button>'},150)</script>` });
    await page.route("**/grocery/search?k=soy+sauce", handler);
    try {
      const products = await searchProducts(page, "soy sauce");
      expect(products.map(({ productName }) => productName)).toEqual(["Soy sauce"]);
    } finally {
      await page.unroute("**/grocery/search?k=soy+sauce", handler);
    }
  });

  it.skipIf(!runBrowserFixtures)("adds only the selected card and its associated quantity", async () => {
    await page.setContent(`<div><a href="/grocery/product/one-b000000001"><h2>One</h2></a><input aria-label="Quantity" type="number" /><button>Add to cart</button></div><div><a href="/grocery/product/two-b000000002"><h2>Two</h2></a><button>Add to cart</button></div>`);
    await page.evaluate(() => history.replaceState(null, "", "/grocery/search"));
    await addCandidate(page, { id: "b000000001", productName: "One", packageSize: null, price: null, available: true, text: "One" }, 3);
    expect(await page.locator('a[href*="b000000001"]').locator("..").locator("input").inputValue()).toBe("3");
  });

  it.skipIf(!runBrowserFixtures)("uses the selected card's post-add quantity stepper", async () => {
    await page.setContent(`<div><a href="/grocery/product/one-b000000001"><h2>One</h2></a><button onclick="this.style.display='none';this.nextElementSibling.style.display='inline'">Add to Cart</button><button aria-label="Increase quantity" style="display:none" onclick="this.dataset.clicks=String(Number(this.dataset.clicks||0)+1)">+</button></div>`);
    await page.evaluate(() => history.replaceState(null, "", "/grocery/search"));
    await addCandidate(page, "b000000001", 3);
    expect(await page.getByRole("button", { name: "Increase quantity" }).getAttribute("data-clicks")).toBe("2");
  });

  it.skipIf(!runBrowserFixtures)("increments a product already in the cart", async () => {
    await page.setContent(`<div><a href="/grocery/product/one-b000000001"><h2>One</h2></a><button aria-label="Increase quantity" onclick="this.dataset.clicks=String(Number(this.dataset.clicks||0)+1)">+</button></div>`);
    await page.evaluate(() => history.replaceState(null, "", "/grocery/search"));
    await expect(extractCandidates(page)).resolves.toEqual([expect.objectContaining({ id: "b000000001", available: true })]);
    await addCandidate(page, "b000000001", 2);
    expect(await page.getByRole("button", { name: "Increase quantity" }).getAttribute("data-clicks")).toBe("2");
  });

  it.skipIf(!runBrowserFixtures)("chooses a weighted option before the final Add", async () => {
    const productRoute = async (route: import("playwright").Route) => route.fulfill({ status: 200, contentType: "text/html", body: "<h1>Chicken thighs</h1><p>Select Size: 3 Pound (Pack of 1)</p><p>1.5 Pound (Pack of 1)</p>" });
    await page.context().route("**/grocery/product/chicken-b0787whrnp", productRoute);
    try {
      await page.setContent(`<div><a href="/grocery/product/chicken-b0787whrnp"><h2>Chicken thighs</h2></a><button onclick="this.dataset.clicks=String(Number(this.dataset.clicks||0)+1);document.querySelector('[role=listbox]').hidden=false">Add to Cart</button><div role="listbox" aria-label="Select quantity" hidden><div role="option" onclick="this.parentElement.hidden=true">1 est. 1.56 lb</div><div role="option" onclick="this.parentElement.hidden=true">2 est. 3.12 lb</div></div></div>`);
      await page.evaluate(() => history.replaceState(null, "", "/grocery/search"));
      let observed = "";
      let selectedSize: string | null = null;
      const result = await addCandidate(page, { id: "b0787whrnp", productName: "Chicken thighs", packageSize: null, price: "$5.99", available: true, text: "$5.99/lb" }, 2, undefined, async (options, packSize) => {
        observed = options.map(({ label }) => label).join(" | ");
        selectedSize = packSize;
        return 1;
      });
      expect(observed).toContain("1 est. 1.56 lb");
      expect(selectedSize).toBe("3 Pound (Pack of 1)");
      expect(result).toEqual({ quantity: 1, weighted: true });
      expect(await page.getByRole("button", { name: "Add to Cart" }).getAttribute("data-clicks")).toBe("2");
    } finally {
      await page.context().unroute("**/grocery/product/chicken-b0787whrnp", productRoute);
    }
  });

  it.skipIf(!runBrowserFixtures)("rejects stale IDs, unknown controls, and non-WFM pages", async () => {
    await page.setContent(`<div><a href="/grocery/product/one-b000000001"><h2>One</h2></a></div>`);
    await page.evaluate(() => history.replaceState(null, "", "/grocery/search"));
    await expect(addCandidate(page, "b000000002")).rejects.toThrow(WfmPageError);
    await expect(addCandidate(page, "b000000001")).rejects.toThrow(UnknownControlError);
    await page.goto("https://example.com/");
    await expect(extractCandidates(page)).rejects.toThrow(/outside Whole Foods/);
  });
});
