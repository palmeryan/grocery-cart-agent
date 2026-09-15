import { describe, expect, it } from "vitest";
import { flattenCartAgentTasks } from "../src/cart-agent.js";
import { renderCartAgentPrompt, renderIngredientsAgentPrompt } from "../src/prompt.js";
import type { GroceryRequest } from "../src/types.js";

const request: GroceryRequest = {
  recipes: [{
    id: "recipe",
    name: "Test recipe",
    servings: 2,
    context: "Dinner",
    ingredients: [{ id: "apples", request: "2 apples" }],
  }],
};

describe("agent naming contracts", () => {
  it("uses Ingredients Agent for recipe-to-list work", () => {
    const prompt = renderIngredientsAgentPrompt({
      recipeDocuments: [{ sourceName: "recipe.md", text: "- 2 apples" }],
    });
    expect(prompt).toContain("# Ingredients Agent");
    expect(prompt).toContain("Do not browse, shop, interact with a browser");
  });

  it("uses Cart Agent for one browser-enabled ingredient task", () => {
    const [task] = flattenCartAgentTasks(request);
    expect(task).toBeDefined();
    const prompt = renderCartAgentPrompt({
      task: task!,
      deliveryMode: "delivery",
      cartContext: { baselineItems: [], priorResults: [] },
      browserOutputDir: "/tmp/browser",
    });
    expect(prompt).toContain("# Cart Agent");
    expect(prompt).toContain("CART AGENT TASK:");
    expect(prompt).toContain("returned the controlled tab");
  });
});
