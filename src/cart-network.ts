import type { Page, Response } from "playwright";

export interface CartNetworkItem {
  asin: string;
  quantity: number;
}

export interface CartNetworkSnapshot {
  items: CartNetworkItem[];
  observedAt: string;
  url: string;
  method: string;
  status: number;
}

export interface CartNetworkResponseRecord {
  url: string;
  method: string;
  status: number;
  body: string;
  timestamp: string;
  snapshot: CartNetworkSnapshot | null;
}

export interface CartNetworkReconciliation {
  matched: boolean;
  diagnostic: string;
}

const WHOLE_FOODS_HOST = /(^|\.)wholefoodsmarket\.com$/i;

function isCartEndpoint(urlValue: string): boolean {
  try {
    const url = new URL(urlValue);
    return (
      url.protocol === "https:" &&
      WHOLE_FOODS_HOST.test(url.hostname) &&
      /cartcache|cart/i.test(`${url.pathname}${url.search}`)
    );
  } catch {
    return false;
  }
}

/** Extract only stable identity and quantity from Whole Foods cart JSON. */
export function parseCartNetworkSnapshot(
  value: unknown,
  metadata: Pick<CartNetworkSnapshot, "url" | "method" | "status" | "observedAt">,
): CartNetworkSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const carts = (value as { carts?: unknown }).carts;
  if (!Array.isArray(carts) || carts.length === 0) return null;

  const items: CartNetworkItem[] = [];
  for (const cart of carts) {
    if (!cart || typeof cart !== "object") return null;
    const rawItems = (cart as { items?: unknown }).items;
    if (!Array.isArray(rawItems)) return null;
    for (const item of rawItems) {
      if (!item || typeof item !== "object") return null;
      const record = item as { asin?: unknown; quantity?: unknown };
      if (
        typeof record.asin !== "string" ||
        record.asin.trim() === "" ||
        typeof record.quantity !== "number" ||
        !Number.isFinite(record.quantity) ||
        record.quantity < 0
      ) return null;
      items.push({ asin: record.asin.trim().toUpperCase(), quantity: record.quantity });
    }
  }
  return { ...metadata, items };
}

export function getSuccessfulFullCartPost(
  records: readonly CartNetworkResponseRecord[],
): CartNetworkSnapshot | null {
  return [...records].reverse().find((record) =>
    record.method === "POST" && record.status >= 200 && record.status < 300 && record.snapshot !== null
  )?.snapshot ?? null;
}

/** Require exact per-ASIN quantity change for an agent-reported add. */
export function reconcileCartAgentResult(
  before: readonly CartNetworkItem[],
  after: CartNetworkSnapshot,
  result: { status: string; productId: string | null; quantity: number },
): CartNetworkReconciliation {
  const quantities = (items: readonly CartNetworkItem[]): Map<string, number> => {
    const map = new Map<string, number>();
    for (const item of items) {
      const asin = item.asin.toUpperCase();
      map.set(asin, (map.get(asin) ?? 0) + item.quantity);
    }
    return map;
  };
  const previous = quantities(before);
  const current = quantities(after.items);
  if (result.status !== "added") {
    const changed = new Set([...previous.keys(), ...current.keys()]);
    const unexpected = [...changed].some((key) => previous.get(key) !== current.get(key));
    const alreadyPresentMatch = result.status !== "already_present" || (
      result.productId !== null &&
      current.get(result.productId.toUpperCase()) === result.quantity
    );
    return {
      matched: !unexpected && alreadyPresentMatch,
      diagnostic: unexpected
        ? "Cart changed during an invocation that did not report an add."
        : alreadyPresentMatch
          ? "Network cart matches the non-add result."
          : "Network cart did not match the already-present result.",
    };
  }
  if (!result.productId) return { matched: false, diagnostic: "Added result has no productId/ASIN." };
  const asin = result.productId.toUpperCase();
  const previousQuantity = previous.get(asin) ?? 0;
  const currentQuantity = current.get(asin) ?? 0;
  const increase = currentQuantity - previousQuantity;
  const unrelatedChanged = [...new Set([...previous.keys(), ...current.keys()])]
    .some((key) => key !== asin && previous.get(key) !== current.get(key));
  const matched = increase === result.quantity && !unrelatedChanged;
  return {
    matched,
    diagnostic: matched
      ? `Network cart increased ${asin} by ${increase}.`
      : unrelatedChanged
        ? `Network cart changed an unrelated ASIN during the add for ${asin}.`
        : `Network cart increase for ${asin} was ${increase}; agent reported ${result.quantity}.`,
  };
}

/** Listen on the owned page; response bodies stay in memory and are not logged to disk. */
export class CartNetworkObserver {
  private readonly records: CartNetworkResponseRecord[] = [];
  private readonly pending = new Set<Promise<void>>();
  private readonly listener = (response: Response): void => {
    const work = this.capture(response);
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work));
  };

  constructor(private readonly page: Pick<Page, "on" | "off">) {
    page.on("response", this.listener);
  }

  private async capture(response: Response): Promise<void> {
    const url = response.url();
    if (!isCartEndpoint(url)) return;
    const method = response.request().method().toUpperCase();
    if (method !== "GET" && method !== "POST") return;
    const timestamp = new Date().toISOString();
    let body = "";
    let snapshot: CartNetworkSnapshot | null = null;
    try {
      body = await response.text();
      snapshot = parseCartNetworkSnapshot(JSON.parse(body) as unknown, {
        url,
        method,
        status: response.status(),
        observedAt: timestamp,
      });
    } catch {
      // Keep the raw response record; malformed or non-JSON responses are not snapshots.
    }
    this.records.push({ url, method, status: response.status(), body, timestamp, snapshot });
  }

  async drain(): Promise<CartNetworkResponseRecord[]> {
    await Promise.all([...this.pending]);
    return this.records.splice(0);
  }

  async waitForFullCartPost(timeoutMs = 2_000): Promise<CartNetworkResponseRecord[]> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await Promise.all([...this.pending]);
      if (getSuccessfulFullCartPost(this.records)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await Promise.all([...this.pending]);
    return this.records.splice(0);
  }

  dispose(): void {
    this.page.off("response", this.listener);
  }
}
