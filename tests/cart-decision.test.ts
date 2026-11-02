import { describe, expect, it } from "vitest";
import {
  buildDecisionInvocation,
  parseAndValidateDecision,
  parseDecision,
  quantityFromSelectedPackSize,
  renderDecisionPrompt,
  type DecisionCandidate,
} from "../src/cart-decision.js";

const candidates: DecisionCandidate[] = [
  { id: "a", productName: "Organic chickpeas", packageSize: "15 oz", price: "$2", available: true, text: "Canned" },
  { id: "b", productName: "Unavailable chickpeas", packageSize: "15 oz", price: "$2", available: false, text: "Unavailable" },
];
describe("bounded cart decisions", () => {
  it("parses each strict action and never accepts added", () => {
    expect(parseDecision('{"action":"select","candidateId":"a","quantity":2,"option":null,"query":null,"reason":null}')).toMatchObject({ action: "select", candidateId: "a", quantity: 2, option: null });
    expect(() => parseDecision('{"action":"added","candidateId":"a"}')).toThrow("Invalid cart decision");
    expect(() => parseDecision('{"action":"skip","reason":"no match","extra":true}')).toThrow("Invalid cart decision");
    expect(parseDecision('{"action":"search_again","candidateId":null,"quantity":1,"option":null,"query":"regular soy sauce","reason":"No product candidates were supplied."}')).toEqual({ action: "search_again", query: "regular soy sauce" });
    expect(() => parseDecision('{"action":"already_present","candidateId":null,"quantity":0,"option":null,"query":null,"cartProductId":"cart-1","reason":null}')).toThrow("Invalid cart decision");
  });

  it("validates selected IDs against current observations", () => {
    expect(parseAndValidateDecision('{"action":"select","candidateId":"a","quantity":1,"option":null,"query":null,"reason":null}', candidates).action).toBe("select");
    expect(() => parseAndValidateDecision('{"action":"select","candidateId":"gone","quantity":1,"option":null,"query":null,"reason":null}', candidates)).toThrow("stale candidate");
    expect(() => parseAndValidateDecision('{"action":"select","candidateId":"b","quantity":1,"option":null,"query":null,"reason":null}', candidates)).toThrow("unavailable");
  });

  it("renders observations as bounded data and builds no-MCP invocation", () => {
    const prompt = renderDecisionPrompt({ task: { ingredientId: "i", requested: "beans" }, candidates: [{ ...candidates[0]!, description: "Mild, creamy chickpeas." }] });
    expect(prompt).toContain("BEGIN STOREFRONT OBSERVATION");
    expect(prompt).toContain("no browser");
    expect(prompt).toContain("quantity is the additional amount requested for this task");
    expect(prompt).toContain("Do not offset, reuse, or count existing cart quantities");
    expect(prompt).toContain('"description": "Mild, creamy chickpeas."');
    const invocation = buildDecisionInvocation({ rootDir: "/repo", outputPath: "/tmp/decision.json", schemaPath: "/repo/schemas/cart-decision.schema.json" });
    expect(invocation.args).toContain("gpt-6.1-terra");
    expect(invocation.args).toContain('model_reasoning_effort="medium"');
    expect(invocation.args.join(" ")).not.toContain("playwright");
    expect(invocation.args).toContain('permissions.wfm-model.extends=":read-only"');
    expect(invocation.args).toContain('features.shell_tool=false');
    expect(invocation.args).not.toContain("--sandbox");
  });

  it("shows weighted chooser options as a second bounded decision", () => {
    const prompt = renderDecisionPrompt({
      task: { ingredientId: "chicken", requested: "about 1.5 lb chicken thighs" },
      candidates: [candidates[0]!],
      quantityOptions: [{ quantity: 1, label: "1 est. 1.56 lb" }, { quantity: 2, label: "2 est. 3.12 lb" }],
    });
    expect(prompt).toContain("The selected product opened a weighted-item quantity chooser");
    expect(prompt).toContain("1 est. 1.56 lb");
    expect(prompt).toContain("2 est. 3.12 lb");
  });

  it("passes stated pack size and chooser estimates to the weighted decision", () => {
    const prompt = renderDecisionPrompt({
      task: { ingredientId: "chicken", requested: "boneless skinless chicken thighs", purchaseRequirement: {
        total: { quantity: 2.6, unit: "kg", approximate: false }, optional: false, alternatives: [], sources: ["dinner.md"],
      } },
      candidates: [{ id: "chicken-id", productName: "Boneless Skinless Chicken Thighs", packageSize: null, price: "$5.49/lb", available: true, text: "Sold by weight" }],
      selectedPackSize: "3 Pound (Pack of 1)",
      quantityOptions: [
        { quantity: 1, label: "1 est. 2.75 lb" },
        { quantity: 2, label: "2 est. 5.5 lb" },
        { quantity: 3, label: "3 est. 8.25 lb" },
      ],
    });
    expect(prompt).toContain("product's stated size");
    expect(prompt).toContain('"selectedPackSize": "3 Pound (Pack of 1)"');
    expect(prompt).toContain('"label": "2 est. 5.5 lb"');
    expect(prompt).toContain('"quantity": 3');
  });

  it("uses the stated 3 lb pack size to choose two packs for 2.6 kg", () => {
    const total = { quantity: 2.6, unit: "kg", approximate: false };
    const options = [1, 2, 3].map((quantity) => ({ quantity, label: `${quantity} estimated` }));
    expect(quantityFromSelectedPackSize(total, "3 Pound (Pack of 1)", options)).toBe(2);
    expect(quantityFromSelectedPackSize(total, null, options)).toBeNull();
  });

  it("accepts a modest shortfall instead of rounding up past the target range", () => {
    const total = { quantity: 900, unit: "g", approximate: false };
    const options = [1, 2, 3, 4].map((quantity) => ({ quantity, label: String(quantity) }));
    expect(quantityFromSelectedPackSize(total, "10 oz", options)).toBe(3);
    expect(quantityFromSelectedPackSize(total, "16 oz", options)).toBe(2);
  });

  it("uses the closest in-range option and otherwise the smallest sufficient listed option", () => {
    const options = [1, 2, 3, 4].map((quantity) => ({ quantity, label: String(quantity) }));
    expect(quantityFromSelectedPackSize({ quantity: 195, unit: "g", approximate: false }, "100 g", options)).toBe(2);
    expect(quantityFromSelectedPackSize({ quantity: 240, unit: "g", approximate: false }, "100 g", options)).toBe(3);
    expect(quantityFromSelectedPackSize({ quantity: 180, unit: "g", approximate: false }, "100 g", [options[0]!, options[2]!])).toBe(3);
    expect(quantityFromSelectedPackSize({ quantity: 900, unit: "g", approximate: false }, "10 oz", [options[0]!])).toBeNull();
    expect(quantityFromSelectedPackSize(undefined, "10 oz", options)).toBeNull();
    expect(quantityFromSelectedPackSize({ quantity: 1, unit: "cup", approximate: false }, "10 oz", options)).toBeNull();
  });
});
