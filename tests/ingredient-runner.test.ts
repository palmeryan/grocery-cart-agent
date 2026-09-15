import { describe, expect, it } from "vitest";
import {
  flattenIngredientTasks,
  runIngredientTasks,
} from "../src/ingredient-runner.js";
import type { GroceryRequest, IngredientResult } from "../src/types.js";

const request: GroceryRequest = {
  recipes: [{
    id: "recipe",
    name: "Test recipe",
    servings: 2,
    context: "A test cooking context",
    ingredients: [
      { id: "apples", request: "2 apples" },
      { id: "salt", request: "salt" },
    ],
  }],
};

const added = (ingredientId: string, requested: string): IngredientResult => ({
  ingredientId,
  requested,
  status: "added",
  productName: `${ingredientId} product`,
  packageSize: "1 package",
  quantity: 1,
  price: "$1.00",
  rationale: "The product fits the request.",
  confidence: "high",
  failureReason: null,
});

describe("ingredient runner", () => {
  it("flattens recipes while preserving recipe context", () => {
    const tasks = flattenIngredientTasks(request);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]?.ingredient.id).toBe("apples");
    expect(tasks[0]?.recipeContext[0]?.name).toBe("Test recipe");
  });

  it("invokes exactly once per ingredient in order and passes prior results", async () => {
    const calls: string[] = [];
    const priorCounts: number[] = [];
    const progress: number[] = [];
    const result = await runIngredientTasks({
      tasks: flattenIngredientTasks(request),
      session: { name: "shared" },
      invokeAgent: async ({ task, priorResults }) => {
        calls.push(task.ingredient.id);
        priorCounts.push(priorResults.length);
        return added(task.ingredient.id, task.ingredient.request);
      },
      onProgress: (current) => {
        progress.push(current.completed);
      },
    });

    expect(calls).toEqual(["apples", "salt"]);
    expect(priorCounts).toEqual([0, 1]);
    expect(progress).toEqual([1, 2]);
    expect(result.completed).toBe(2);
    expect(result.stopped).toBe(false);
  });

  it("records an explicit agent failure and continues to the next ingredient", async () => {
    const calls: string[] = [];
    const result = await runIngredientTasks({
      tasks: flattenIngredientTasks(request),
      session: undefined,
      invokeAgent: async ({ task }) => {
        calls.push(task.ingredient.id);
        if (task.ingredient.id === "apples") {
          return {
            ingredientId: task.ingredient.id,
            requested: task.ingredient.request,
            status: "failed",
            productName: null,
            packageSize: null,
            quantity: 0,
            price: null,
            rationale: "The agent could not complete the item.",
            confidence: "low",
            failureReason: "The product page was unavailable.",
          } satisfies IngredientResult;
        }
        return added(task.ingredient.id, task.ingredient.request);
      },
    });

    expect(calls).toEqual(["apples", "salt"]);
    expect(result.results.map(({ result: item }) => item.status)).toEqual([
      "failed",
      "added",
    ]);
  });

  it("keeps processing when diagnostic progress output fails", async () => {
    const result = await runIngredientTasks({
      tasks: flattenIngredientTasks(request),
      session: undefined,
      invokeAgent: async ({ task }) => added(task.ingredient.id, task.ingredient.request),
      onProgress: () => {
        throw new Error("progress directory unavailable");
      },
    });

    expect(result.completed).toBe(2);
    expect(result.stopped).toBe(false);
  });

  it("enforces status-specific product fields after schema parsing", async () => {
    const [task] = flattenIngredientTasks(request);
    const result = await runIngredientTasks({
      tasks: task ? [task] : [],
      session: undefined,
      invokeAgent: async ({ task: currentTask }) => ({
        ingredientId: currentTask.ingredient.id,
        requested: currentTask.ingredient.request,
        status: "added",
        productName: null,
        packageSize: null,
        quantity: 0,
        price: null,
        rationale: "Malformed result for validation coverage.",
        confidence: "low",
        failureReason: null,
      }),
    });

    expect(result.results[0]?.result.status).toBe("failed");
    expect(result.results[0]?.result.failureReason).toContain(
      "without a complete product result",
    );
  });
});
