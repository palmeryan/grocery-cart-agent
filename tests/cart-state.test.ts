import { describe, expect, it } from "vitest";
import {
  CartStateVerificationError,
  cartTextContainsSelection,
  collectCartPageObservation,
  createPlaywrightCartPageAdapter,
  computeCartDelta,
  getTotalItemCount,
  inspectCartState,
  parseCartItemRows,
  parseCartProductName,
  parseCartQuantity,
} from "../src/cart-state.js";

class FakeDomElement {
  parentElement: FakeDomElement | null = null;
  readonly children: FakeDomElement[] = [];

  constructor(
    readonly tagName: string,
    readonly textContent: string,
    private readonly attributes: Record<string, string> = {},
  ) {}

  append(child: FakeDomElement): this {
    child.parentElement = this;
    this.children.push(child);
    return this;
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  querySelectorAll(selector: string): FakeDomElement[] {
    const descendants: FakeDomElement[] = [];
    const visit = (element: FakeDomElement): void => {
      for (const child of element.children) {
        descendants.push(child);
        visit(child);
      }
    };
    visit(this);
    if (selector === 'input, select, textarea, [role="spinbutton"]') {
      return descendants.filter((element) =>
        ["input", "select", "textarea"].includes(element.tagName.toLowerCase()) ||
        element.getAttribute("role") === "spinbutton",
      );
    }
    if (selector === '[aria-label="Enter Quantity"]') {
      return descendants.filter(
        (element) => element.getAttribute("aria-label") === "Enter Quantity",
      );
    }
    return descendants;
  }
}

class FakeDocument {
  constructor(
    readonly body: { innerText: string },
    private readonly titles: FakeDomElement[],
    private readonly count: FakeDomElement | null,
  ) {}

  querySelectorAll(selector: string): FakeDomElement[] {
    return selector.includes("cart-item-image-title-container") ? this.titles : [];
  }

  querySelector(selector: string): FakeDomElement | null {
    return selector.includes("cart-count") ? this.count : null;
  }
}

function withFakeDocument<T>(fakeDocument: FakeDocument, callback: () => T): T {
  const previousDocument = (globalThis as { document?: unknown }).document;
  Object.defineProperty(globalThis, "document", { configurable: true, value: fakeDocument });
  try {
    return callback();
  } finally {
    if (previousDocument === undefined) {
      Reflect.deleteProperty(globalThis, "document");
    } else {
      Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
    }
  }
}

function splitCartFixture(quantity: string | null): FakeDocument {
  const title = new FakeDomElement(
    "div",
    "Organic bananas",
    { class: "cart-item-image-title-container" },
  );
  const group = new FakeDomElement("section", "Organic bananas $2.99").append(title);
  if (quantity !== null) {
    group.append(new FakeDomElement("input", "", {
      type: "text",
      value: quantity,
      "aria-label": "Enter Quantity",
    }));
  }
  return new FakeDocument(
    { innerText: quantity === null ? "Your cart\nOrganic bananas" : "Your cart\n2 items" },
    [title],
    new FakeDomElement("span", quantity === null ? "" : "2 items"),
  );
}

describe("cart-state parsing", () => {
  it("keeps the browser evaluator free of bundler helper references", () => {
    expect(collectCartPageObservation.toString()).not.toContain("__name");
  });

  it("extracts live-like split product titles and Enter Quantity controls", () => {
    const observation = withFakeDocument(splitCartFixture("2"), () =>
      collectCartPageObservation(),
    );
    expect(observation.rows).toEqual([{
      productName: "Organic bananas",
      quantity: "2",
      text: "Organic bananas $2.99",
    }]);
    expect(observation.extractionStatus).toBe("complete");
    expect(observation.displayedItemCount).toBe(2);
  });

  it("returns body text and a degraded observation when grouping fails", () => {
    const observation = withFakeDocument(splitCartFixture(null), () =>
      collectCartPageObservation(),
    );
    expect(observation.rows).toEqual([]);
    expect(observation.bodyText).toContain("Organic bananas");
    expect(observation.extractionStatus).toBe("degraded");
    expect(observation.extractionDiagnostic).toContain("exactly one quantity control");
  });

  it("returns a degraded cart snapshot instead of blocking the run", async () => {
    const adapter = {
      getUrl: () => "https://www.wholefoodsmarket.com/grocery/cart",
      evaluate: async <T>(): Promise<T> =>
        withFakeDocument(splitCartFixture(null), () => collectCartPageObservation()) as T,
    };
    await expect(inspectCartState(adapter)).resolves.toMatchObject({
      items: [],
      extractionStatus: "degraded",
      extractionDiagnostic: expect.stringContaining("exactly one quantity control"),
    });
  });

  it("retries a transient cart navigation abort", async () => {
    let currentUrl = "https://www.wholefoodsmarket.com/grocery/search";
    let attempts = 0;
    const page = {
      url: () => currentUrl,
      evaluate: async () => undefined,
      goto: async (url: string) => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("net::ERR_ABORTED");
        }
        currentUrl = url;
      },
    } as unknown as Parameters<typeof createPlaywrightCartPageAdapter>[0];
    const adapter = createPlaywrightCartPageAdapter(page);

    await adapter.navigate?.("https://www.wholefoodsmarket.com/grocery/cart");
    expect(attempts).toBe(2);
    expect(currentUrl).toContain("/grocery/cart");
  });

  it("accepts positive integer quantities and labelled quantities", () => {
    expect(parseCartQuantity(2)).toBe(2);
    expect(parseCartQuantity("Qty: 3")).toBe(3);
    expect(parseCartQuantity("quantity is 4")).toBe(4);
  });

  it("rejects ambiguous, zero, and price-like quantities", () => {
    expect(parseCartQuantity(0)).toBeNull();
    expect(parseCartQuantity("2.99")).toBeNull();
    expect(parseCartQuantity("2 items, 3 substitutions")).toBeNull();
    expect(parseCartQuantity("quantity: 0")).toBeNull();
  });

  it("normalizes names without inventing a name", () => {
    expect(parseCartProductName("  Organic   bananas ")).toBe("Organic bananas");
    expect(parseCartProductName("Your Cart")).toBeNull();
    expect(parseCartProductName(" ")).toBeNull();
  });

  it("fails closed when a row cannot be verified", () => {
    expect(() => parseCartItemRows([
      { productName: "Apples", quantity: "2" },
      { productName: "Unknown", quantity: "many" },
    ])).toThrowError(CartStateVerificationError);
  });

  it("parses rows and computes the total unit count", () => {
    const items = parseCartItemRows([
      { productName: "Apples", quantity: "2" },
      { productName: "Milk", text: "Quantity: 1" },
    ]);
    expect(items).toEqual([
      { productName: "Apples", quantity: 2 },
      { productName: "Milk", quantity: 1 },
    ]);
    expect(getTotalItemCount(items)).toBe(3);
  });
});

describe("cart-state delta", () => {
  it("matches an agent-reported product and quantity in visible cart text", () => {
    const text = [
      "Your cart",
      "365 by Whole Foods Market Boneless Skinless Chicken Thighs",
      "$9.34",
      "Current quantity: 1",
    ].join("\n");
    expect(cartTextContainsSelection(
      text,
      "365 by Whole Foods Market Boneless Skinless Chicken Thighs",
      1,
    )).toBe(true);
    expect(cartTextContainsSelection(text, "Chicken Breast", 1)).toBe(false);
    expect(cartTextContainsSelection(text, "Chicken Thighs", 2)).toBe(false);
  });

  it("preserves baseline items and returns only additions", () => {
    expect(computeCartDelta(
      [{ productName: "Milk", quantity: 1 }],
      [
        { productName: "Milk", quantity: 1 },
        { productName: "Eggs", quantity: 2 },
      ],
    )).toEqual([{ productName: "Eggs", quantity: 2 }]);
  });

  it("keeps quantity evidence local to the matched cart item", () => {
    const text = [
      "Organic Apples",
      "Current quantity: 1",
      "Bananas",
      "Current quantity: 2",
    ].join("\n");
    expect(cartTextContainsSelection(text, "Organic Apples", 1)).toBe(true);
    expect(cartTextContainsSelection(text, "Organic Apples", 2)).toBe(false);
  });

  it("does not treat a package-size number as the cart quantity", () => {
    const text = [
      "Organic Apples",
      "3 lb bag",
      "$5.99",
      "Bananas",
      "Current quantity: 1",
    ].join("\n");
    expect(cartTextContainsSelection(text, "Organic Apples", 3)).toBe(false);
  });

  it("represents a quantity increase by its positive difference", () => {
    expect(computeCartDelta(
      [{ productName: "Milk", quantity: 1 }],
      [{ productName: "milk", quantity: 3 }],
    )).toEqual([{ productName: "milk", quantity: 2 }]);
  });

  it("does not report unchanged or decreased items as additions", () => {
    expect(computeCartDelta(
      [
        { productName: "Milk", quantity: 2 },
        { productName: "Eggs", quantity: 2 },
      ],
      [
        { productName: "Milk", quantity: 1 },
        { productName: "Eggs", quantity: 2 },
      ],
    )).toEqual([]);
  });

  it("aggregates duplicate rows deterministically", () => {
    expect(computeCartDelta(
      [{ productName: "Milk", quantity: 1 }],
      [
        { productName: "Milk", quantity: 1 },
        { productName: " milk ", quantity: 2 },
      ],
    )).toEqual([{ productName: "Milk", quantity: 2 }]);
  });
});
