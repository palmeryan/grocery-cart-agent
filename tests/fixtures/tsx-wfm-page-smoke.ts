import { chromium } from "playwright";
import { searchProducts } from "../../src/wfm-page.js";

const browser = await chromium.launch({
  headless: true,
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
try {
  const page = await browser.newPage();
  await page.route("**/*", async (route) => route.fulfill({
    status: 200,
    contentType: "text/html",
    body: new URL(route.request().url()).searchParams.get("k") === "beans"
      ? `<p>1 results for "beans"</p><div><a href='/grocery/product/organic-beans-b0abc12345'><h2>Organic beans</h2></a><button>Add to Cart</button></div>`
      : "<html><body></body></html>",
  }));
  await page.goto("https://www.wholefoodsmarket.com/grocery/search");
  const candidates = await searchProducts(page, "beans");
  if (candidates[0]?.id !== "b0abc12345" || candidates[0]?.productName !== "Organic beans") {
    throw new Error(`Unexpected candidates: ${JSON.stringify(candidates)}`);
  }
} finally {
  await browser.close();
}
