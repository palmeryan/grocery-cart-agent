import { describe, expect, it } from "vitest";
import {
  buildAuthReportFromObservation,
  hasDeliveryAddress,
  hasDeliveryMode,
  isSignedOutPage,
  isWholeFoodsStorefront,
} from "../src/deterministic-checks.js";

const storefrontUrl = "https://www.wholefoodsmarket.com/grocery/search";

describe("deterministic storefront predicates", () => {
  it("matches a configurable visible address fragment", () => {
    expect(hasDeliveryAddress("Deliver to Ryan\nColumbus 43214", "43214")).toBe(true);
    expect(hasDeliveryAddress("Deliver to Alex\nAustin 78701", "Austin 78701")).toBe(true);
    expect(hasDeliveryAddress("Deliver to Alex\nAustin 78701", "43214")).toBe(false);
  });

  it("observes delivery mode independently from address text", () => {
    expect(hasDeliveryMode("Deliver to Ryan\nColumbus 43214")).toBe(true);
    expect(hasDeliveryMode("Columbus 43214\nChoose pickup store")).toBe(false);
  });

  it("requires both configured address and delivery mode for preflight", () => {
    const addressOnly = buildAuthReportFromObservation(
      storefrontUrl,
      "Whole Foods Market\nAccount\nColumbus 43214\nChoose pickup store",
      { expectedAddressText: "43214", deliveryMode: "delivery" },
    );
    expect(addressOnly.deliveryAddressConfirmed).toBe(true);
    expect(addressOnly.deliveryModeConfirmed).toBe(false);
    expect(addressOnly.runStatus).toBe("failed");

    const complete = buildAuthReportFromObservation(
      storefrontUrl,
      "Whole Foods Market\nAccount\nDeliver to Ryan\nColumbus 43214",
      { expectedAddressText: "43214", deliveryMode: "delivery" },
    );
    expect(complete.runStatus).toBe("completed");
  });

  it("recognizes signed-out pages from URL or page text", () => {
    expect(isSignedOutPage("https://www.wholefoodsmarket.com/signin", "")).toBe(true);
    expect(isSignedOutPage(storefrontUrl, "Log in with Amazon")).toBe(true);
    expect(isSignedOutPage(storefrontUrl, "Deliver to Ryan\n43214")).toBe(false);
  });

  it("requires the direct Whole Foods Market storefront", () => {
    expect(isWholeFoodsStorefront(storefrontUrl, "")).toBe(true);
    expect(isWholeFoodsStorefront("https://www.amazon.com/wholefoods", "Whole Foods Market")).toBe(false);
    expect(isWholeFoodsStorefront("https://example.com/wholefoods", "Whole Foods Market")).toBe(false);
    expect(isWholeFoodsStorefront("not a URL", "Whole Foods Market")).toBe(false);
  });
});
