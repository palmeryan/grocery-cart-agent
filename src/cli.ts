import {
  accessSync,
  constants,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser, Page } from "playwright";
import {
  canonicalShoppingList,
  createRunPaths,
  secureReport,
  sha256,
  writeShoppingListSnapshot,
  writeRunMetadata,
} from "./artifacts.js";
import {
  BrowserLaunchError,
  launchOwnedChrome,
  reserveLocalPort,
  type LaunchChromeInput,
} from "./browser.js";
import {
  connectToOwnedChrome,
  isWholeFoodsPage,
  runDeterministicCheck,
  type DeliveryContextExpectation,
} from "./deterministic-checks.js";
import {
  INGREDIENTS_AGENT_MODEL,
  INGREDIENTS_AGENT_REASONING_EFFORT,
  REASONING_EFFORTS,
  runCodex,
  type ReasoningEffort,
} from "./codex.js";
import { loadConfig } from "./config.js";
import {
  CartNetworkObserver,
  type CartNetworkSnapshot,
} from "./cart-network.js";
import { DECISION_MODEL, DECISION_REASONING_EFFORT, buildDecisionInvocation, parseAndValidateDecision, quantityFromSelectedPackSize, renderDecisionPrompt } from "./cart-decision.js";
import { CartNoMutationError, CartRunFatalError, cartTasks, runCartFlow, type CartFlowResult } from "./cart-flow.js";
import { runIngredientsAgent, type RecipeDocument } from "./ingredients-agent.js";
import { enterRecipes } from "./recipe-entry.js";
import { reviewShoppingList } from "./shopping-list-review.js";
import {
  createPlaywrightCartPageAdapter,
  inspectCartState,
  type CartInspectionResult,
} from "./cart-state.js";
import { acquireRunLock, type RunLock } from "./lock.js";
import { guardShoppingNavigation } from "./wfm-navigation.js";
import { addCandidate, searchProducts, type QuantityOption } from "./wfm-page.js";
import {
  buildCartReport,
  buildFailedCartReport,
  completeCartItemResults,
} from "./report-builder.js";
import {
  assertAttachmentReportSafe,
  assertAuthReportReady,
  assertAuthReportSafe,
  assertReportMatchesShoppingList,
  assertReportPreflight,
  loadShoppingList,
  parseAttachmentReport,
  parseAuthReport,
} from "./validation.js";
import type {
  AttachmentReport,
  AuthReport,
  CartItemResult,
  CartItemSnapshot,
  OwnedChromeSession,
  RunPaths,
  ShoppingList,
} from "./types.js";
import { writeUsageSummary } from "./usage.js";

type CommandKind = RunPaths["kind"];

interface CliDependencies {
  rootDir?: string;
  env?: NodeJS.ProcessEnv;
  runIngredients?: typeof runIngredientsAgent;
  enterRecipes?: typeof enterRecipes;
  reviewShoppingList?: typeof reviewShoppingList;
  inspectCart?: (
    session: OwnedChromeSession,
  ) => Promise<CartInspectionResult>;
  runCartItems?: (input: {
    tasks: ReturnType<typeof cartTasks>;
    baseline: CartInspectionResult;
    runDir: string;
    signal?: AbortSignal;
  }) => Promise<CartFlowResult>;
  signal?: AbortSignal;
  secureReport?: (path: string) => void;
  launchBrowser?: (input: LaunchChromeInput) => Promise<OwnedChromeSession>;
  reservePort?: () => Promise<number>;
  runDeterministicCheck?: (
    kind: "auth-check" | "attachment-check",
    session: OwnedChromeSession,
    expectation?: DeliveryContextExpectation,
  ) => Promise<AuthReport | AttachmentReport>;
  releaseLock?: (lock: RunLock) => void;
}

export interface SignalHandlerOptions {
  processObject?: NodeJS.Process;
  signals?: NodeJS.Signals[];
  controller?: AbortController;
}

const USAGE = `usage: cart build <shopping-list.json> [--model <model>] [--effort <effort>]
       cart shopper-helper [recipe-file ...] [--model <model>] [--effort <effort>]
       cart ingredients-review <shopping-list.json> [--output <reviewed-list.json>]
       cart ingredients <recipe-file> [recipe-file ...]
       cart auth-check
       cart attachment-check`;

const WHOLE_FOODS_URL = "https://www.wholefoodsmarket.com/grocery/search";
const WHOLE_FOODS_CART_URL = "https://www.wholefoodsmarket.com/grocery/cart";
const EXAMPLE_URL = "https://example.com";
const DECISION_SCHEMA_PATH = "schemas/cart-decision.schema.json";
const INGREDIENTS_AGENT_SCHEMA_PATH = "schemas/ingredients-agent-output.schema.json";

const inspectOwnedCart = async (
  session: OwnedChromeSession,
): Promise<CartInspectionResult> => {
  if (session.remoteDebuggingPort === undefined) {
    throw new Error("Chrome was not launched with a debugging port");
  }
  const browser = await connectToOwnedChrome(session.remoteDebuggingPort);
  try {
    const context = browser.contexts()[0];
    if (!context) throw new Error("Chrome exposed no browser context");
    const page = context.pages().find((candidate) =>
      isWholeFoodsPage(candidate.url()),
    );
    if (!page) throw new Error("Chrome exposed no Whole Foods browser page");
    return await inspectCartState(createPlaywrightCartPageAdapter(page), {
      cartUrl: WHOLE_FOODS_CART_URL,
    });
  } finally {
    await browser.close().catch(() => undefined);
  }
};

const inspectionFromNetworkSnapshot = (
  snapshot: CartNetworkSnapshot,
  baselineItems: CartInspectionResult["items"],
  results: readonly CartItemResult[],
): CartInspectionResult | null => {
  const names = new Map<string, string>();
  for (const item of baselineItems) {
    if (item.productId) names.set(item.productId.toUpperCase(), item.productName);
  }
  for (const result of results) {
    if (result.productId && result.productName) {
      names.set(result.productId.toUpperCase(), result.productName);
    }
  }
  const items = snapshot.items.map(({ asin, quantity }) => {
    const productName = names.get(asin.toUpperCase());
    return productName ? { productName, productId: asin, quantity } : null;
  });
  if (items.some((item) => item === null)) return null;
  const verifiedItems = items.filter((item): item is NonNullable<typeof item> => item !== null);
  return {
    items: verifiedItems,
    totalItemCount: verifiedItems.reduce((count, item) => count + item.quantity, 0),
    url: snapshot.url,
    bodyText: "Cart verified from successful full-cart network response.",
    extractionStatus: "complete",
    extractionDiagnostic: null,
  };
};

/**
 * Install SIGINT/SIGTERM handlers only for the real CLI entrypoint lifetime.
 * Handlers abort the controller and are always removed in `finally`.
 */
export async function withCliSignalHandlers<T>(
  run: (signal: AbortSignal) => Promise<T>,
  options: SignalHandlerOptions = {},
): Promise<T> {
  const processObject = options.processObject ?? process;
  const signals = options.signals ?? ["SIGINT", "SIGTERM"];
  const controller = options.controller ?? new AbortController();

  const onSignal = (): void => {
    if (!controller.signal.aborted) controller.abort();
  };

  for (const signal of signals) {
    processObject.on(signal, onSignal);
  }
  try {
    return await run(controller.signal);
  } finally {
    for (const signal of signals) {
      processObject.off(signal, onSignal);
    }
  }
}

export const parseCommand = (
  argv: string[],
): {
  command: CommandKind;
  shoppingListPath?: string;
  outputPath?: string;
  recipePaths?: string[];
  cartDecisionModel?: string;
  cartDecisionReasoningEffort?: ReasoningEffort;
} | null => {
  const command = argv[0];
  if (command === "build" || command === "shopper-helper" || command === "ingredients") {
    const paths: string[] = [];
    let cartDecisionModel: string | undefined;
    let cartDecisionReasoningEffort: ReasoningEffort | undefined;
    for (let index = 1; index < argv.length; index += 1) {
      const argument = argv[index]!;
      if (argument === "--model") {
        const value = argv[index + 1];
        if (!value || value.startsWith("--") || cartDecisionModel) return null;
        cartDecisionModel = value;
        index += 1;
      } else if (argument === "--effort") {
        const value = argv[index + 1];
        if (
          !value ||
          !REASONING_EFFORTS.includes(value as ReasoningEffort) ||
          cartDecisionReasoningEffort
        ) return null;
        cartDecisionReasoningEffort = value as ReasoningEffort;
        index += 1;
      } else if (argument.startsWith("--")) {
        return null;
      } else {
        paths.push(argument);
      }
    }
    const settings = {
      ...(cartDecisionModel ? { cartDecisionModel } : {}),
      ...(cartDecisionReasoningEffort ? { cartDecisionReasoningEffort } : {}),
    };
    if (command === "build" && paths.length === 1) {
      return { command, shoppingListPath: paths[0]!, ...settings };
    }
    if (command === "shopper-helper") {
      return { command, recipePaths: paths, ...settings };
    }
    if (command === "ingredients" && paths.length >= 1 && Object.keys(settings).length === 0) {
      return { command, recipePaths: paths };
    }
    return null;
  }
  if (command === "ingredients-review") {
    let input: string | undefined;
    let outputPath: string | undefined;
    for (let index = 1; index < argv.length; index += 1) {
      const argument = argv[index]!;
      if (argument === "--output") {
        const value = argv[index + 1];
        if (!value || value.startsWith("--") || outputPath) return null;
        outputPath = value;
        index += 1;
      } else if (argument.startsWith("--") || input) return null;
      else input = argument;
    }
    if (input) return { command, shoppingListPath: input, ...(outputPath ? { outputPath } : {}) };
    return null;
  }
  if (argv[0] === "auth-check" && argv.length === 1) {
    return { command: "auth-check" };
  }
  if (argv[0] === "attachment-check" && argv.length === 1) {
    return { command: "attachment-check" };
  }
  return null;
};

const assertExecutable = (path: string, label: string): void => {
  try {
    accessSync(path, constants.X_OK);
  } catch {
    throw new Error(`${label} is missing or not executable: ${path}`);
  }
};

export async function runCli(
  argv: string[],
  dependencies: CliDependencies = {},
): Promise<number> {
  const runStartedAt = new Date();
  const parsed = parseCommand(argv);
  if (!parsed) {
    console.error(USAGE);
    return 2;
  }
  const command = parsed.command;
  const cartDecisionModel = parsed.cartDecisionModel ?? DECISION_MODEL;
  const cartDecisionReasoningEffort =
    parsed.cartDecisionReasoningEffort ?? DECISION_REASONING_EFFORT;

  const rootDir = resolve(dependencies.rootDir ?? process.cwd());
  const secure =
    dependencies.secureReport ?? ((path: string) => secureReport(path));
  const launchBrowser = dependencies.launchBrowser ?? launchOwnedChrome;
  const releaseLock =
    dependencies.releaseLock ?? ((lock: RunLock) => lock.release());

  let lock: RunLock | undefined;
  let browser: OwnedChromeSession | undefined;
  let browserConnection: Browser | undefined;
  let shoppingPage: Page | undefined;
  let cartNetworkObserver: CartNetworkObserver | undefined;
  let removeNavigationGuard: (() => Promise<void>) | undefined;
  let blockedNavigation: string | null = null;
  let paths: RunPaths | undefined;
  let exitCode = 2;
  let lockAcquired = false;
  let retainLock = false;
  let leaveBrowserOpen = false;
  let cleanupFailed = false;
  let invocationAttempted = false;
  let cleanupPromise: Promise<number> | undefined;
  const lockPath = join(rootDir, ".wfm-cart.lock");
  let interactiveRecipeDocuments: RecipeDocument[] | undefined;
  let progressTimer: ReturnType<typeof setInterval> | undefined;
  let currentStage = "";
  let stageStartedAt = Date.now();
  const pauseProgress = (): void => {
    if (progressTimer) clearInterval(progressTimer);
    progressTimer = undefined;
  };
  const status = (stage: string): void => {
    currentStage = Array.from(stage).filter((character) => {
      const code = character.codePointAt(0)!;
      return code >= 32 && code !== 127 && (code < 128 || code > 159);
    }).join("");
    stageStartedAt = Date.now();
    console.log(`[progress] ${currentStage}`);
    if (!progressTimer) {
      progressTimer = setInterval(() => {
        const seconds = Math.floor((Date.now() - stageStartedAt) / 1000);
        console.log(`[progress] Still working: ${currentStage} (${seconds}s in this step)`);
      }, 15_000);
      progressTimer.unref();
    }
  };

  /** Single-entry cleanup: concurrent/repeated calls share one promise. */
  const finish = (): Promise<number> => {
    if (!cleanupPromise) {
      cleanupPromise = runCleanup();
    }
    return cleanupPromise;
  };

  async function runCleanup(): Promise<number> {
    pauseProgress();
    // Codex/invoke must have settled (or never started) before browser stop.
    if (lockAcquired && lock) {
      const heldLock = lock;
      try {
        cartNetworkObserver?.dispose();
        if (removeNavigationGuard) await removeNavigationGuard().catch(() => undefined);
        if (browserConnection) await browserConnection.close().catch(() => undefined);
        if (invocationAttempted && paths) {
          try {
            secure(paths.reportPath);
          } catch (error) {
            cleanupFailed = true;
            console.error(
              error instanceof Error ? error.message : String(error),
            );
          }
        }
        if (
          paths &&
          (command === "build" || command === "shopper-helper" || command === "ingredients")
        ) {
          try {
            const timingPath = join(paths.runDir, "timings.json");
            const itemTiming = (() => {
              try {
                return JSON.parse(readFileSync(timingPath, "utf8")) as Record<string, unknown>;
              } catch {
                return { items: [], totalItemMs: 0 };
              }
            })();
            const completedAt = new Date();
            writeFileSync(timingPath, `${JSON.stringify({
              ...itemTiming,
              startedAt: runStartedAt.toISOString(),
              completedAt: completedAt.toISOString(),
              wallMs: completedAt.getTime() - runStartedAt.getTime(),
            }, null, 2)}\n`, { mode: 0o600 });
            writeUsageSummary(paths.runDir);
          } catch (error) {
            console.warn(
              `Could not write timing or usage summary: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        if (browser && !leaveBrowserOpen) {
          try {
            const stopped = await browser.stop();
            if (!stopped.stopped) {
              retainLock = true;
              cleanupFailed = true;
              console.error(
                `Chrome still uses the dedicated profile (PIDs: ${stopped.remainingProfilePids.join(", ")}). Confirm those processes are gone, then manually remove ${lockPath}.`,
              );
            }
          } catch (error) {
            // Thrown stop => uncertain browser state: never release the lock.
            retainLock = true;
            cleanupFailed = true;
            console.error(
              error instanceof Error
                ? `Chrome stop failed: ${error.message}. Confirm dedicated-profile Chrome is gone, then manually remove ${lockPath}.`
                : `Chrome stop failed. Confirm dedicated-profile Chrome is gone, then manually remove ${lockPath}.`,
            );
          }
        }
      } finally {
        if (!retainLock) {
          releaseLock(heldLock);
        } else {
          heldLock.retain();
        }
      }
      if (cleanupFailed) exitCode = 2;
    }
    return exitCode;
  }

  try {
    if (parsed.command === "shopper-helper" && parsed.recipePaths?.length === 0) {
      interactiveRecipeDocuments = await (dependencies.enterRecipes ?? enterRecipes)({
        ...(dependencies.signal ? { signal: dependencies.signal } : {}),
      }) ?? undefined;
      if (!interactiveRecipeDocuments?.length || dependencies.signal?.aborted) {
        console.log(dependencies.signal?.aborted
          ? "Recipe entry cancelled."
          : "Recipe entry cancelled; no ingredients run was started.");
        exitCode = dependencies.signal?.aborted ? 1 : 0;
        return exitCode;
      }
    }
    const config = loadConfig(dependencies.env ?? process.env, rootDir);
    if (parsed.command === "ingredients-review") {
      const inputPath = resolve(parsed.shoppingListPath!);
      const list = loadShoppingList(inputPath);
      if (!dependencies.reviewShoppingList && (!process.stdin.isTTY || !process.stdout.isTTY)) {
        throw new Error("Shopping list review requires an interactive terminal");
      }
      const selectedIds = await (dependencies.reviewShoppingList ?? reviewShoppingList)(list, {
        ...(dependencies.signal ? { signal: dependencies.signal } : {}),
        continueLabel: "Save reviewed list",
      });
      if (selectedIds === null || dependencies.signal?.aborted) {
        console.log("Shopping list review cancelled; no output was written.");
        exitCode = dependencies.signal?.aborted ? 1 : 0;
        return await finish();
      }
      const allIngredients = list.ingredients ?? list.recipes.flatMap((recipe) => recipe.ingredients);
      const selectedIngredients = allIngredients.filter(({ id }) => selectedIds.has(id));
      if (selectedIngredients.length === 0) {
        console.log("No items selected; no cart-ready output was written.");
        exitCode = 0;
        return await finish();
      }
      const reviewed: ShoppingList = list.ingredients
        ? {
            ...(list.sourceRecipes ? { sourceRecipes: list.sourceRecipes } : {}),
            ingredients: selectedIngredients,
          }
        : {
            ...(list.sourceRecipes ? { sourceRecipes: list.sourceRecipes } : {}),
            recipes: list.recipes
              .map((recipe) => ({
                ...recipe,
                ingredients: recipe.ingredients.filter(({ id }) => selectedIds.has(id)),
              }))
              .filter((recipe) => recipe.ingredients.length > 0),
          };
      const timestamp = new Date().toISOString().replaceAll(":", "-").replace(".", "-");
      const outputPath = resolve(parsed.outputPath ?? join(rootDir, "runs", timestamp, "reviewed-shopping-list.json"));
      if (outputPath === inputPath) throw new Error("Reviewed output path must differ from the input path");
      mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
      writeFileSync(outputPath, `${JSON.stringify(reviewed, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      loadShoppingList(outputPath);
      console.log(`Reviewed shopping list: ${outputPath}`);
      exitCode = 0;
      return await finish();
    }
    const isCartBuild = parsed.command === "build" || parsed.command === "shopper-helper";
    const isRecipeCompilation = parsed.command === "shopper-helper" || parsed.command === "ingredients";
    if (isCartBuild || parsed.command === "auth-check" || parsed.command === "attachment-check") {
      assertExecutable(config.chromeExecutable, "Chrome executable");
    }

    let request: ShoppingList | undefined;
    let recipeDocuments: RecipeDocument[] | undefined;
    let requestSource: string | undefined;
    if (parsed.command === "build") {
      requestSource = resolve(parsed.shoppingListPath!);
      request = loadShoppingList(requestSource);
    } else if (isRecipeCompilation) {
      if (interactiveRecipeDocuments) {
        recipeDocuments = interactiveRecipeDocuments;
        requestSource = recipeDocuments.map(({ sourceName }) => sourceName).join(",");
      } else {
        const sources = parsed.recipePaths!.map((path) => resolve(path));
        recipeDocuments = sources.map((path) => ({
          sourceName: basename(path),
          text: readFileSync(path, "utf8"),
        }));
        requestSource = sources.map((path) => basename(path)).join(",");
      }
      const duplicateNames = recipeDocuments
        .map(({ sourceName }) => sourceName)
        .filter((name, index, names) => names.indexOf(name) !== index);
      if (duplicateNames.length > 0) {
        throw new Error(`Recipe filenames must be unique: ${[...new Set(duplicateNames)].join(", ")}`);
      }
    }
    let requestSha256 = isCartBuild || isRecipeCompilation
      ? sha256(canonicalShoppingList(request ?? recipeDocuments))
      : sha256(parsed.command);

    lock = acquireRunLock(lockPath, { profileDir: config.profileDir });
    lockAcquired = true;

    paths = createRunPaths(rootDir, new Date(), parsed.command);
    if (isCartBuild || isRecipeCompilation) {
      if (parsed.command === "build") {
        writeShoppingListSnapshot(requestSource!, paths.shoppingListPath);
      }
      writeRunMetadata(paths, requestSource!, requestSha256, {
        model: cartDecisionModel,
        reasoningEffort: cartDecisionReasoningEffort,
        cartDecisionModel: cartDecisionModel,
        cartDecisionReasoningEffort: cartDecisionReasoningEffort,
        ...(isRecipeCompilation
          ? {
              ingredientsAgentModel: INGREDIENTS_AGENT_MODEL,
              ingredientsAgentReasoningEffort: INGREDIENTS_AGENT_REASONING_EFFORT,
            }
          : {}),
      });
    }

    if (isRecipeCompilation) {
      try {
        status(`Reading ${recipeDocuments!.length} recipe${recipeDocuments!.length === 1 ? "" : "s"} with the Ingredients Agent`);
        const ingredientsDir = join(paths.runDir, "ingredients-agent");
        mkdirSync(ingredientsDir, { recursive: true, mode: 0o700 });
        const runIngredients = dependencies.runIngredients ?? runIngredientsAgent;
        const compiled = await runIngredients({
          executable: config.codexBin,
          rootDir,
          schemaPath: join(rootDir, INGREDIENTS_AGENT_SCHEMA_PATH),
          outputPath: join(ingredientsDir, "output.json"),
          eventsPath: join(ingredientsDir, "codex-events.jsonl"),
          stderrPath: join(ingredientsDir, "codex-stderr.log"),
          timeoutMs: config.maxRunMs,
          documents: recipeDocuments!,
          ...(dependencies.signal ? { signal: dependencies.signal } : {}),
        });
        request = compiled.shoppingList;
        writeFileSync(paths.shoppingListPath, `${JSON.stringify(request, null, 2)}\n`, { mode: 0o600 });
        request = loadShoppingList(paths.shoppingListPath);
        writeFileSync(
          join(paths.runDir, "recipe-compilation.json"),
          `${JSON.stringify(compiled.recipeCompilation, null, 2)}\n`,
          { mode: 0o600 },
        );
        status(`Ingredients ready: ${request.ingredients?.length ?? 0} shopping-list items`);
        if (parsed.command === "shopper-helper") {
          pauseProgress();
          const selectedIds = await (dependencies.reviewShoppingList ?? reviewShoppingList)(request, {
            ...(dependencies.signal ? { signal: dependencies.signal } : {}),
          });
          if (selectedIds === null || dependencies.signal?.aborted) {
            console.log(`Shopping list review cancelled. Compilation saved in ${paths.runDir}`);
            exitCode = dependencies.signal?.aborted ? 1 : 0;
            return await finish();
          }
          const reviewed = {
            ...request,
            ingredients: request.ingredients!.filter(({ id }) => selectedIds.has(id)),
          };
          const reviewedPath = join(paths.runDir, "reviewed-shopping-list.json");
          writeFileSync(reviewedPath, `${JSON.stringify(reviewed, null, 2)}\n`, { mode: 0o600 });
          if (reviewed.ingredients.length === 0) {
            console.log(`No items selected. Reviewed list saved in ${reviewedPath}; cart was not started.`);
            exitCode = 0;
            return await finish();
          }
          request = loadShoppingList(reviewedPath);
          requestSha256 = sha256(canonicalShoppingList(request));
          const metadataPath = join(paths.runDir, "metadata.json");
          const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
          writeFileSync(metadataPath, `${JSON.stringify({
            ...metadata,
            recipeSourceSha256: metadata.requestSha256,
            requestSha256,
            reviewedShoppingList: basename(reviewedPath),
          }, null, 2)}\n`, { mode: 0o600 });
          status(`Starting cart with ${reviewed.ingredients.length} selected items`);
          console.log(`Reviewed list: ${reviewedPath}`);
        }
        if (parsed.command === "ingredients") {
          console.log(`Ingredients compilation: ${paths.runDir}`);
          console.log("\nShopping list:");
          for (const ingredient of request.ingredients ?? []) {
            const requirement = ingredient.purchaseRequirement!;
            const sourceIntent = compiled.recipeCompilation.purchaseIntents.find(({ id }) => id === ingredient.id)!;
            console.log(`- ${ingredient.request}${requirement.optional ? " (optional)" : ""}`);
            const { quantity, approximate } = requirement.total;
            const packageAmount = sourceIntent.sourceAmounts.length === 1
              ? sourceIntent.sourceAmounts[0]?.raw.match(/^\d+\s*[×x]\s*.+\bcans?$/i)?.[0]
              : undefined;
            let unit = requirement.total.unit;
            if (!packageAmount && quantity !== 1) {
              const plurals: Record<string, string> = {
                clove: "cloves", lemon: "lemons", onion: "onions", pita: "pitas",
                tomato: "tomatoes", cucumber: "cucumbers", can: "cans",
                package: "packages", bunch: "bunches", loaf: "loaves", bulb: "bulbs",
              };
              unit = unit.replace(/\b(clove|lemon|onion|pita|tomato|cucumber|can|package|bunch|loaf|bulb)$/i,
                (noun) => plurals[noun.toLowerCase()] ?? noun);
            }
            console.log(`  Total: ${approximate ? "about " : ""}${packageAmount ?? `${quantity} ${unit}`}`);
            for (const source of sourceIntent.sourceLines) {
              console.log(`  ${source.sourceName}: ${source.sourceText}`);
            }
            for (const alternative of requirement.alternatives) {
              console.log(`  Alternative: ${alternative.name} — ${alternative.guidance}`);
            }
          }
          exitCode = 0;
          return await finish();
        }
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        exitCode = 1;
        return await finish();
      }
    }

    status(isCartBuild ? "Launching Chrome for the cart run" : "Launching Chrome for the diagnostic check");
    try {
      const remoteDebuggingPort =
        await (dependencies.reservePort ?? reserveLocalPort)();
      browser = await launchBrowser({
        executable: config.chromeExecutable,
        profileDir: config.profileDir,
        startupTimeoutMs: config.chromeStartupTimeoutMs,
        stopTimeoutMs: config.chromeStopTimeoutMs,
        launchUrl:
          parsed.command === "attachment-check"
            ? EXAMPLE_URL
            : WHOLE_FOODS_URL,
        ...(remoteDebuggingPort === undefined ? {} : { remoteDebuggingPort }),
      });
    } catch (error) {
      if (error instanceof BrowserLaunchError) {
        retainLock = error.requiresLockRetention;
      } else {
        // Unknown launch failures retain conservatively.
        retainLock = true;
      }
      console.error(error instanceof Error ? error.message : String(error));
      exitCode = 2;
      // Fall through to cleanup; do not run Codex.
      return await finish();
    }

    const signal = dependencies.signal;
    if (signal?.aborted) {
      if (isCartBuild) {
        const abortedPreflight: AuthReport = {
          runStatus: "failed",
          authenticated: false,
          deliveryModeConfirmed: false,
          wholeFoodsStorefrontConfirmed: false,
          checkoutVisited: false,
          settingsChanged: false,
          failureReason: "Cart run aborted before deterministic preflight",
        };
        invocationAttempted = true;
        const report = buildFailedCartReport({
          request: request!,
          requestSha256,
          preflight: abortedPreflight,
          failureReason: abortedPreflight.failureReason!,
        });
        writeFileSync(paths.reportPath, `${JSON.stringify(report)}\n`, {
          mode: 0o600,
        });
      }
      console.error(
        parsed.command === "build"
          ? "Cart run aborted before Codex started"
          : `${parsed.command} aborted before Codex started`,
      );
      exitCode = 1;
      return await finish();
    }

    if (!isCartBuild) {
      try {
        const check = dependencies.runDeterministicCheck ?? runDeterministicCheck;
        const diagnosticCommand = parsed.command as "auth-check" | "attachment-check";
        const report = await check(diagnosticCommand, browser, {
          deliveryMode: config.deliveryMode,
        });
        writeFileSync(paths.reportPath, `${JSON.stringify(report)}\n`, {
          mode: 0o600,
        });
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        exitCode = 2;
        return await finish();
      }

      try {
        if (parsed.command === "auth-check") {
          const report = parseAuthReport(readFileSync(paths.reportPath, "utf8"));
          assertAuthReportSafe(report);
          try {
            assertAuthReportReady(report);
          } catch (error) {
            leaveBrowserOpen = true;
            const reason = error instanceof Error ? error.message : String(error);
            console.error(reason);
            console.error(
              "Dedicated Chrome left open so you can sign in or correct the delivery context. Close it before retrying.",
            );
            exitCode = 1;
            return await finish();
          }
          console.log(`Auth check ${report.runStatus}: ${paths.reportPath}`);
          exitCode = report.runStatus === "failed" ? 1 : 0;
        } else {
          const report = parseAttachmentReport(
            readFileSync(paths.reportPath, "utf8"),
          );
          assertAttachmentReportSafe(report);
          console.log(`Attachment check connected: ${paths.reportPath}`);
          exitCode = 0;
        }
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        exitCode = 1;
      }
      return await finish();
    }

    const requestValue = request!;
    const check = dependencies.runDeterministicCheck ?? runDeterministicCheck;
    const inspect = dependencies.inspectCart ?? inspectOwnedCart;
    status("Checking Whole Foods sign-in and delivery context");
    const preflight = (await check("auth-check", browser, {
      deliveryMode: config.deliveryMode,
    })) as AuthReport;
    const readinessReady =
      preflight.runStatus === "completed" &&
      preflight.authenticated &&
      preflight.deliveryModeConfirmed &&
      preflight.wholeFoodsStorefrontConfirmed;
    const safetyReady =
      !preflight.checkoutVisited && !preflight.settingsChanged;

    invocationAttempted = true;
    if (!readinessReady || !safetyReady) {
      const report = buildFailedCartReport({
        request: requestValue,
        requestSha256,
        preflight,
        failureReason:
          preflight.failureReason ??
          "Deterministic preflight did not confirm the Whole Foods delivery context",
      });
      writeFileSync(paths.reportPath, `${JSON.stringify(report)}\n`, {
        mode: 0o600,
      });
      if (!safetyReady) {
        console.error(
          `Cart safety check failed: checkoutVisited=${preflight.checkoutVisited}, settingsChanged=${preflight.settingsChanged}. Inspect ${paths.runDir}`,
        );
      } else {
        leaveBrowserOpen = true;
        console.error(
          `Cart readiness check failed: ${preflight.failureReason ?? "the storefront is not ready for a cart run"}`,
        );
        console.error(
          `Dedicated Chrome left open so you can sign in or correct the delivery context. Close it before retrying. Report: ${paths.reportPath}`,
        );
      }
      exitCode = 1;
      return await finish();
    }

    let baseline: CartInspectionResult;
    try {
      status("Inspecting the current cart");
      baseline = await inspect(browser);
    } catch (error) {
      leaveBrowserOpen = true;
      const report = buildFailedCartReport({
        request: requestValue,
        requestSha256,
        preflight,
        failureReason: `Could not inspect the baseline cart: ${error instanceof Error ? error.message : String(error)}`,
      });
      writeFileSync(paths.reportPath, `${JSON.stringify(report)}\n`, {
        mode: 0o600,
      });
      console.error(`Cart baseline inspection failed; inspect ${paths.runDir}`);
      console.error(
        "Dedicated Chrome left open so you can inspect the failed run. Close it before retrying.",
      );
      exitCode = 1;
      return await finish();
    }

    if (baseline.extractionStatus === "degraded") {
      leaveBrowserOpen = true;
      const reason = `Baseline cart extraction was degraded${baseline.extractionDiagnostic ? `: ${baseline.extractionDiagnostic}` : ""}`;
      const report = buildFailedCartReport({
        request: requestValue,
        requestSha256,
        preflight,
        failureReason: reason,
      });
      writeFileSync(paths.reportPath, `${JSON.stringify(report)}\n`, {
        mode: 0o600,
      });
      console.error(`Cart baseline verification failed; inspect ${paths.runDir}`);
      console.error(
        "Dedicated Chrome left open so you can inspect the failed run. Close it before retrying.",
      );
      exitCode = 1;
      return await finish();
    }

    const tasks = cartTasks(requestValue);
    status(`Processing ${tasks.length} shopping-list items`);
    let latestNetworkSnapshot: CartNetworkSnapshot | null = null;
    let networkDiagnostic: string | null = null;
    let flow: CartFlowResult;
    try {
      if (dependencies.runCartItems) {
        flow = await dependencies.runCartItems({ tasks, baseline, runDir: paths.runDir, ...(signal ? { signal } : {}) });
      } else {
        if (browser?.remoteDebuggingPort === undefined) throw new Error("Owned Chrome did not expose a remote debugging port");
        browserConnection = await connectToOwnedChrome(browser.remoteDebuggingPort);
        const context = browserConnection.contexts()[0];
        if (!context) throw new Error("Chrome exposed no browser context");
        shoppingPage = context.pages().find((page) => isWholeFoodsPage(page.url())) ?? context.pages()[0];
        if (!shoppingPage) throw new Error("Chrome exposed no browser page");
        removeNavigationGuard = await guardShoppingNavigation(context, (url) => { blockedNavigation = url; });
        cartNetworkObserver = new CartNetworkObserver(shoppingPage);
        const decisionAttempts = new Map<string, number>();
        let networkDiagnosticCount = 0;
        const decide = async (task: ReturnType<typeof cartTasks>[number], candidates: Awaited<ReturnType<typeof searchProducts>>, cart: readonly CartItemSnapshot[], quantityOptions?: readonly QuantityOption[], selectedPackSize?: string | null) => {
          status(`Choosing a product for ${task.ingredient.request}`);
          const itemDir = join(paths!.runDir, "cart-decision", task.ingredient.id);
          mkdirSync(itemDir, { recursive: true, mode: 0o700 });
          const attempt = (decisionAttempts.get(task.ingredient.id) ?? 0) + 1;
          decisionAttempts.set(task.ingredient.id, attempt);
          const outputPath = join(itemDir, `decision-${attempt}.json`);
          const invocation = buildDecisionInvocation({ rootDir, outputPath, schemaPath: join(rootDir, DECISION_SCHEMA_PATH), model: cartDecisionModel, reasoningEffort: cartDecisionReasoningEffort });
          const result = await runCodex({ executable: config.codexBin, args: invocation.args, prompt: renderDecisionPrompt({ task: { ingredientId: task.ingredient.id, requested: task.ingredient.request, ...(task.ingredient.preferences ? { preferences: task.ingredient.preferences } : {}), context: task.ingredient.context ?? null, ...(task.ingredient.purchaseRequirement ? { purchaseRequirement: task.ingredient.purchaseRequirement } : {}) }, recipeContext: task.recipeContext, candidates, currentCart: cart, ...(quantityOptions ? { quantityOptions, selectedPackSize: selectedPackSize ?? null } : {}) }), eventsPath: join(itemDir, `codex-events-${attempt}.jsonl`), stderrPath: join(itemDir, `codex-stderr-${attempt}.log`), timeoutMs: config.maxRunMs, ...(signal ? { signal } : {}) });
          if (result.exitCode !== 0 || result.timedOut) throw new Error("Cart decision Codex invocation failed");
          return parseAndValidateDecision(readFileSync(outputPath, "utf8"), candidates, cart);
        };
        flow = await runCartFlow({
          tasks,
          baseline: baseline.items,
          search: async (query) => {
            status(`Searching Whole Foods for ${query}`);
            if (blockedNavigation) throw new CartRunFatalError(`Blocked shopping navigation: ${blockedNavigation}`);
            return searchProducts(shoppingPage!, query);
          },
          decide,
          add: async (task, candidate, quantity, option, before, cart, recordAdditionalDecision) => {
            status(`Adding and verifying ${task.ingredient.request}`);
            await cartNetworkObserver!.beginMutation(before);
            let clickError: unknown;
            let selectedQuantity = quantity;
            let weighted = false;
            let weightedReason: string | null = null;
            try {
              const added = await addCandidate(shoppingPage!, candidate, quantity, option ?? undefined, async (quantityOptions, selectedPackSize) => {
                const itemDir = join(paths!.runDir, "cart-decision", task.ingredient.id);
                const computed = quantityFromSelectedPackSize(task.ingredient.purchaseRequirement?.total, selectedPackSize, quantityOptions);
                writeFileSync(join(itemDir, `quantity-evidence-${decisionAttempts.get(task.ingredient.id) ?? 0}.json`), `${JSON.stringify({ candidateId: candidate.id, selectedPackSize, quantityOptions, computedQuantity: computed }, null, 2)}\n`, { mode: 0o600 });
                if (computed !== null) {
                  selectedQuantity = computed;
                  weightedReason = `${computed} × ${selectedPackSize} covers ${task.ingredient.purchaseRequirement!.total.quantity} ${task.ingredient.purchaseRequirement!.total.unit}.`;
                  weighted = true;
                  return computed;
                }
                const started = Date.now();
                let choice;
                try {
                  choice = await decide(task, [candidate], cart, quantityOptions, selectedPackSize);
                } finally {
                  recordAdditionalDecision(Date.now() - started);
                }
                if (choice.action !== "select" || choice.candidateId.toUpperCase() !== candidate.id.toUpperCase()) {
                  throw new Error("Weighted quantity decision did not select the current candidate");
                }
                weightedReason = choice.reason;
                selectedQuantity = choice.quantity;
                weighted = true;
                return choice.quantity;
              });
              selectedQuantity = added.quantity;
              weighted = added.weighted;
            } catch (error) {
              clickError = error;
            }
            const outcome = await cartNetworkObserver!.waitForMutation({
              asin: candidate.id,
              expectedQuantity: weighted || selectedQuantity === 1 ? "positive" : selectedQuantity,
            });
            if (blockedNavigation) throw new Error(`Blocked shopping navigation: ${blockedNavigation}`);
            if (outcome.status === "confirmed") return { snapshot: outcome.snapshot, quantity: selectedQuantity, reason: weightedReason };
            networkDiagnosticCount += 1;
            writeFileSync(
              join(paths!.runDir, `cart-network-diagnostic-${networkDiagnosticCount}.json`),
              `${JSON.stringify(outcome, null, 2)}\n`,
              { mode: 0o600 },
            );
            if (outcome.status === "rejected" || outcome.status === "no_mutation") {
              throw new CartNoMutationError(outcome.diagnostic, outcome.snapshot);
            }
            if (clickError) {
              throw new Error(`${clickError instanceof Error ? clickError.message : String(clickError)}; ${outcome.diagnostic}`, { cause: clickError });
            }
            throw new Error(outcome.diagnostic);
          },
          ...(signal ? { signal } : {}),
          onProgress: async (current) => {
            writeFileSync(join(paths!.runDir, "progress.json"), `${JSON.stringify(current)}\n`, { mode: 0o600 });
            const latest = current.results.at(-1);
            if (latest) status(`${current.completed}/${current.total} items finished: ${latest.requested} (${latest.status})`);
          },
        });
      }
    } catch (error) {
      flow = { total: tasks.length, completed: 0, results: [], timings: [], stopped: true, stopReason: error instanceof Error ? error.message : String(error), latestSnapshot: null, failure: null };
      leaveBrowserOpen = true;
      writeFileSync(join(paths.runDir, "cart-decision-diagnostic.json"), `${JSON.stringify({ stage: "setup", reason: flow.stopReason, blockedNavigation })}\n`, { mode: 0o600 });
    }
    if (blockedNavigation) {
      flow = { ...flow, stopped: true, stopReason: `Blocked shopping navigation: ${blockedNavigation}` };
      leaveBrowserOpen = true;
      if (!flow.failure) {
        writeFileSync(
          join(paths.runDir, "cart-decision-diagnostic.json"),
          `${JSON.stringify({ stage: "navigation", reason: flow.stopReason, blockedNavigation, pageUrl: shoppingPage?.url() ?? null })}\n`,
          { mode: 0o600 },
        );
      }
    }
    writeFileSync(join(paths.runDir, "progress.json"), `${JSON.stringify(flow)}\n`, { mode: 0o600 });
    writeFileSync(join(paths.runDir, "timings.json"), `${JSON.stringify({ items: flow.timings, totalItemMs: flow.timings.reduce((sum, item) => sum + item.totalMs, 0) }, null, 2)}\n`, { mode: 0o600 });
    latestNetworkSnapshot = flow.latestSnapshot;
    if (flow.failure) {
      if (flow.failure.mayHaveCommitted) leaveBrowserOpen = true;
      const pageUrl = shoppingPage?.url() ?? null;
      const pageText = shoppingPage
        ? await shoppingPage.locator("body").innerText().catch(() => null)
        : null;
      writeFileSync(
        join(paths.runDir, "cart-decision-diagnostic.json"),
        `${JSON.stringify({ ...flow.failure, latestSnapshot: flow.latestSnapshot, pageUrl, pageText })}\n`,
        { mode: 0o600 },
      );
    }
    const reconciledResults = [...flow.results];
    const progress = { stopped: flow.stopped, stopReason: flow.stopReason, results: flow.results.map((result, index) => ({ task: tasks[index]!, result })) };
    if (blockedNavigation) networkDiagnostic = `Blocked navigation outside Whole Foods: ${blockedNavigation}`;
    let final: CartInspectionResult;
    let finalInspectionFailure: string | null = null;
    const networkFinal = latestNetworkSnapshot
      ? inspectionFromNetworkSnapshot(latestNetworkSnapshot, baseline.items, reconciledResults)
      : null;
    if (networkFinal) {
      final = networkFinal;
      console.log("Final cart verification used a reconciled full-cart network POST snapshot.");
    } else try {
      final = await inspect(browser);
      console.log(
        "Final cart verification used the cart-page fallback; baseline cart-page navigation remains required because the cartcache GET has not been established as a complete baseline source.",
      );
      if (networkDiagnostic) {
        finalInspectionFailure = `Network verification fell back to the cart page: ${networkDiagnostic}`;
      }
    } catch (error) {
      final = {
        ...baseline,
        bodyText: "",
      };
      finalInspectionFailure = [
        networkDiagnostic ? `Network verification fell back: ${networkDiagnostic}` : null,
        `Could not inspect the final cart: ${error instanceof Error ? error.message : String(error)}`,
      ].filter(Boolean).join(" ");
    }

    const resultReason = progress.stopReason
      ? `The cart run stopped before this item: ${progress.stopReason}`
      : "The cart run did not complete";
    const results = completeCartItemResults(
      requestValue,
      progress.results.map(({ result }) => result),
      resultReason,
    );
    const report = buildCartReport({
      request: requestValue,
      requestSha256,
      preflight,
      baseline,
      final,
      results,
      stopped: progress.stopped,
      stopReason: progress.stopReason,
      ...(finalInspectionFailure
        ? { additionalVerificationNotes: [finalInspectionFailure] }
        : {}),
    });
    writeFileSync(paths.reportPath, `${JSON.stringify(report)}\n`, {
      mode: 0o600,
    });

    try {
      assertReportMatchesShoppingList(report, requestValue);
      if (report.requestSha256 !== requestSha256) {
        throw new Error("Report requestSha256 does not match the request");
      }
      assertReportPreflight(report);
      if (report.checkoutVisited || report.settingsChanged) {
        console.error(`Safety condition violated; inspect ${paths.runDir}`);
        exitCode = 1;
      } else {
        if (report.runStatus === "failed") {
          leaveBrowserOpen = true;
          console.error(
            `Cart run failed: ${report.failureReason ?? "unknown failure"}. Report: ${paths.reportPath}`,
          );
          console.error(
            "Dedicated Chrome left open so you can inspect the failed run. Close it before retrying.",
          );
        } else if (report.verificationStatus === "inconclusive") {
          leaveBrowserOpen = true;
          console.warn(
            `Cart run ${report.runStatus}, but final verification was inconclusive: ${report.verificationNotes?.join(" ") ?? "the final cart could not be fully reconciled"}. Report: ${paths.reportPath}`,
          );
          console.warn(
            "Dedicated Chrome left open so you can inspect the cart. Close it before another run.",
          );
        } else {
          console.log(`Cart run ${report.runStatus}: ${paths.reportPath}`);
        }
        exitCode = report.runStatus === "failed" ? 1 : 0;
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      exitCode = 2;
    }

    return await finish();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    exitCode = 2;
    return await finish();
  }
}

const isEntryPoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  // Signal handlers are installed only for the real CLI process lifetime.
  process.exitCode = await withCliSignalHandlers((signal) =>
    runCli(process.argv.slice(2), { signal }),
  );
}
