import { chromium, type Browser, type Page } from "playwright";
import type { AttachmentReport, AuthReport, OwnedChromeSession } from "./types.js";

const WHOLE_FOODS_HOST = "www.wholefoodsmarket.com";
const EXAMPLE_URL = "https://example.com/";
const EXAMPLE_TITLE = "Example Domain";
const CDP_CONNECT_TIMEOUT_MS = 15_000;
const CDP_RETRY_MS = 250;

const expectedPage = async (
  browser: Browser,
  expected: (url: string) => boolean,
): Promise<Page> => {
  const context = browser.contexts()[0];
  if (!context) throw new Error("Chrome exposed no browser context");
  const page = context.pages().find((candidate) => expected(candidate.url()));
  if (!page) throw new Error("Chrome exposed no browser page");
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  return page;
};

const pageText = async (page: Page): Promise<string> => {
  try {
    return await page.locator("body").innerText({ timeout: 10_000 });
  } catch {
    return "";
  }
};

export interface DeliveryContextExpectation {
  expectedAddressText: string;
  deliveryMode: "delivery";
}

const normalizeObservationText = (value: string): string =>
  value.replace(/\s+/g, " ").trim().toLocaleLowerCase();

export const hasDeliveryAddress = (
  text: string,
  expectedAddressText = "43214",
): boolean => {
  const expected = normalizeObservationText(expectedAddressText);
  return expected.length > 0 && normalizeObservationText(text).includes(expected);
};

export const hasDeliveryMode = (
  text: string,
  deliveryMode: "delivery" = "delivery",
): boolean =>
  deliveryMode === "delivery" &&
  /\bdeliver(?:y| to|ing)\b|\bdelivery address\b/i.test(text);

export const isSignedOutPage = (url: string, text: string): boolean =>
  /\/(?:ap\/)?signin(?:[/?]|$)/i.test(url) ||
  /sign in to your account|enter your password|create your amazon account|log in with amazon|log in to get started/i.test(text);

export const isWholeFoodsStorefront = (url: string, text: string): boolean => {
  try {
    const { hostname } = new URL(url);
    return (
      hostname === WHOLE_FOODS_HOST &&
      (/grocery\/search|whole.?foods/i.test(url) || /whole foods market/i.test(text))
    );
  } catch {
    return false;
  }
};

export const isWholeFoodsPage = (url: string): boolean => {
  try {
    return new URL(url).hostname === WHOLE_FOODS_HOST;
  } catch {
    return false;
  }
};

export const connectToOwnedChrome = async (port: number): Promise<Browser> => {
  const deadline = Date.now() + CDP_CONNECT_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
        timeout: 2_000,
      });
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, CDP_RETRY_MS));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Chrome debugging endpoint did not become ready");
};

const runAttachmentCheck = async (page: Page): Promise<AttachmentReport> => {
  const url = page.url();
  const title = await page.title().catch(() => "");
  const connected = url === EXAMPLE_URL && title === EXAMPLE_TITLE;
  return {
    connected,
    url: connected ? EXAMPLE_URL : null,
    title: connected ? EXAMPLE_TITLE : null,
    navigationPerformed: true,
    interactionPerformed: false,
    failureReason: connected ? null : "Deterministic check did not observe Example Domain",
  };
};

const failedReport = (
  kind: "auth-check" | "attachment-check",
): AuthReport | AttachmentReport =>
  kind === "attachment-check"
    ? {
        connected: false,
        url: null,
        title: null,
        navigationPerformed: true,
        interactionPerformed: false,
        failureReason: "Deterministic check could not observe Example Domain",
      }
    : {
        runStatus: "failed",
        authenticated: false,
        deliveryModeConfirmed: false,
        deliveryAddressConfirmed: false,
        wholeFoodsStorefrontConfirmed: false,
        checkoutVisited: false,
        settingsChanged: false,
        failureReason:
          "Deterministic preflight could not inspect the signed-in Whole Foods page",
      };

export const buildAuthReportFromObservation = (
  url: string,
  text: string,
  expectation: DeliveryContextExpectation = {
    expectedAddressText: "43214",
    deliveryMode: "delivery",
  },
): AuthReport => {
  const authenticated =
    !isSignedOutPage(url, text) &&
    /account|deliver to|whole foods/i.test(text);
  const deliveryAddressConfirmed = hasDeliveryAddress(
    text,
    expectation.expectedAddressText,
  );
  const deliveryModeConfirmed = hasDeliveryMode(text, expectation.deliveryMode);
  const wholeFoodsStorefrontConfirmed = isWholeFoodsStorefront(url, text);
  const completed =
    authenticated &&
    deliveryModeConfirmed &&
    deliveryAddressConfirmed &&
    wholeFoodsStorefrontConfirmed;
  return {
    runStatus: completed ? "completed" : "failed",
    authenticated,
    deliveryModeConfirmed,
    deliveryAddressConfirmed,
    wholeFoodsStorefrontConfirmed,
    checkoutVisited: false,
    settingsChanged: false,
    failureReason: completed
      ? null
      : "Deterministic preflight could not confirm the signed-in Whole Foods delivery context",
  };
};

const runAuthCheck = async (
  page: Page,
  expectation: DeliveryContextExpectation,
): Promise<AuthReport> =>
  buildAuthReportFromObservation(page.url(), await pageText(page), expectation);

export async function runDeterministicCheck(
  kind: "auth-check" | "attachment-check",
  session: OwnedChromeSession,
  expectation: DeliveryContextExpectation = {
    expectedAddressText: "43214",
    deliveryMode: "delivery",
  },
): Promise<AuthReport | AttachmentReport> {
  if (session.remoteDebuggingPort === undefined) {
    throw new Error("Chrome was not launched with a debugging port");
  }
  let browser: Browser | undefined;
  try {
    browser = await connectToOwnedChrome(session.remoteDebuggingPort);
    const page = await expectedPage(
      browser,
      kind === "attachment-check"
        ? (url) => url === EXAMPLE_URL
        : isWholeFoodsPage,
    );
    return kind === "attachment-check"
      ? await runAttachmentCheck(page)
      : await runAuthCheck(page, expectation);
  } catch {
    return failedReport(kind);
  } finally {
    await browser?.close().catch(() => undefined);
  }
}
