import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import {
  compileRecipeCompilation,
  recipeCompilationToShoppingList,
} from "../src/shopping-list-compiler.js";
import type { AuthReport, CartAgentResult } from "../src/types.js";

const baseEnv = (root: string) => ({
  HOME: root,
  USER: "test",
  PLAYWRIGHT_MCP_BIN: "/usr/bin/true",
  CHROME_EXECUTABLE: "/usr/bin/true",
});

const validPreflight: AuthReport = {
  runStatus: "completed",
  authenticated: true,
  deliveryModeConfirmed: true,
  wholeFoodsStorefrontConfirmed: true,
  checkoutVisited: false,
  settingsChanged: false,
  failureReason: null,
};

const addedResult: CartAgentResult = {
  ingredientId: "chicken",
  requested: "about 1.5 lb boneless skinless chicken thighs",
  status: "added",
  productName: "Chicken thighs",
  productId: "B000000001",
  packageSize: "1.5 lb",
  quantity: 1,
  price: "$9.99",
  rationale: "The product fits the recipe context.",
  confidence: "high",
  failureReason: null,
};

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "wfm-cart-agent-cli-"));
  const request = join(root, "request.json");
  cpSync(new URL("fixtures/valid-shopping-list.json", import.meta.url), request);
  return { root, request };
};

describe("Cart Agent CLI orchestration", () => {
  it("runs recipe documents through the Ingredients Agent path before the shared Cart Agent path", async () => {
    const { root } = setup();
    const recipePath = join(root, "apples.md");
    writeFileSync(recipePath, "2 apples\n");
    const compilation = compileRecipeCompilation({
      recipes: [{
        sourceName: "apples.md",
        ingredients: [{
          sourceText: "2 apples",
          name: "apple",
          amount: {
            raw: "2 apples",
            sourceQuantity: { quantity: 2, quantityMax: null, unit: "apples", approximate: false },
            additiveQuantity: { quantity: 2, quantityMax: null, unit: "apples", approximate: false },
          },
          preparation: null,
          context: null,
          optional: false,
          pantryStatus: "buy",
          alternatives: [],
          unresolved: [],
        }],
      }],
    });
    const shoppingList = recipeCompilationToShoppingList(compilation);
    const item = shoppingList.recipes[0]!.ingredients[0]!;
    let ingredientsAgentCalled = false;
    let inspections = 0;
    const exitCode = await runCli(["build-recipes", recipePath], {
      rootDir: root,
      env: baseEnv(root),
      reservePort: async () => 45678,
      launchBrowser: async () => ({
        pid: 4242,
        remoteDebuggingPort: 45678,
        stop: async () => ({ stopped: true, remainingProfilePids: [] }),
      }),
      runIngredients: async ({ documents }) => {
        ingredientsAgentCalled = true;
        expect(documents.map(({ sourceName }) => sourceName)).toEqual(["apples.md"]);
        return {
          shoppingList,
          recipeCompilation: compilation,
          codex: { exitCode: 0, signal: null, timedOut: false },
        };
      },
      runDeterministicCheck: async () => validPreflight,
      inspectCart: async () => {
        inspections += 1;
        return inspections === 1
          ? {
              items: [], totalItemCount: 0,
              url: "https://www.wholefoodsmarket.com/grocery/cart",
              bodyText: "Your cart is empty", extractionStatus: "complete" as const,
              extractionDiagnostic: null,
            }
          : {
              items: [{ productName: "Organic Apples", productId: "B000000002", quantity: 1 }], totalItemCount: 1,
              url: "https://www.wholefoodsmarket.com/grocery/cart",
              bodyText: "Organic Apples\nCurrent quantity: 1", extractionStatus: "complete" as const,
              extractionDiagnostic: null,
            };
      },
      prepareCartAgentPage: async () => undefined,
      invokeCartAgent: async ({ task }) => ({
        ingredientId: task.ingredient.id,
        requested: task.ingredient.request,
        status: "added",
        productName: "Organic Apples",
        productId: "B000000002",
        packageSize: "2 count",
        quantity: 1,
        price: "$3.99",
        rationale: "Matches the generated Shopping List.",
        confidence: "high",
        failureReason: null,
      }),
    });

    expect(exitCode).toBe(0);
    expect(ingredientsAgentCalled).toBe(true);
    expect(item.request).toContain("2 apples");
    const runDir = join(root, "runs", readdirSync(join(root, "runs"))[0]!);
    expect(JSON.parse(readFileSync(join(runDir, "shopping-list.json"), "utf8"))).toEqual(shoppingList);
    expect(JSON.parse(readFileSync(join(runDir, "recipe-compilation.json"), "utf8"))).toEqual(compilation);
    expect(JSON.parse(readFileSync(join(runDir, "usage.json"), "utf8"))).toMatchObject({
      schema_version: 1,
      totals: { invocation_count: 0 },
    });
  });

  it("returns to the shopping page after baseline inspection and before the Cart Agent", async () => {
    const { root, request } = setup();
    const events: string[] = [];
    let inspections = 0;
    let receivedExpectation: unknown;
    const exitCode = await runCli(["build", request], {
      rootDir: root,
      env: baseEnv(root),
      reservePort: async () => 45678,
      launchBrowser: async () => ({
        pid: 4242,
        remoteDebuggingPort: 45678,
        stop: async () => ({ stopped: true, remainingProfilePids: [] }),
      }),
      runDeterministicCheck: async (_kind, _session, expectation) => {
        receivedExpectation = expectation;
        return validPreflight;
      },
      inspectCart: async () => {
        inspections += 1;
        events.push(inspections === 1 ? "baseline" : "final");
        return inspections === 1
          ? {
              items: [],
              totalItemCount: 0,
              url: "https://www.wholefoodsmarket.com/grocery/cart",
              bodyText: "Your cart is empty",
              extractionStatus: "complete",
              extractionDiagnostic: null,
            }
          : {
              items: [{ productName: "Chicken thighs", productId: "B000000001", quantity: 1 }],
              totalItemCount: 1,
              url: "https://www.wholefoodsmarket.com/grocery/cart",
              bodyText: "Chicken thighs\nCurrent quantity: 1",
              extractionStatus: "complete",
              extractionDiagnostic: null,
            };
      },
      prepareCartAgentPage: async () => {
        events.push("shopping-page");
      },
      invokeCartAgent: async () => {
        events.push("cart-agent");
        return addedResult;
      },
    });

    expect(exitCode).toBe(0);
    expect(events).toEqual(["baseline", "shopping-page", "cart-agent", "final"]);
    expect(receivedExpectation).toEqual({
      deliveryMode: "delivery",
    });
    const reportPath = join(root, "runs");
    expect(readFileSync(request, "utf8")).toContain("chicken");
    expect(reportPath).toContain("runs");
    const runDir = join(reportPath, readdirSync(reportPath)[0]!);
    expect(JSON.parse(readFileSync(join(runDir, "usage.json"), "utf8"))).toMatchObject({
      schema_version: 1,
      totals: { invocation_count: 0 },
    });
  });

  it("fails before page preparation or Cart Agent invocation when baseline extraction is degraded", async () => {
    const { root, request } = setup();
    let prepared = false;
    let invoked = false;
    let browserStopped = false;
    const exitCode = await runCli(["build", request], {
      rootDir: root,
      env: baseEnv(root),
      reservePort: async () => 45678,
      launchBrowser: async () => ({
        pid: 4242,
        remoteDebuggingPort: 45678,
        stop: async () => {
          browserStopped = true;
          return { stopped: true, remainingProfilePids: [] };
        },
      }),
      runDeterministicCheck: async () => validPreflight,
      inspectCart: async () => ({
        items: [],
        totalItemCount: 0,
        url: "https://www.wholefoodsmarket.com/grocery/cart",
        bodyText: "",
        extractionStatus: "degraded",
        extractionDiagnostic: "cart selectors did not match",
      }),
      prepareCartAgentPage: async () => {
        prepared = true;
      },
      invokeCartAgent: async () => {
        invoked = true;
        return addedResult;
      },
    });

    expect(exitCode).toBe(1);
    expect(prepared).toBe(false);
    expect(invoked).toBe(false);
    expect(browserStopped).toBe(false);
  });

  it("leaves Chrome open without failing when final verification is inconclusive", async () => {
    const { root, request } = setup();
    let inspections = 0;
    let browserStopped = false;
    const exitCode = await runCli(["build", request], {
      rootDir: root,
      env: baseEnv(root),
      reservePort: async () => 45678,
      launchBrowser: async () => ({
        pid: 4242,
        remoteDebuggingPort: 45678,
        stop: async () => {
          browserStopped = true;
          return { stopped: true, remainingProfilePids: [] };
        },
      }),
      runDeterministicCheck: async () => validPreflight,
      inspectCart: async () => {
        inspections += 1;
        return {
          items: [],
          totalItemCount: 0,
          url: "https://www.wholefoodsmarket.com/grocery/cart",
          bodyText: inspections === 1 ? "Your cart is empty" : "cart rendered",
          extractionStatus: "complete",
          extractionDiagnostic: null,
        };
      },
      prepareCartAgentPage: async () => undefined,
      invokeCartAgent: async () => addedResult,
    });

    expect(exitCode).toBe(0);
    expect(browserStopped).toBe(false);
  });

  it("records and fails a Cart Agent checkout-boundary violation", async () => {
    const { root, request } = setup();
    const exitCode = await runCli(["build", request], {
      rootDir: root,
      env: baseEnv(root),
      reservePort: async () => 45678,
      launchBrowser: async () => ({
        pid: 4242,
        remoteDebuggingPort: 45678,
        stop: async () => ({ stopped: true, remainingProfilePids: [] }),
      }),
      runDeterministicCheck: async () => validPreflight,
      inspectCart: async () => {
        return {
          items: [], totalItemCount: 0,
          url: "https://www.wholefoodsmarket.com/grocery/cart",
          bodyText: "Your cart is empty", extractionStatus: "complete",
          extractionDiagnostic: null,
        };
      },
      prepareCartAgentPage: async () => undefined,
      invokeCartAgent: async () => addedResult,
      inspectCartAgentPage: async () => ({
        safe: false,
        checkoutVisited: true,
        settingsChanged: false,
        failureReason: "Cart Agent crossed the checkout boundary",
      }),
    });

    expect(exitCode).toBe(1);
    const runDir = join(root, "runs", readdirSync(join(root, "runs"))[0]!);
    const report = JSON.parse(readFileSync(join(runDir, "report.json"), "utf8"));
    expect(report.checkoutVisited).toBe(true);
    expect(report.runStatus).toBe("failed");
  });
});
