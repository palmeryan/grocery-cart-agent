import { describe, expect, it } from "vitest";
import {
  buildDecisionInvocation,
  parseAndValidateDecision,
  parseDecision,
  renderDecisionPrompt,
  type DecisionCandidate,
} from "../src/cart-decision.js";

const candidates: DecisionCandidate[] = [
  { id: "a", productName: "Organic chickpeas", packageSize: "15 oz", price: "$2", available: true, text: "Canned" },
  { id: "b", productName: "Unavailable chickpeas", packageSize: "15 oz", price: "$2", available: false, text: "Unavailable" },
];
const cart = [{ productName: "Already beans", productId: "cart-1", quantity: 1 }];

describe("bounded cart decisions", () => {
  it("parses each strict action and never accepts added", () => {
    expect(parseDecision('{"action":"select","candidateId":"a","quantity":2,"option":null,"query":null,"cartProductId":null,"reason":null}')).toMatchObject({ action: "select", candidateId: "a", quantity: 2, option: null });
    expect(() => parseDecision('{"action":"added","candidateId":"a"}')).toThrow("Invalid cart decision");
    expect(() => parseDecision('{"action":"skip","reason":"no match","extra":true}')).toThrow("Invalid cart decision");
    expect(parseDecision('{"action":"search_again","candidateId":null,"quantity":1,"option":null,"query":"regular soy sauce","cartProductId":null,"reason":"No product candidates were supplied."}')).toEqual({ action: "search_again", query: "regular soy sauce" });
  });

  it("validates selected and existing IDs against observations", () => {
    expect(parseAndValidateDecision('{"action":"select","candidateId":"a","quantity":1,"option":null,"query":null,"cartProductId":null,"reason":null}', candidates, cart).action).toBe("select");
    expect(parseAndValidateDecision('{"action":"already_present","candidateId":null,"quantity":0,"option":null,"query":null,"cartProductId":"cart-1","reason":null}', candidates, cart).action).toBe("already_present");
    expect(() => parseAndValidateDecision('{"action":"select","candidateId":"gone","quantity":1,"option":null,"query":null,"cartProductId":null,"reason":null}', candidates, cart)).toThrow("stale candidate");
    expect(() => parseAndValidateDecision('{"action":"select","candidateId":"b","quantity":1,"option":null,"query":null,"cartProductId":null,"reason":null}', candidates, cart)).toThrow("unavailable");
    expect(() => parseAndValidateDecision('{"action":"already_present","candidateId":null,"quantity":0,"option":null,"query":null,"cartProductId":"gone","reason":null}', candidates, cart)).toThrow("missing cart product");
  });

  it("renders observations as bounded data and builds no-MCP invocation", () => {
    const prompt = renderDecisionPrompt({ task: { ingredientId: "i", requested: "beans" }, candidates, currentCart: cart });
    expect(prompt).toContain("BEGIN STOREFRONT OBSERVATION");
    expect(prompt).toContain("no browser");
    expect(prompt).toContain("return `already_present` instead of adding another unit");
    const invocation = buildDecisionInvocation({ rootDir: "/repo", outputPath: "/tmp/decision.json", schemaPath: "/repo/schemas/cart-decision.schema.json" });
    expect(invocation.args).toContain("gpt-5.6-terra");
    expect(invocation.args).toContain('model_reasoning_effort="medium"');
    expect(invocation.args.join(" ")).not.toContain("playwright");
    expect(invocation.args).toContain("read-only");
  });

  it("shows weighted chooser options as a second bounded decision", () => {
    const prompt = renderDecisionPrompt({
      task: { ingredientId: "chicken", requested: "about 1.5 lb chicken thighs" },
      candidates: [candidates[0]!],
      currentCart: [],
      quantityOptions: [{ quantity: 1, label: "1 est. 1.56 lb" }, { quantity: 2, label: "2 est. 3.12 lb" }],
    });
    expect(prompt).toContain("The selected product opened a weighted-item quantity chooser");
    expect(prompt).toContain("1 est. 1.56 lb");
    expect(prompt).toContain("2 est. 3.12 lb");
  });
});
