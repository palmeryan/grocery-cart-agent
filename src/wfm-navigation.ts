import type { BrowserContext, Route } from "playwright";

/** Cart runs may navigate only among the shopping pages they use. */
export function isShoppingPage(urlValue: string): boolean {
  try {
    const url = new URL(urlValue);
    return url.protocol === "https:" &&
      url.hostname === "www.wholefoodsmarket.com" &&
      (/^\/grocery\/(?:search|cart)\/?$/.test(url.pathname) ||
        /^\/grocery\/product\/[a-z0-9-]+\/?$/i.test(url.pathname));
  } catch {
    return false;
  }
}

export async function guardShoppingNavigation(
  context: BrowserContext,
  onBlocked: (url: string) => void,
): Promise<() => Promise<void>> {
  const handler = async (route: Route): Promise<void> => {
    const request = route.request();
    if (!request.isNavigationRequest() || isShoppingPage(request.url())) {
      await route.continue();
      return;
    }
    onBlocked(request.url());
    await route.abort();
  };
  await context.route("**/*", handler);
  return () => context.unroute("**/*", handler);
}
