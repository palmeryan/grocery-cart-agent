import { describe, expect, it } from "vitest";
import { cartTasks, runCartFlow } from "../src/cart-flow.js";
import type { ProductCandidate } from "../src/wfm-page.js";
import type { ShoppingList } from "../src/types.js";

const list: ShoppingList = {
  recipes: [{ id: "dinner", name: "Dinner", servings: 2, context: "Dinner",
    ingredients: [
      { id: "rice", request: "rice" },
      { id: "beans", request: "beans" },
    ],
  }],
};

const candidate = (id: string, name: string): ProductCandidate => ({
  id, productName: name, packageSize: "1 bag", price: "$2.99",
  available: true, text: `${name} 1 bag $2.99 Add to Cart`,
});

describe("harness cart flow", () => {
  it("uses each confirmed snapshot as the next item's baseline and records timings", async () => {
    const seenBefore: unknown[] = [];
    const result = await runCartFlow({
      tasks: cartTasks(list), baseline: [],
      search: async (query) => [candidate(query === "rice" ? "B000000001" : "B000000002", query)],
      decide: async (_task, candidates) => ({ action: "select", candidateId: candidates[0]!.id, quantity: 1, option: null, reason: null }),
      add: async (_task, selected, _quantity, _option, before) => {
        seenBefore.push([...before]);
        return { items: [...before, { asin: selected.id, quantity: 1 }],
          observedAt: "now", url: "https://www.wholefoodsmarket.com/api/cartcache", method: "POST", status: 200 };
      },
    });
    expect(result.stopped).toBe(false);
    expect(result.results.map((item) => item.status)).toEqual(["added", "added"]);
    expect(seenBefore).toEqual([[], [{ asin: "B000000001", quantity: 1 }]]);
    expect(result.timings).toHaveLength(2);
    expect(result.timings.map((timing) => timing.modelCalls)).toEqual([1, 1]);
    expect(result.latestSnapshot?.items).toHaveLength(2);
  });

  it("lets the model request one better search, without browser tools", async () => {
    const queries: string[] = [];
    const result = await runCartFlow({
      tasks: cartTasks({ recipes: [{ ...list.recipes[0]!, ingredients: [list.recipes[0]!.ingredients[0]!] }] }),
      baseline: [],
      search: async (query) => { queries.push(query); return query === "jasmine rice" ? [candidate("B000000001", "Jasmine rice")] : []; },
      decide: async (_task, candidates) => candidates.length === 0
        ? { action: "search_again", query: "jasmine rice" }
        : { action: "select", candidateId: candidates[0]!.id, quantity: 1, option: null, reason: null },
      add: async () => ({ items: [{ asin: "B000000001", quantity: 1 }], observedAt: "now", url: "https://www.wholefoodsmarket.com/api/cartcache", method: "POST", status: 200 }),
    });
    expect(queries).toEqual(["rice", "jasmine rice"]);
    expect(result.results[0]?.status).toBe("added");
    expect(result.timings[0]).toMatchObject({ searches: 2, modelCalls: 2 });
  });

  it("stops after an uncertain add and never advances to another ingredient", async () => {
    let searches = 0;
    let adds = 0;
    const result = await runCartFlow({
      tasks: cartTasks(list), baseline: [],
      search: async () => { searches += 1; return [candidate("B000000001", "Rice")]; },
      decide: async () => ({ action: "select", candidateId: "B000000001", quantity: 1, option: null, reason: null }),
      add: async () => { adds += 1; throw new Error("cart response timed out"); },
    });
    expect(result.stopped).toBe(true);
    expect(result.failure).toMatchObject({ stage: "interaction", mayHaveCommitted: true });
    expect(result.results).toHaveLength(1);
    expect(searches).toBe(1);
    expect(adds).toBe(1);
    expect(result.timings[0]?.outcome).toBe("failed");
  });

  it("does not select a candidate with unknown availability", async () => {
    const result = await runCartFlow({
      tasks: cartTasks({ recipes: [{ ...list.recipes[0]!, ingredients: [list.recipes[0]!.ingredients[0]!] }] }),
      baseline: [],
      search: async () => [{ ...candidate("B000000001", "Rice"), available: null }],
      decide: async () => ({ action: "select", candidateId: "B000000001", quantity: 1, option: null, reason: null }),
      add: async () => { throw new Error("must not add"); },
    });
    expect(result.failure?.stage).toBe("decision");
    expect(result.failure?.mayHaveCommitted).toBe(false);
  });

  it("counts a weighted chooser decision and reports its resolved quantity", async () => {
    const result = await runCartFlow({
      tasks: cartTasks({ recipes: [{ ...list.recipes[0]!, ingredients: [list.recipes[0]!.ingredients[0]!] }] }),
      baseline: [],
      search: async () => [candidate("B000000001", "Chicken")],
      decide: async () => ({ action: "select", candidateId: "B000000001", quantity: 2, option: null, reason: "initial" }),
      add: async (_task, _candidate, _quantity, _option, _before, _cart, recordDecision) => {
        recordDecision(25);
        return {
          snapshot: { items: [{ asin: "B000000001", quantity: 1.56 }], observedAt: "now", url: "https://www.wholefoodsmarket.com/api/cartcache", method: "POST", status: 200 },
          quantity: 1,
          reason: "One pack is estimated at 1.56 lb",
        };
      },
    });
    expect(result.results[0]).toMatchObject({ quantity: 1, rationale: "One pack is estimated at 1.56 lb" });
    expect(result.timings[0]).toMatchObject({ modelCalls: 2 });
  });
});
