import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import type { Response } from "playwright";
import {
  CartNetworkObserver,
  getSuccessfulFullCartMutation,
  parseCartNetworkSnapshot,
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
    expect(getSuccessfulFullCartMutation(getRecords)).toBeNull();

    events.emit("response", response("PUT", 200, {
      carts: [{ items: [{ asin: "B012345678", quantity: 1 }] }],
    }));
    const mutationRecords = await observer.waitForFullCartMutation(50);
    const snapshot = getSuccessfulFullCartMutation(mutationRecords);
    expect(snapshot?.items).toEqual([{ asin: "B012345678", quantity: 1 }]);
    observer.dispose();
  });

  it("uses the latest queued POST or PUT snapshot for the selected ASIN", async () => {
    const events = new EventEmitter();
    const observer = new CartNetworkObserver(events as unknown as Pick<import("playwright").Page, "on" | "off">);
    const response = (method: string, items: unknown[]): Response => ({
      url: () => "https://www.wholefoodsmarket.com/api/wwos/cart",
      request: () => ({ method: () => method }),
      status: () => 200,
      text: async () => JSON.stringify({ carts: [{ items }] }),
    }) as unknown as Response;

    await observer.beginMutation([{ asin: "BEANS", quantity: 0 }, { asin: "OTHER", quantity: 2 }]);
    events.emit("response", response("POST", [
      { asin: "BEANS", quantity: 1 },
      { asin: "OTHER", quantity: 2 },
    ]));
    events.emit("response", response("PUT", [
      { asin: "BEANS", quantity: 2 },
      { asin: "OTHER", quantity: 1 },
    ]));
    await expect(observer.waitForMutation({ asin: "BEANS", expectedQuantity: 2, timeoutMs: 50 }))
      .resolves.toMatchObject({ status: "confirmed", delta: 2, snapshot: { items: [
        { asin: "BEANS", quantity: 2 },
        { asin: "OTHER", quantity: 1 },
      ] } });
    observer.dispose();
  });

  it("confirms only the armed ASIN's exact positive delta", async () => {
    const events = new EventEmitter();
    const observer = new CartNetworkObserver(events as unknown as Pick<import("playwright").Page, "on" | "off">);
    const response = (status: number, items: unknown[]): Response => ({
      url: () => "https://www.wholefoodsmarket.com/api/cartcache",
      request: () => ({ method: () => "POST" }),
      status: () => status,
      text: async () => JSON.stringify({ carts: [{ items }] }),
    }) as unknown as Response;

    await observer.beginMutation([
      { asin: "A", quantity: 1 },
      { asin: "B", quantity: 2 },
    ]);
    // WFM may emit an unchanged cart response before the committing response.
    events.emit("response", response(200, [
      { asin: "A", quantity: 1 },
      { asin: "B", quantity: 2 },
    ]));
    events.emit("response", response(200, [
      { asin: "A", quantity: 1.5 },
      { asin: "B", quantity: 2 },
    ]));
    await expect(observer.waitForMutation({ asin: "a", expectedQuantity: 0.5, timeoutMs: 50 }))
      .resolves.toMatchObject({ status: "confirmed", delta: 0.5 });
    observer.dispose();
  });

  it("accepts any positive selected-ASIN delta for a weighted purchase", async () => {
    const events = new EventEmitter();
    const observer = new CartNetworkObserver(events as unknown as Pick<import("playwright").Page, "on" | "off">);
    const response = {
      url: () => "https://www.wholefoodsmarket.com/api/cartcache",
      request: () => ({ method: () => "POST" }),
      status: () => 200,
      text: async () => JSON.stringify({ carts: [{ items: [{ asin: "WEIGHTED", quantity: 0.25 }] }] }),
    } as unknown as Response;
    await observer.beginMutation([]);
    events.emit("response", response);
    await expect(observer.waitForMutation({ asin: "weighted", expectedQuantity: "positive", timeoutMs: 50 }))
      .resolves.toMatchObject({ status: "confirmed", delta: 0.25 });
    observer.dispose();
  });

  it("waits through intermediate unit increases until the requested delta", async () => {
    const events = new EventEmitter();
    const observer = new CartNetworkObserver(events as unknown as Pick<import("playwright").Page, "on" | "off">);
    const response = (quantity: number): Response => ({
      url: () => "https://www.wholefoodsmarket.com/api/cartcache",
      request: () => ({ method: () => "POST" }),
      status: () => 200,
      text: async () => JSON.stringify({ carts: [{ items: [{ asin: "B012345678", quantity }] }] }),
    }) as unknown as Response;
    await observer.beginMutation([]);
    events.emit("response", response(1));
    events.emit("response", response(2));
    await expect(observer.waitForMutation({ asin: "B012345678", expectedQuantity: 2, timeoutMs: 50 }))
      .resolves.toMatchObject({ status: "confirmed", delta: 2 });
    observer.dispose();
  });

  it("reports a partial quantity increase as unknown rather than success", async () => {
    const events = new EventEmitter();
    const observer = new CartNetworkObserver(events as unknown as Pick<import("playwright").Page, "on" | "off">);
    await observer.beginMutation([]);
    events.emit("response", {
      url: () => "https://www.wholefoodsmarket.com/api/cartcache",
      request: () => ({ method: () => "POST" }),
      status: () => 200,
      text: async () => JSON.stringify({ carts: [{ items: [{ asin: "B012345678", quantity: 1 }] }] }),
    } as unknown as Response);
    await expect(observer.waitForMutation({ asin: "B012345678", expectedQuantity: 2, timeoutMs: 20 }))
      .resolves.toMatchObject({ status: "unknown", delta: 1, diagnostic: expect.stringContaining("stopped at 1") });
    observer.dispose();
  });

  it("confirms the selected ASIN increase despite unrelated cart changes", async () => {
    const events = new EventEmitter();
    const observer = new CartNetworkObserver(events as unknown as Pick<import("playwright").Page, "on" | "off">);
    const response = (items: unknown[]): Response => ({
      url: () => "https://www.wholefoodsmarket.com/api/cartcache",
      request: () => ({ method: () => "POST" }),
      status: () => 200,
      text: async () => JSON.stringify({ carts: [{ items }] }),
    }) as unknown as Response;

    await observer.beginMutation([{ asin: "A", quantity: 1 }]);
    events.emit("response", response([
      { asin: "A", quantity: 2 },
      { asin: "B", quantity: 1 },
    ]));
    await expect(observer.waitForMutation({ asin: "A", expectedQuantity: 1, timeoutMs: 50 }))
      .resolves.toMatchObject({ status: "confirmed", delta: 1 });

    await observer.beginMutation([{ asin: "A", quantity: 1 }]);
    events.emit("response", response([
      { asin: "A", quantity: 1 },
      { asin: "B", quantity: 1 },
    ]));
    await expect(observer.waitForMutation({ asin: "A", expectedQuantity: 1, timeoutMs: 20 }))
      .resolves.toMatchObject({ status: "unknown", delta: 0, diagnostic: expect.stringContaining("not correlated") });

    await observer.beginMutation([{ asin: "A", quantity: 1 }]);
    events.emit("response", response([{ asin: "A", quantity: 1 }]));
    await expect(observer.waitForMutation({ asin: "A", expectedQuantity: 1, timeoutMs: 20 }))
      .resolves.toMatchObject({ status: "unknown", delta: 0, diagnostic: expect.stringContaining("not correlated") });

    await observer.beginMutation([{ asin: "A", quantity: 1 }]);
    await expect(observer.waitForMutation({ asin: "A", expectedQuantity: 1, timeoutMs: 5 }))
      .resolves.toMatchObject({ status: "unknown", snapshot: null });
    observer.dispose();
  });

  it("reports a WFM rejection for the selected ASIN instead of a generic timeout", async () => {
    const events = new EventEmitter();
    const observer = new CartNetworkObserver(events as unknown as Pick<import("playwright").Page, "on" | "off">);
    await observer.beginMutation([{ asin: "CHICKEN", quantity: 1 }]);
    events.emit("response", {
      url: () => "https://www.wholefoodsmarket.com/api/wwos/cart",
      request: () => ({ method: () => "POST" }),
      status: () => 200,
      text: async () => JSON.stringify({ carts: [{
        items: [{ asin: "CHICKEN", quantity: 1 }],
        status: [{ statusCode: "1", errorMessage: "itemRemovedRegionMismatch",
          itemData: JSON.stringify({ ASIN: "BROCCOLI" }) }],
      }] }),
    } as unknown as Response);
    await expect(observer.waitForMutation({ asin: "BROCCOLI", expectedQuantity: 1, timeoutMs: 500 }))
      .resolves.toMatchObject({ status: "rejected", delta: 0,
        diagnostic: "Whole Foods rejected BROCCOLI: itemRemovedRegionMismatch (statusCode 1)." });
    observer.dispose();
  });

  it("does not consume a response that arrived before the mutation boundary", async () => {
    const events = new EventEmitter();
    const observer = new CartNetworkObserver(events as unknown as Pick<import("playwright").Page, "on" | "off">);
    const response = (quantity: number): Response => ({
      url: () => "https://www.wholefoodsmarket.com/api/cartcache",
      request: () => ({ method: () => "POST" }),
      status: () => 200,
      text: async () => JSON.stringify({ carts: [{ items: [{ asin: "A", quantity }] }] }),
    }) as unknown as Response;
    events.emit("response", response(2));
    await observer.beginMutation([{ asin: "A", quantity: 1 }]);
    await expect(observer.waitForMutation({ asin: "A", expectedQuantity: 1, timeoutMs: 5 }))
      .resolves.toMatchObject({ status: "unknown", snapshot: null });
    observer.dispose();
  });
});
