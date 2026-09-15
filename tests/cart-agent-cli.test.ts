import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import type { AuthReport, CartAgentResult } from "../src/types.js";

const baseEnv = (root: string) => ({
  HOME: root,
  USER: "test",
  PLAYWRIGHT_MCP_BIN: "/usr/bin/true",
  CHROME_EXECUTABLE: "/usr/bin/true",
  WFM_EXPECTED_DELIVERY_ADDRESS: "78701",
});

const validPreflight: AuthReport = {
  runStatus: "completed",
  authenticated: true,
  deliveryModeConfirmed: true,
  deliveryAddressConfirmed: true,
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
  cpSync(new URL("fixtures/valid-request.json", import.meta.url), request);
  return { root, request };
};

describe("Cart Agent CLI orchestration", () => {
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
              items: [{ productName: "Chicken thighs", quantity: 1 }],
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
      expectedAddressText: "78701",
      deliveryMode: "delivery",
    });
    const reportPath = join(root, "runs");
    expect(readFileSync(request, "utf8")).toContain("chicken");
    expect(reportPath).toContain("runs");
  });

  it("fails before page preparation or Cart Agent invocation when baseline extraction is degraded", async () => {
    const { root, request } = setup();
    let prepared = false;
    let invoked = false;
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
  });
});
