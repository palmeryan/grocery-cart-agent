import { describe, expect, it } from "vitest";
import { renderIngredientsAgentPrompt } from "../src/prompt.js";

describe("agent naming contracts", () => {
  it("uses Ingredients Agent for recipe-to-list work", () => {
    const prompt = renderIngredientsAgentPrompt({
      recipeDocuments: [{ sourceName: "recipe.md", text: "- 2 apples" }],
    });
    expect(prompt).toContain("# Ingredients Agent");
    expect(prompt).toContain("Do not browse, shop, interact with a browser");
  });

});
