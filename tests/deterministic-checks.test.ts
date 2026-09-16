import { describe, expect, it } from "vitest";
import {
  buildAuthReportFromObservation,
  hasDeliveryMode,
  isWholeFoodsStorefront,
  parseAccountSummaryAuthentication,
  readAccountAuthentication,
} from "../src/deterministic-checks.js";
import type { Page } from "playwright";

const storefrontUrl = "https://www.wholefoodsmarket.com/grocery/search";

describe("deterministic storefront predicates", () => {
  it("observes delivery mode independently from address text", () => {
    expect(hasDeliveryMode("Deliver to Ryan\nColumbus 43214")).toBe(true);
    expect(hasDeliveryMode("Columbus 43214\nChoose pickup store")).toBe(false);
  });

  it("requires delivery mode and storefront, without requiring address text", () => {
    const addressOnly = buildAuthReportFromObservation(
      storefrontUrl,
      "Whole Foods Market\nHi, Ryan\nAccount & Orders\nColumbus 43214\nChoose pickup store",
      true,
      { deliveryMode: "delivery" },
    );
    expect(addressOnly.deliveryModeConfirmed).toBe(false);
    expect(addressOnly.runStatus).toBe("failed");

    const noAddress = buildAuthReportFromObservation(
      storefrontUrl,
      "Whole Foods Market\nDeliver to Ryan",
      true,
    );
    expect(noAddress.deliveryModeConfirmed).toBe(true);
    expect(noAddress.runStatus).toBe("completed");

    const complete = buildAuthReportFromObservation(
      storefrontUrl,
      "Whole Foods Market\nHi, Ryan\nAccount & Orders\nDeliver to Ryan\nColumbus 43214",
      true,
      { deliveryMode: "delivery" },
    );
    expect(complete.runStatus).toBe("completed");
  });

  it("uses the account API result rather than storefront presentation text", () => {
    const report = buildAuthReportFromObservation(
      storefrontUrl,
      "Whole Foods Market\nHi, Ryan\nAccount & Orders\nDelivering to 43214",
      false,
    );
    expect(report.authenticated).toBe(false);
    expect(report.failureReason).toContain("account API reported signed out");

    const authenticated = buildAuthReportFromObservation(
      storefrontUrl,
      "Whole Foods Market\nDelivering to 43214\nLog in to get started",
      true,
    );
    expect(authenticated.authenticated).toBe(true);
    expect(authenticated.runStatus).toBe("completed");
  });

  it.each([true, false])(
    "reads customer.authenticated=%s from the account summary endpoint",
    async (authenticated) => {
      let requestedUrl = "";
      const page = {
        url: () => storefrontUrl,
        request: {
          get: async (url: string) => {
            requestedUrl = url;
            return {
              ok: () => true,
              status: () => 200,
              json: async () => ({
                customer: {
                  authenticated,
                  login_enabled: true,
                  anti_forgery_token: "ignored",
                },
              }),
            };
          },
        },
      } as unknown as Page;
      await expect(readAccountAuthentication(page)).resolves.toBe(authenticated);
      expect(requestedUrl).toBe(
        "https://www.wholefoodsmarket.com/api/account/summary",
      );
    },
  );

  it("rejects malformed account summaries instead of guessing", () => {
    expect(() => parseAccountSummaryAuthentication({ customer: {} })).toThrow(
      "omitted customer.authenticated",
    );
  });

  it("reports account-summary HTTP failures without guessing", async () => {
    const page = {
      url: () => storefrontUrl,
      request: {
        get: async () => ({
          ok: () => false,
          status: () => 503,
          json: async () => ({}),
        }),
      },
    } as unknown as Page;
    await expect(readAccountAuthentication(page)).rejects.toThrow(
      "account summary returned HTTP 503",
    );
  });

  it("requires the direct Whole Foods Market storefront", () => {
    expect(isWholeFoodsStorefront(storefrontUrl, "")).toBe(true);
    expect(isWholeFoodsStorefront("https://www.amazon.com/wholefoods", "Whole Foods Market")).toBe(false);
    expect(isWholeFoodsStorefront("https://example.com/wholefoods", "Whole Foods Market")).toBe(false);
    expect(isWholeFoodsStorefront("not a URL", "Whole Foods Market")).toBe(false);
  });
});
