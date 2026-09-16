import { describe, expect, it } from "vitest";
import {
  renderAttachmentPrompt,
  renderIngredientsAgentPrompt,
} from "../src/prompt.js";
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
