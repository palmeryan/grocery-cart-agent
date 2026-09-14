import { describe, expect, it } from "vitest";
import {
  hasDeliveryAddress,
  isSignedOutPage,
  isWholeFoodsStorefront,
} from "../src/deterministic-checks.js";

describe("deterministic storefront predicates", () => {
  it("accepts the saved delivery context when the ZIP appears anywhere", () => {
    expect(hasDeliveryAddress("Deliver to Ryan\nColumbus 43214")).toBe(true);
    expect(hasDeliveryAddress("Choose a location")).toBe(false);
  });

  it("recognizes signed-out pages from URL or page text", () => {
    expect(isSignedOutPage("https://www.wholefoodsmarket.com/signin", "")).toBe(true);
    expect(isSignedOutPage("https://www.wholefoodsmarket.com/grocery/search", "Log in with Amazon")).toBe(true);
    expect(isSignedOutPage("https://www.wholefoodsmarket.com/grocery/search", "Deliver to Ryan\n43214")).toBe(false);
  });

  it("requires the direct Whole Foods Market storefront", () => {
    expect(isWholeFoodsStorefront("https://www.wholefoodsmarket.com/grocery/search", "")).toBe(true);
    expect(isWholeFoodsStorefront("https://www.amazon.com/wholefoods", "Whole Foods Market")).toBe(false);
    expect(isWholeFoodsStorefront("https://example.com/wholefoods", "Whole Foods Market")).toBe(false);
    expect(isWholeFoodsStorefront("not a URL", "Whole Foods Market")).toBe(false);
  });
});
