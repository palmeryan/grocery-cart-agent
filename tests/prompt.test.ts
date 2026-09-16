import { describe, expect, it } from "vitest";
import {
  renderAttachmentPrompt,
  renderCartAgentPrompt,
  renderIngredientsAgentPrompt,
} from "../src/prompt.js";
import type { CartAgentTask } from "../src/cart-agent.js";

describe("Cart Agent prompt", () => {
  it("scopes each agent invocation to one ingredient and carries cart context", () => {
    const task: CartAgentTask = {
      ingredient: {
        id: "chicken",
        request: "about 1.5 lb chicken thighs",
        preferences: ["boneless", "skinless"],
      },
      recipeContext: [{
        id: "stir-fry",
        name: "Chicken stir-fry",
        servings: 4,
        context: "Quick weeknight dish",
      }],
    };
    const prompt = renderCartAgentPrompt({
      task,
      cartContext: {
        baselineItems: [{ productName: "Salt", quantity: 1 }],
        priorResults: [],
      },
    });
    expect(prompt).toContain("one Whole Foods Market ingredient");
    expect(prompt).toContain("chicken thighs");
    expect(prompt).toContain("Chicken stir-fry");
    expect(prompt).toContain("baselineItems");
    expect(prompt).toContain("return `already_present`");
    expect(prompt).toContain("browser_evaluate");
    expect(prompt).toContain("browser_find");
    expect(prompt).toContain("browser_snapshot");
    expect(prompt).toContain("weighted product");
    expect(prompt).not.toContain("DELIVERY MODE:");
    expect(prompt).not.toContain("BROWSER OUTPUT DIRECTORY:");
  });
});

describe("harmless attachment prompt", () => {
  it("permits only navigation to and observation of Example Domain", () => {
    const prompt = renderAttachmentPrompt();
    expect(prompt).toContain("https://example.com");
    expect(prompt).toMatch(
      /navigate the controlled tab directly to\s+https:\/\/example\.com/,
    );
    expect(prompt).toContain("browser_navigate");
    expect(prompt).toContain("NEVER use browser_run_code_unsafe");
    expect(prompt).toContain("Do not navigate anywhere else");
    expect(prompt).toContain("Do not click, type, or submit");
    expect(prompt).not.toContain("Amazon");
    expect(prompt).not.toContain("cart");
  });
});

describe("Ingredients Agent prompt", () => {
  it("delimits every raw recipe without altering its contents", () => {
    const prompt = renderIngredientsAgentPrompt({
      recipeDocuments: [
        { sourceName: "recipe.md", text: "Ingredients\n2 apples" },
        { sourceName: "other.md", text: "Ingredients\n1 lemon" },
      ],
    });
    expect(prompt.match(/BEGIN RECIPE SOURCE/g)).toHaveLength(2);
    expect(prompt.match(/END RECIPE SOURCE/g)).toHaveLength(2);
    expect(prompt).toContain("RECIPE SOURCE: recipe.md\nBEGIN RECIPE SOURCE\nIngredients\n2 apples\nEND RECIPE SOURCE");
    expect(prompt).toContain("RECIPE SOURCE: other.md\nBEGIN RECIPE SOURCE\nIngredients\n1 lemon\nEND RECIPE SOURCE");
  });
});
