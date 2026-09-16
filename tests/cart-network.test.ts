import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import type { Response } from "playwright";
import {
  CartNetworkObserver,
  getSuccessfulFullCartPost,
  parseCartNetworkSnapshot,
  reconcileCartAgentResult,
} from "../src/cart-network.js";

describe("parseCartNetworkSnapshot", () => {
  it("extracts ASIN and quantity from cart responses without product-name assumptions", () => {
    expect(parseCartNetworkSnapshot(
      { carts: [{ programType: "GROCERY", items: [
        { asin: "b012345678", itemId: "ignored", quantity: 2, amountInUom: 1 },
      ] }] },
      { url: "https://www.wholefoodsmarket.com/api/cart", method: "POST", status: 200, observedAt: "now" },
    )).toEqual({
      url: "https://www.wholefoodsmarket.com/api/cart",
      method: "POST",
      status: 200,
      observedAt: "now",
      items: [{ asin: "B012345678", quantity: 2 }],
    });
  });

  it("rejects partial or ambiguous item payloads", () => {
    const metadata = { url: "https://www.wholefoodsmarket.com/api/cart", method: "GET", status: 200, observedAt: "now" };
    expect(parseCartNetworkSnapshot({ carts: [{ items: [{ asin: "B012345678" }] }] }, metadata)).toBeNull();
    expect(parseCartNetworkSnapshot({ carts: [{ items: "unknown" }] }, metadata)).toBeNull();
    expect(parseCartNetworkSnapshot({ carts: [] }, metadata)).toBeNull();
  });

  it("observes fake page responses and treats only a successful complete POST as authoritative", async () => {
    const events = new EventEmitter();
    const observer = new CartNetworkObserver(events as unknown as Pick<import("playwright").Page, "on" | "off">);
    const response = (method: string, status: number, body: unknown): Response => ({
      url: () => "https://www.wholefoodsmarket.com/api/cartcache",
      request: () => ({ method: () => method }),
      status: () => status,
      text: async () => JSON.stringify(body),
    }) as unknown as Response;
    events.emit("response", response("GET", 200, { carts: [{ items: [] }] }));
    const getRecords = await observer.drain();
    expect(getSuccessfulFullCartPost(getRecords)).toBeNull();

    events.emit("response", response("POST", 200, {
      carts: [{ items: [{ asin: "B012345678", quantity: 1 }] }],
    }));
    const postRecords = await observer.waitForFullCartPost(50);
    const snapshot = getSuccessfulFullCartPost(postRecords);
    expect(snapshot?.items).toEqual([{ asin: "B012345678", quantity: 1 }]);
    expect(reconcileCartAgentResult([], snapshot!, {
      status: "added", productId: "B012345678", quantity: 1,
    }).matched).toBe(true);
    expect(reconcileCartAgentResult(snapshot!.items, snapshot!, {
      status: "already_present", productId: "B012345678", quantity: 1,
    }).matched).toBe(true);
    expect(reconcileCartAgentResult([], snapshot!, {
      status: "skipped", productId: null, quantity: 0,
    }).matched).toBe(false);
    observer.dispose();
  });
});
