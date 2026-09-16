import { describe, expect, it } from "vitest";
import { isShoppingPage } from "../src/wfm-navigation.js";

describe("cart navigation boundary", () => {
  it("allows only Whole Foods shopping pages", () => {
    expect(isShoppingPage("https://www.wholefoodsmarket.com/grocery/search?k=rice")).toBe(true);
    expect(isShoppingPage("https://www.wholefoodsmarket.com/grocery/product/rice-b012345678")).toBe(true);
    expect(isShoppingPage("https://www.wholefoodsmarket.com/grocery/cart")).toBe(true);
    expect(isShoppingPage("https://www.wholefoodsmarket.com/grocery/checkout")).toBe(false);
    expect(isShoppingPage("https://www.wholefoodsmarket.com/grocery/cart/checkout")).toBe(false);
    expect(isShoppingPage("https://www.wholefoodsmarket.com/grocery/search-checkout")).toBe(false);
    expect(isShoppingPage("https://www.wholefoodsmarket.com/account/address")).toBe(false);
    expect(isShoppingPage("https://example.com/grocery/search")).toBe(false);
  });
});
