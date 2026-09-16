import {
  readdirSync,
  readFileSync,
  writeFileSync,
  type Dirent,
} from "node:fs";
import { basename, join, relative, sep } from "node:path";

interface TokenUsage {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
}

interface ListPrice {
  uncached_input_per_million_usd: number;
  cached_input_per_million_usd: number;
  cache_write_surcharge_per_million_usd: number;
  output_per_million_usd: number;
}

interface CostEstimate {
  uncached_input_usd: number;
  cached_input_usd: number;
  cache_write_surcharge_usd: number;
  output_usd: number;
  total_usd: number;
}

export interface UsageInvocation extends TokenUsage {
  component: "ingredients-agent" | "cart-decision" | "legacy-whole-run";
  item_id: string | null;
  attempt: string;
  model: string;
  event_path: string;
  turns_reported: number;
  malformed_event_lines: number;
  usage_status: "reported" | "missing";
  uncached_input_tokens: number;
  cache_rate: number | null;
  estimated_list_price_usd: CostEstimate | null;
}

export interface UsageSummary {
  schema_version: 1;
  generated_at: string;
  pricing: {
    basis: "public API list-price equivalent";
    currency: "USD";
    as_of: string;
    source: string;
    caveats: string[];
    models: Record<string, ListPrice>;
  };
  invocations: UsageInvocation[];
  totals: TokenUsage & {
    invocation_count: number;
    reported_invocation_count: number;
    priced_invocation_count: number;
    unpriced_invocation_count: number;
    uncached_input_tokens: number;
    cache_rate: number | null;
    estimated_list_price_usd: CostEstimate | null;
    price_coverage: "all" | "partial" | "none";
  };
}

const PRICING_AS_OF = "2026-09-15";
const PRICING_SOURCE =
  "https://developers.openai.com/api/docs/models";
const MODEL_PRICES: Record<string, ListPrice> = {
  "gpt-5.6-terra": {
    uncached_input_per_million_usd: 2,
    cached_input_per_million_usd: 0.2,
    cache_write_surcharge_per_million_usd: 0.5,
    output_per_million_usd: 12,
  },
  "gpt-5.6-luna": {
    uncached_input_per_million_usd: 0.2,
    cached_input_per_million_usd: 0.02,
    cache_write_surcharge_per_million_usd: 0.05,
    output_per_million_usd: 1.2,
  },
};

const EMPTY_USAGE = (): TokenUsage => ({
  input_tokens: 0,
  cached_input_tokens: 0,
  cache_write_input_tokens: 0,
  output_tokens: 0,
  reasoning_output_tokens: 0,
});

const finiteNonnegative = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;

const addUsage = (target: TokenUsage, value: unknown): void => {
  if (!value || typeof value !== "object") return;
  const usage = value as Record<string, unknown>;
  target.input_tokens += finiteNonnegative(usage.input_tokens);
  target.cached_input_tokens += finiteNonnegative(usage.cached_input_tokens);
  target.cache_write_input_tokens += finiteNonnegative(
    usage.cache_write_input_tokens,
  );
  target.output_tokens += finiteNonnegative(usage.output_tokens);
  target.reasoning_output_tokens += finiteNonnegative(
    usage.reasoning_output_tokens,
  );
};

const roundUsd = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;

const estimateCost = (
  usage: TokenUsage,
  price: ListPrice,
): CostEstimate => {
  const uncached = Math.max(0, usage.input_tokens - usage.cached_input_tokens);
  const uncachedInputUsd =
    (uncached * price.uncached_input_per_million_usd) / 1_000_000;
  const cachedInputUsd =
    (usage.cached_input_tokens * price.cached_input_per_million_usd) /
    1_000_000;
  const cacheWriteSurchargeUsd =
    (usage.cache_write_input_tokens *
      price.cache_write_surcharge_per_million_usd) /
    1_000_000;
  const outputUsd =
    (usage.output_tokens * price.output_per_million_usd) / 1_000_000;
  return {
    uncached_input_usd: roundUsd(uncachedInputUsd),
    cached_input_usd: roundUsd(cachedInputUsd),
    cache_write_surcharge_usd: roundUsd(cacheWriteSurchargeUsd),
    output_usd: roundUsd(outputUsd),
    total_usd: roundUsd(
      uncachedInputUsd + cachedInputUsd + cacheWriteSurchargeUsd + outputUsd,
    ),
  };
};

const findEventStreams = (directory: string): string[] => {
  const paths: string[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return paths;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "browser") paths.push(...findEventStreams(path));
    } else if (
      entry.isFile() &&
      /^codex-events(?:-[a-z0-9-]+)?\.jsonl$/i.test(entry.name)
    ) {
      paths.push(path);
    }
  }
  return paths.sort();
};

const readMetadata = (runDir: string): Record<string, unknown> => {
  try {
    return JSON.parse(readFileSync(join(runDir, "metadata.json"), "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
};

const stringValue = (value: unknown, fallback: string): string =>
  typeof value === "string" && value.length > 0 ? value : fallback;

const invocationIdentity = (
  runDir: string,
  eventPath: string,
  metadata: Record<string, unknown>,
): Pick<UsageInvocation, "component" | "item_id" | "attempt" | "model" | "event_path"> => {
  const relativePath = relative(runDir, eventPath).split(sep).join("/");
  const parts = relativePath.split("/");
  const filename = basename(eventPath);
  const suffix = filename.match(/^codex-events(?:-([a-z0-9-]+))?\.jsonl$/i)?.[1];
  const attempt = suffix ?? "initial";
  if (parts[0] === "ingredients-agent") {
    return {
      component: "ingredients-agent",
      item_id: null,
      attempt,
      model: stringValue(
        metadata.ingredientsAgentModel,
        "gpt-5.6-terra",
      ),
      event_path: relativePath,
    };
  }
  if (parts[0] === "cart-decision") {
    return {
      component: "cart-decision",
      item_id: parts[1] ?? null,
      attempt,
      model: stringValue(metadata.cartDecisionModel, "gpt-5.6-terra"),
      event_path: relativePath,
    };
  }
  return {
    component: "legacy-whole-run",
    item_id: null,
    attempt,
    model: stringValue(metadata.model, "gpt-5.6-luna"),
    event_path: relativePath,
  };
};

const summarizeEventStream = (
  runDir: string,
  eventPath: string,
  metadata: Record<string, unknown>,
): UsageInvocation => {
  const usage = EMPTY_USAGE();
  let turnsReported = 0;
  let malformedEventLines = 0;
  for (const line of readFileSync(eventPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { type?: unknown; usage?: unknown };
      if (event.type === "turn.completed" && event.usage) {
        addUsage(usage, event.usage);
        turnsReported += 1;
      }
    } catch {
      malformedEventLines += 1;
    }
  }
  const identity = invocationIdentity(runDir, eventPath, metadata);
  const price = MODEL_PRICES[identity.model];
  return {
    ...identity,
    ...usage,
    turns_reported: turnsReported,
    malformed_event_lines: malformedEventLines,
    usage_status: turnsReported > 0 ? "reported" : "missing",
    uncached_input_tokens: Math.max(
      0,
      usage.input_tokens - usage.cached_input_tokens,
    ),
    cache_rate:
      usage.input_tokens > 0
        ? usage.cached_input_tokens / usage.input_tokens
        : null,
    estimated_list_price_usd: price ? estimateCost(usage, price) : null,
  };
};

export function buildUsageSummary(
  runDir: string,
  now = new Date(),
): UsageSummary {
  const metadata = readMetadata(runDir);
  const invocations = findEventStreams(runDir)
    .map((path) => summarizeEventStream(runDir, path, metadata))
    .sort((left, right) => {
      const identity = `${left.component}/${left.item_id ?? ""}`.localeCompare(
        `${right.component}/${right.item_id ?? ""}`,
      );
      if (identity !== 0) return identity;
      if (left.attempt === "initial") return -1;
      if (right.attempt === "initial") return 1;
      return left.attempt.localeCompare(right.attempt);
    });
  const usage = EMPTY_USAGE();
  for (const invocation of invocations) addUsage(usage, invocation);
  const priced = invocations.filter(
    ({ estimated_list_price_usd }) => estimated_list_price_usd !== null,
  );
  const cost = priced.reduce<CostEstimate>(
    (total, invocation) => {
      const value = invocation.estimated_list_price_usd!;
      total.uncached_input_usd += value.uncached_input_usd;
      total.cached_input_usd += value.cached_input_usd;
      total.cache_write_surcharge_usd += value.cache_write_surcharge_usd;
      total.output_usd += value.output_usd;
      total.total_usd += value.total_usd;
      return total;
    },
    {
      uncached_input_usd: 0,
      cached_input_usd: 0,
      cache_write_surcharge_usd: 0,
      output_usd: 0,
      total_usd: 0,
    },
  );
  for (const key of Object.keys(cost) as (keyof CostEstimate)[]) {
    cost[key] = roundUsd(cost[key]);
  }
  return {
    schema_version: 1,
    generated_at: now.toISOString(),
    pricing: {
      basis: "public API list-price equivalent",
      currency: "USD",
      as_of: PRICING_AS_OF,
      source: PRICING_SOURCE,
      caveats: [
        "This is a list-price equivalent, not a statement of the charge to a ChatGPT subscription.",
        "Long-context or other pricing modifiers are not reconstructed from aggregate turn usage.",
        "Output tokens already include reasoning output for billing; reasoning tokens are not charged twice.",
        "Cache-write tokens are included in uncached input and add the documented 25% cache-write surcharge.",
      ],
      models: MODEL_PRICES,
    },
    invocations,
    totals: {
      invocation_count: invocations.length,
      reported_invocation_count: invocations.filter(
        ({ usage_status }) => usage_status === "reported",
      ).length,
      priced_invocation_count: priced.length,
      unpriced_invocation_count: invocations.length - priced.length,
      ...usage,
      uncached_input_tokens: Math.max(
        0,
        usage.input_tokens - usage.cached_input_tokens,
      ),
      cache_rate:
        usage.input_tokens > 0
          ? usage.cached_input_tokens / usage.input_tokens
          : null,
      estimated_list_price_usd: priced.length > 0 ? cost : null,
      price_coverage:
        priced.length === 0
          ? "none"
          : priced.length === invocations.length
            ? "all"
            : "partial",
    },
  };
}

export function writeUsageSummary(runDir: string): string {
  const path = join(runDir, "usage.json");
  writeFileSync(path, `${JSON.stringify(buildUsageSummary(runDir), null, 2)}\n`, {
    mode: 0o600,
  });
  return path;
}
