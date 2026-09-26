import { cpSync, existsSync, readdirSync, readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { parseCommand, runCli, withCliSignalHandlers } from "../src/cli.js";
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
  runStatus: "completed", authenticated: true, deliveryModeConfirmed: true,
  wholeFoodsStorefrontConfirmed: true, checkoutVisited: false, settingsChanged: false,
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
