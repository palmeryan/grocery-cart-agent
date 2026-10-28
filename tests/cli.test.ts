import { cpSync, existsSync, readdirSync, readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { parseCommand, runCli, withCliSignalHandlers } from "../src/cli.js";
import type { runIngredientsAgent } from "../src/ingredients-agent.js";
import type { AuthReport } from "../src/types.js";

const fixture = (name: string): string => new URL(`fixtures/${name}`, import.meta.url).pathname;
const setup = (): { root: string; request: string } => {
  const root = mkdtempSync(join(tmpdir(), "wfm-cli-flow-"));
  const request = join(root, "request.json");
  cpSync(fixture("valid-shopping-list.json"), request);
  return { root, request };
};
const env = (root: string): NodeJS.ProcessEnv => ({
  HOME: root, CHROME_EXECUTABLE: "/usr/bin/true", WFM_MAX_RUN_MS: "60000",
});
const auth = (): AuthReport => ({
  runStatus: "completed", authenticated: true,
  wholeFoodsStorefrontConfirmed: true,
  failureReason: null,
});
const inspection = (items: { productName: string; productId?: string; quantity: number }[]) => ({
  items, totalItemCount: items.reduce((sum, item) => sum + item.quantity, 0),
  url: "https://www.wholefoodsmarket.com/grocery/cart", bodyText: "cart",
  extractionStatus: "complete" as const, extractionDiagnostic: null,
});

describe("cart CLI", () => {
  it("parses model and effort overrides", () => {
    expect(parseCommand(["build", "request.json", "--model", "gpt-5.6-luna", "--effort", "low"])).toEqual({
      command: "build", shoppingListPath: "request.json", cartDecisionModel: "gpt-5.6-luna", cartDecisionReasoningEffort: "low",
    });
    expect(parseCommand(["build", "request.json", "--effort", "maximum"])).toBeNull();
  });

  it("supports the diagnostic commands", () => {
    expect(parseCommand(["auth-check"])).toEqual({ command: "auth-check" });
    expect(parseCommand(["attachment-check"])).toEqual({ command: "attachment-check" });
  });

  it("parses the ingredients-only command", () => {
    expect(parseCommand(["ingredients", "one.md", "two.md"])).toEqual({
      command: "ingredients", recipePaths: ["one.md", "two.md"],
    });
    expect(parseCommand(["ingredients", "one.md", "--effort", "low"])).toBeNull();
  });

  it("parses the mandatory-review end-to-end command and rejects the old bypass route", () => {
    expect(parseCommand(["shopper-helper", "one.md", "two.md"])).toEqual({
      command: "shopper-helper", recipePaths: ["one.md", "two.md"],
    });
    expect(parseCommand(["shopper-helper"])).toEqual({ command: "shopper-helper", recipePaths: [] });
    expect(parseCommand(["build-recipes", "one.md", "--review"])).toBeNull();
    expect(parseCommand(["shopper-helper", "one.md", "--skip-review"])).toBeNull();
    expect(parseCommand(["ingredients", "one.md", "--review"])).toBeNull();
    expect(parseCommand(["ingredients-review", "list.json", "--output", "reviewed.json"])).toEqual({
      command: "ingredients-review", shoppingListPath: "list.json", outputPath: "reviewed.json",
    });
  });

  it("feeds interactively entered recipes into Ingredients Agent and exits before it on cancel", async () => {
    const { root } = setup();
    const documents = [{ sourceName: "Pasta", text: "Pasta\n\n2 cups tomatoes" }];
    let received: unknown;
    let browserLaunched = false;
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const cancelled = await runCli(["shopper-helper"], {
      rootDir: root, env: env(root),
      enterRecipes: async () => null,
      runIngredients: async () => { throw new Error("Ingredients Agent must not start after cancel"); },
      launchBrowser: async () => { browserLaunched = true; throw new Error("Browser must not launch"); },
    });
    expect(cancelled).toBe(0);
    expect(existsSync(join(root, "runs"))).toBe(false);
    const exitCode = await runCli(["shopper-helper"], {
      rootDir: root, env: env(root),
      enterRecipes: async () => documents,
      runIngredients: async (input) => {
        received = input.documents;
        return { shoppingList: { ingredients: [{ id: "tomatoes", request: "Tomatoes" }] }, recipeCompilation: {} } as Awaited<ReturnType<typeof runIngredientsAgent>>;
      },
      reviewShoppingList: async () => null,
      launchBrowser: async () => { browserLaunched = true; throw new Error("Browser must not launch after cancelled review"); },
    });
    output.mockRestore();
    expect(exitCode).toBe(0);
    expect(received).toEqual(documents);
    expect(browserLaunched).toBe(false);
  });

  it("saves an empty shopper-helper review and never launches the cart", async () => {
    const { root } = setup();
    const recipePath = join(root, "recipe.md");
    writeFileSync(recipePath, "Chicken thighs\n");
    let browserLaunched = false;
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const exitCode = await runCli(["shopper-helper", recipePath], {
      rootDir: root, env: env(root),
      runIngredients: async () => ({
        shoppingList: { ingredients: [{ id: "chicken", request: "Chicken thighs" }] }, recipeCompilation: {},
      }) as Awaited<ReturnType<typeof runIngredientsAgent>>,
      reviewShoppingList: async () => new Set(),
      launchBrowser: async () => { browserLaunched = true; throw new Error("Unexpected browser launch"); },
    });
    expect(exitCode).toBe(0);
    expect(output.mock.calls.map(([message]) => message)).toEqual(expect.arrayContaining([
      "[progress] Reading 1 recipe with the Ingredients Agent",
      "[progress] Ingredients ready: 1 shopping-list items",
    ]));
    output.mockRestore();
    expect(browserLaunched).toBe(false);
    const runDir = join(root, "runs", readdirSync(join(root, "runs"))[0]!);
    expect(JSON.parse(readFileSync(join(runDir, "reviewed-shopping-list.json"), "utf8")).ingredients).toEqual([]);
    expect(JSON.parse(readFileSync(join(runDir, "shopping-list.json"), "utf8")).ingredients.length).toBeGreaterThan(0);
  });

  it("passes only selected items into the cart path after shopper-helper review", async () => {
    const { root } = setup();
    const recipePath = join(root, "recipe.md");
    writeFileSync(recipePath, "Apples and bread\n");
    let launched = false;
    await runCli(["shopper-helper", recipePath], {
      rootDir: root, env: env(root),
      runIngredients: async () => ({
        shoppingList: { ingredients: [
          { id: "apples", request: "Apples" }, { id: "bread", request: "Bread" },
        ] }, recipeCompilation: {},
      }) as Awaited<ReturnType<typeof runIngredientsAgent>>,
      reviewShoppingList: async () => new Set(["bread"]),
      reservePort: async () => 45678,
      launchBrowser: async () => { launched = true; throw new Error("Expected stop after review"); },
    });
    expect(launched).toBe(true);
    const runDir = join(root, "runs", readdirSync(join(root, "runs"))[0]!);
    expect(JSON.parse(readFileSync(join(runDir, "reviewed-shopping-list.json"), "utf8")).ingredients)
      .toEqual([{ id: "bread", request: "Bread" }]);
  });

  it("writes a filtered cart-ready shopping list from ingredients-review without launching Chrome", async () => {
    const { root, request } = setup();
    const outputPath = join(root, "reviewed.json");
    let browserLaunched = false;
    const exitCode = await runCli(["ingredients-review", request, "--output", outputPath], {
      rootDir: root, env: env(root),
      reviewShoppingList: async (list) => new Set([(list.ingredients ?? list.recipes.flatMap((recipe) => recipe.ingredients))[0]!.id]),
      launchBrowser: async () => { browserLaunched = true; throw new Error("Unexpected browser launch"); },
    });
    expect(exitCode).toBe(0);
    expect(browserLaunched).toBe(false);
    expect(JSON.parse(readFileSync(outputPath, "utf8")).recipes).toHaveLength(1);
    expect(JSON.parse(readFileSync(outputPath, "utf8")).recipes[0].context).toBe("Quick weeknight dish; boneless meat preferred");
    expect(JSON.parse(readFileSync(request, "utf8")).recipes).toHaveLength(1);
  });

  it("installs and removes signal handlers around a run", async () => {
    const events: string[] = [];
    const fakeProcess = {
      on: (name: string) => { events.push(`on:${name}`); return fakeProcess; },
      off: (name: string) => { events.push(`off:${name}`); return fakeProcess; },
    } as unknown as NodeJS.Process;
    await withCliSignalHandlers(async () => { events.push("run"); }, { processObject: fakeProcess, signals: ["SIGINT", "SIGTERM"] });
    expect(events).toEqual(["on:SIGINT", "on:SIGTERM", "run", "off:SIGINT", "off:SIGTERM"]);
  });

  it("runs the cart-flow seam and writes progress, timings, and usage", async () => {
    const { root, request } = setup();
    let inspections = 0;
    const exitCode = await runCli(["build", request], {
      rootDir: root, env: env(root),
      reservePort: async () => 45678,
      launchBrowser: async () => ({ pid: 1, stop: async () => ({ stopped: true, remainingProfilePids: [] }) }),
      runDeterministicCheck: async () => auth(),
      inspectCart: async () => { inspections += 1; return inspection(inspections === 1 ? [] : [{ productName: "Chicken thighs", productId: "B000000001", quantity: 1 }]); },
      runCartItems: async ({ tasks }) => ({
        total: tasks.length, completed: tasks.length,
        results: tasks.map((task) => ({ ingredientId: task.ingredient.id, requested: task.ingredient.request, status: "added" as const, productName: "Chicken thighs", productId: "B000000001", packageSize: "1.5 lb", quantity: 1, price: "$9.99", rationale: "matches", confidence: "medium" as const, failureReason: null })),
        timings: tasks.map((task) => ({ ingredientId: task.ingredient.id, searchMs: 4, decisionMs: 7, interactionAndConfirmationMs: 9, totalMs: 20, modelCalls: 1, searches: 1, outcome: "added" as const })),
        stopped: false, stopReason: null, latestSnapshot: null, failure: null,
      }),
    });
    expect(exitCode).toBe(0);
    expect(inspections).toBe(2);
    const runDir = join(root, "runs", readdirSync(join(root, "runs"))[0]!);
    expect(JSON.parse(readFileSync(join(runDir, "progress.json"), "utf8")).timings[0].decisionMs).toBe(7);
    expect(JSON.parse(readFileSync(join(runDir, "timings.json"), "utf8"))).toMatchObject({
      totalItemMs: 20,
      items: [expect.objectContaining({ decisionMs: 7, interactionAndConfirmationMs: 9 })],
      wallMs: expect.any(Number),
    });
    expect(JSON.parse(readFileSync(join(runDir, "usage.json"), "utf8"))).toBeTruthy();
  });

  it("writes a failure report and progress when the cart-flow seam stops", async () => {
    const { root, request } = setup();
    const exitCode = await runCli(["build", request], {
      rootDir: root, env: env(root), reservePort: async () => 45678,
      launchBrowser: async () => ({ pid: 1, stop: async () => ({ stopped: true, remainingProfilePids: [] }) }),
      runDeterministicCheck: async () => auth(), inspectCart: async () => inspection([]),
      runCartItems: async ({ tasks }) => ({ total: tasks.length, completed: 0, results: [], timings: [], stopped: true, stopReason: "decision: no defensible choice", latestSnapshot: null, failure: { task: tasks[0]!, stage: "decision", reason: "decision: no defensible choice", mayHaveCommitted: false, candidate: null, quantity: null } }),
    });
    expect(exitCode).toBe(1);
    const runDir = join(root, "runs", readdirSync(join(root, "runs"))[0]!);
    expect(existsSync(join(runDir, "cart-decision-diagnostic.json"))).toBe(true);
    const report = JSON.parse(readFileSync(join(runDir, "report.json"), "utf8"));
    expect(report.runStatus).toBe("failed");
    expect(report.failureReason).toContain("no defensible choice");
  });
});
