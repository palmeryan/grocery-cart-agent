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

export interface CartMutationExpectation {
  asin: string;
  /** Exact delta, or positive to accept any positive WFM-reported unit delta. */
  expectedQuantity: number | "positive";
  timeoutMs?: number;
}

export type CartMutationObservation =
  | {
      status: "confirmed";
      snapshot: CartNetworkSnapshot;
      delta: number;
      records: CartNetworkResponseRecord[];
      diagnostic: string;
    }
  | {
      status: "no_mutation";
      snapshot: CartNetworkSnapshot;
      delta: 0;
      records: CartNetworkResponseRecord[];
      diagnostic: string;
    }
  | {
      status: "rejected";
      snapshot: CartNetworkSnapshot;
      delta: 0;
      records: CartNetworkResponseRecord[];
      diagnostic: string;
    }
  | {
      status: "unknown";
      snapshot: CartNetworkSnapshot | null;
      delta: number | null;
      records: CartNetworkResponseRecord[];
      diagnostic: string;
    };

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

function quantityMap(items: readonly CartNetworkItem[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of items) {
    const asin = item.asin.toUpperCase();
    map.set(asin, (map.get(asin) ?? 0) + item.quantity);
  }
  return map;
}

function cartRejectionForAsin(body: string, asin: string): string | null {
  try {
    const value = JSON.parse(body) as { carts?: unknown };
    if (!Array.isArray(value.carts)) return null;
    for (const cart of value.carts) {
      if (!cart || typeof cart !== "object") continue;
      const statuses = (cart as { status?: unknown }).status;
      if (!Array.isArray(statuses)) continue;
      for (const status of statuses) {
        if (!status || typeof status !== "object") continue;
        const entry = status as { itemData?: unknown; errorMessage?: unknown; statusCode?: unknown };
        if (typeof entry.itemData !== "string" || typeof entry.errorMessage !== "string") continue;
        let item: { ASIN?: unknown };
        try {
          item = JSON.parse(entry.itemData) as { ASIN?: unknown };
        } catch {
          continue;
        }
        if (typeof item.ASIN !== "string" || item.ASIN.toUpperCase() !== asin) continue;
        const code = typeof entry.statusCode === "string" ? ` (statusCode ${entry.statusCode})` : "";
        return `Whole Foods rejected ${asin}: ${entry.errorMessage}${code}.`;
      }
    }
  } catch {
    // An unrecognized status payload cannot establish the reason for a no-op.
  }
  return null;
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

export function getSuccessfulFullCartMutation(
  records: readonly CartNetworkResponseRecord[],
): CartNetworkSnapshot | null {
  return records.map((record, index) => ({ record, index }))
    .sort((left, right) =>
      right.record.timestamp.localeCompare(left.record.timestamp) || right.index - left.index,
    )
    .map(({ record }) => record)
    .find((record) =>
    (record.method === "POST" || record.method === "PUT") &&
    record.status >= 200 && record.status < 300 && record.snapshot !== null
  )?.snapshot ?? null;
}

/** Listen on the owned page; response bodies stay in memory and are not logged to disk. */
export class CartNetworkObserver {
  private readonly records: CartNetworkResponseRecord[] = [];
  private readonly pending = new Set<Promise<void>>();
  private mutationBefore: readonly CartNetworkItem[] | null = null;
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
    if (method !== "GET" && method !== "POST" && method !== "PUT") return;
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

  /** Establish the cart state against which the next add is evaluated. */
  async beginMutation(before: readonly CartNetworkItem[]): Promise<void> {
    await Promise.all([...this.pending]);
    this.records.splice(0);
    this.mutationBefore = before.map((item) => ({
      asin: item.asin.toUpperCase(),
      quantity: item.quantity,
    }));
  }

  /** Wait for the armed invocation's matching cart mutation. */
  async waitForMutation(
    expectation: CartMutationExpectation,
  ): Promise<CartMutationObservation> {
    const before = this.mutationBefore;
    this.mutationBefore = null;
    if (before === null) {
      return {
        status: "unknown",
        snapshot: null,
        delta: null,
        records: await this.drain(),
        diagnostic: "Cart mutation was awaited without first arming an invocation.",
      };
    }
    if (expectation.expectedQuantity !== "positive" &&
      (!Number.isFinite(expectation.expectedQuantity) || expectation.expectedQuantity <= 0)) {
      return {
        status: "unknown",
        snapshot: null,
        delta: null,
        records: await this.drain(),
        diagnostic: "Expected mutation quantity must be a finite positive number.",
      };
    }
    const asin = expectation.asin.trim().toUpperCase();
    if (asin === "") {
      return {
        status: "unknown",
        snapshot: null,
        delta: null,
        records: await this.drain(),
        diagnostic: "Expected mutation ASIN is empty.",
      };
    }
    const previous = quantityMap(before);
    const deadline = Date.now() + (expectation.timeoutMs ?? 10_000);
    let cursor = 0;
    let unchanged: CartNetworkSnapshot | null = null;
    let partial: CartNetworkSnapshot | null = null;
    let partialDelta: number | null = null;
    let malformedMutation = false;

    const inspect = (): CartMutationObservation | null => {
      const batch = this.records.slice(cursor).sort((left, right) =>
        left.timestamp.localeCompare(right.timestamp),
      );
      cursor = this.records.length;
      let confirmed: CartMutationObservation | null = null;
      let unexpected: CartMutationObservation | null = null;
      for (const record of batch) {
        if (record.method !== "POST" && record.method !== "PUT") continue;
        if (!(record.status >= 200 && record.status < 300) || record.snapshot === null) {
          malformedMutation = true;
          continue;
        }
        const current = quantityMap(record.snapshot.items);
        const delta = (current.get(asin) ?? 0) - (previous.get(asin) ?? 0);
        if (expectation.expectedQuantity === "positive" ? delta > 0 : delta === expectation.expectedQuantity) {
          confirmed = { status: "confirmed", snapshot: record.snapshot, delta, records: [],
            diagnostic: `Network cart increased ${asin} by ${delta}.` };
          continue;
        }
        if (delta === 0) {
          const rejection = cartRejectionForAsin(record.body, asin);
          if (rejection) {
            return { status: "rejected", snapshot: record.snapshot, delta: 0, records: [],
              diagnostic: rejection };
          }
          unchanged = record.snapshot;
        }
        else if (expectation.expectedQuantity !== "positive" && delta > 0 && delta < expectation.expectedQuantity) {
          partial = record.snapshot;
          partialDelta = delta;
        }
        else {
          unexpected = { status: "unknown", snapshot: record.snapshot, delta, records: [],
            diagnostic: `Cart quantity delta for ${asin} was ${delta}; expected ${expectation.expectedQuantity}.` };
        }
      }
      return confirmed ?? unexpected;
    };

    while (Date.now() < deadline) {
      await Promise.all([...this.pending]);
      const result = inspect();
      if (result) {
        return { ...result, records: this.records.splice(0) };
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await Promise.all([...this.pending]);
    const result = inspect();
    if (result) {
      return { ...result, records: this.records.splice(0) };
    }
    const records = this.records.splice(0);
    if (partial !== null) {
      return { status: "unknown", snapshot: partial, delta: partialDelta, records,
        diagnostic: `Cart increase for ${asin} stopped at ${partialDelta}; expected ${expectation.expectedQuantity}.` };
    }
    return { status: "unknown", snapshot: unchanged, delta: unchanged ? 0 : null, records,
      diagnostic: unchanged !== null && !malformedMutation
        ? `An unchanged full-cart response was observed for ${asin}, but it was not correlated with this mutation; the cart effect is unknown.`
        : "No matching successful full-cart mutation was observed; the cart effect is unknown." };
  }

  async waitForFullCartMutation(timeoutMs = 2_000): Promise<CartNetworkResponseRecord[]> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await Promise.all([...this.pending]);
      if (getSuccessfulFullCartMutation(this.records)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await Promise.all([...this.pending]);
    return this.records.splice(0);
  }

  dispose(): void {
    this.page.off("response", this.listener);
  }
}
