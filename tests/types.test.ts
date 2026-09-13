import { describe, expect, it } from "vitest";
import type { GroceryRequest } from "../src/types.js";

describe("shared types", () => {
  it("represent a recipe-aware request", () => {
    const request: GroceryRequest = {
      recipes: [{
        id: "stir-fry",
        name: "Chicken stir-fry",
        servings: 2,
        context: "Quick weeknight dish",
        ingredients: [{
          id: "chicken",
          request: "about 1.5 lb chicken thighs",
          preferences: ["boneless", "skinless"],
        }],
      }],
    };
    expect(request.recipes[0]?.ingredients[0]?.id).toBe("chicken");
  });
});
