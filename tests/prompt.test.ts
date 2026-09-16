import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  renderAttachmentPrompt,
  renderCartAgentPrompt,
  renderIngredientsAgentPrompt,
  renderPrompt,
} from "../src/prompt.js";
import type { CartAgentTask } from "../src/cart-agent.js";
import type { CartReport, ShoppingList } from "../src/types.js";

const fixture = (name: string) =>
  fileURLToPath(new URL(`fixtures/${name}`, import.meta.url));

const request = JSON.parse(
  readFileSync(fixture("valid-shopping-list.json"), "utf8"),
) as ShoppingList;

const prior = JSON.parse(
  readFileSync(fixture("valid-report.json"), "utf8"),
) as CartReport;

describe("cart prompt", () => {
  it("includes location, request context, and the request hash", () => {
    const prompt = renderPrompt({
      request,
      requestSha256: "b".repeat(64),
      deliveryMode: "delivery",
      previousReport: null,
      browserOutputDir: "/repo/runs/id/browser",
    });
    expect(prompt).toContain("DELIVERY MODE: delivery");
    expect(prompt).toContain("Chicken stir-fry");
    expect(prompt).toContain("b".repeat(64));
  });

  it("contains the explicit checkout stop conditions", () => {
    const prompt = renderPrompt({
      request,
      requestSha256: "b".repeat(64),
      deliveryMode: "delivery",
      previousReport: prior,
      browserOutputDir: "/repo/runs/id/browser",
    });
    expect(prompt).toContain("NEVER open or enter checkout");
    expect(prompt).toContain("Do not change the saved address or payment setting");
    expect(prompt).toContain("report failure when the delivery context");
    expect(prompt).toContain("Use the current controlled page");
    expect(prompt).toContain(
      "https://www.wholefoodsmarket.com/grocery/search",
    );
    expect(prompt).toMatch(/Do not\s+create tabs/);
    expect(prompt).toContain("sole adaptive browser agent");
    expect(prompt).toContain("Do not expect a precomputed candidate list");
    expect(prompt).toContain("weighted products");
    expect(prompt).toContain("quantity selector");
    expect(prompt).toContain("click the resulting Add to Cart");
    expect(prompt).toContain("A quantity selector by itself is not a verified");
    expect(prompt).toMatch(/Do not\s+click the location control/);
    expect(prompt).not.toMatch(/\b43214\b/);
    expect(prompt).toMatch(/generic cart label such as "Pickup Location" does not\s+override observed delivery mode/);
    expect(prompt).toMatch(/Report delivery as confirmed from observed delivery mode, without requiring\s+a visible address string/);
    expect(prompt).toContain("PREVIOUS REPORT FOR CONTROLLED RERUN");
  });

  it("provides an absolute output path for optional final screenshots", () => {
    const browserOutputDir = "/repo/runs/abc123/browser";
    const prompt = renderPrompt({
      request,
      requestSha256: "b".repeat(64),
      deliveryMode: "delivery",
      previousReport: null,
      browserOutputDir,
    });
    expect(prompt).toContain(`BROWSER OUTPUT DIRECTORY: ${browserOutputDir}`);
    expect(prompt).toContain(`${browserOutputDir}/final-state.png`);
    expect(prompt).toMatch(
      /browser_take_screenshot[\s\S]*final-state\.png|final-state\.png[\s\S]*browser_take_screenshot/,
    );
    // Path must be labeled as output config, not free-form request text.
    const outputDirIndex = prompt.indexOf("BROWSER OUTPUT DIRECTORY:");
    const groceryRequestIndex = prompt.indexOf("GROCERY REQUEST:");
    expect(outputDirIndex).toBeGreaterThan(-1);
    expect(groceryRequestIndex).toBeGreaterThan(outputDirIndex);
  });
});

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
