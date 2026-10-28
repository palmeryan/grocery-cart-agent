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
        wholeFoodsStorefrontConfirmed: false,
        failureReason:
          "Deterministic preflight could not inspect the signed-in Whole Foods page",
      };

export const buildAuthReportFromObservation = (
  url: string,
  text: string,
  authenticated: boolean,
): AuthReport => {
  const wholeFoodsStorefrontConfirmed = isWholeFoodsStorefront(url, text);
  const completed =
    authenticated &&
    wholeFoodsStorefrontConfirmed;
  const missing = [
    !authenticated ? "authentication (account API reported signed out)" : null,
    !wholeFoodsStorefrontConfirmed ? "Whole Foods storefront" : null,
  ].filter((value): value is string => value !== null);
  return {
    runStatus: completed ? "completed" : "failed",
    authenticated,
    wholeFoodsStorefrontConfirmed,
    failureReason: completed
      ? null
      : `Deterministic preflight could not confirm: ${missing.join(", ")}`,
  };
};

export const parseAccountSummaryAuthentication = (value: unknown): boolean => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("customer" in value) ||
    typeof value.customer !== "object" ||
    value.customer === null ||
    !("authenticated" in value.customer) ||
    typeof value.customer.authenticated !== "boolean"
  ) {
    throw new Error("account summary omitted customer.authenticated");
  }
  return value.customer.authenticated;
};

export const readAccountAuthentication = async (page: Page): Promise<boolean> => {
  try {
    const endpoint = new URL("/api/account/summary", page.url()).toString();
    const response = await page.request.get(endpoint, {
      headers: { accept: "application/json" },
    });
    if (!response.ok()) {
      throw new Error(`account summary returned HTTP ${response.status()}`);
    }
    return parseAccountSummaryAuthentication(await response.json());
  } catch (error) {
    throw new Error(
      `Could not determine authentication from /api/account/summary: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
};

const runAuthCheck = async (
  page: Page,
): Promise<AuthReport> => {
  const [text, authenticated] = await Promise.all([
    pageText(page),
    readAccountAuthentication(page),
  ]);
  return buildAuthReportFromObservation(
    page.url(),
    text,
    authenticated,
  );
};

export async function runDeterministicCheck(
  kind: "auth-check" | "attachment-check",
  session: OwnedChromeSession,
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
      : await runAuthCheck(page);
  } catch (error) {
    const report = failedReport(kind);
    report.failureReason =
      error instanceof Error ? error.message : String(error);
    return report;
  } finally {
    await browser?.close().catch(() => undefined);
  }
}
