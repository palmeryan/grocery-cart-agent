import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildUsageSummary, writeUsageSummary } from "../src/usage.js";

const writeEvents = (
  path: string,
  usage?: Partial<Record<string, number>>,
): void => {
  mkdirSync(join(path, ".."), { recursive: true });
  const lines = [
    JSON.stringify({ type: "thread.started", thread_id: "test" }),
    ...(usage
      ? [JSON.stringify({ type: "turn.completed", usage })]
      : []),
  ];
  writeFileSync(path, `${lines.join("\n")}\n`);
};

describe("usage rollup", () => {
  it("prices Cart Agent runs that override the model to Luna", () => {
    const runDir = mkdtempSync(join(tmpdir(), "wfm-usage-luna-"));
    writeFileSync(
      join(runDir, "metadata.json"),
      JSON.stringify({ cartAgentModel: "gpt-5.6-luna" }),
    );
    writeEvents(join(runDir, "cart-agent", "ginger", "codex-events.jsonl"), {
      input_tokens: 1_000_000,
      cached_input_tokens: 900_000,
      output_tokens: 1_000,
    });

    const summary = buildUsageSummary(runDir);

    expect(summary.totals).toMatchObject({
      priced_invocation_count: 1,
      unpriced_invocation_count: 0,
      estimated_list_price_usd: {
        uncached_input_usd: 0.02,
        cached_input_usd: 0.018,
        output_usd: 0.0012,
        total_usd: 0.0392,
      },
    });
  });

  it("includes Ingredients Agent, Cart Agent, and retry usage", () => {
    const runDir = mkdtempSync(join(tmpdir(), "wfm-usage-"));
    writeFileSync(
      join(runDir, "metadata.json"),
      JSON.stringify({
        ingredientsAgentModel: "gpt-5.6-terra",
        cartAgentModel: "gpt-5.6-terra",
      }),
    );
    writeEvents(join(runDir, "ingredients-agent", "codex-events.jsonl"), {
      input_tokens: 1_000,
      cached_input_tokens: 200,
      cache_write_input_tokens: 50,
      output_tokens: 100,
      reasoning_output_tokens: 20,
    });
    writeEvents(join(runDir, "cart-agent", "ginger", "codex-events.jsonl"), {
      input_tokens: 2_000,
      cached_input_tokens: 1_500,
      output_tokens: 200,
      reasoning_output_tokens: 40,
    });
    writeEvents(
      join(runDir, "cart-agent", "ginger", "codex-events-retry.jsonl"),
      {
        input_tokens: 3_000,
        cached_input_tokens: 2_500,
        output_tokens: 300,
        reasoning_output_tokens: 60,
      },
    );

    const summary = buildUsageSummary(runDir, new Date("2026-09-15T12:00:00Z"));

    expect(summary.invocations.map(({ component, item_id, attempt }) => ({
      component,
      item_id,
      attempt,
    }))).toEqual([
      { component: "cart-agent", item_id: "ginger", attempt: "initial" },
      { component: "cart-agent", item_id: "ginger", attempt: "retry" },
      { component: "ingredients-agent", item_id: null, attempt: "initial" },
    ]);
    expect(summary.totals).toMatchObject({
      invocation_count: 3,
      reported_invocation_count: 3,
      input_tokens: 6_000,
      cached_input_tokens: 4_200,
      uncached_input_tokens: 1_800,
      cache_write_input_tokens: 50,
      output_tokens: 600,
      reasoning_output_tokens: 120,
      cache_rate: 0.7,
      priced_invocation_count: 3,
      unpriced_invocation_count: 0,
      price_coverage: "all",
      estimated_list_price_usd: {
        uncached_input_usd: 0.0036,
        cached_input_usd: 0.00084,
        cache_write_surcharge_usd: 0.000025,
        output_usd: 0.0072,
        total_usd: 0.011665,
      },
    });
  });

  it("records an attempted stream with missing usage and tolerates malformed lines", () => {
    const runDir = mkdtempSync(join(tmpdir(), "wfm-usage-missing-"));
    const path = join(runDir, "cart-agent", "broccoli", "codex-events.jsonl");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "{not-json}\n{\"type\":\"turn.started\"}\n");

    const summary = buildUsageSummary(runDir);

    expect(summary.invocations[0]).toMatchObject({
      item_id: "broccoli",
      usage_status: "missing",
      malformed_event_lines: 1,
      input_tokens: 0,
      cache_rate: null,
    });
  });

  it("writes a readable owner-only usage.json", () => {
    const runDir = mkdtempSync(join(tmpdir(), "wfm-usage-write-"));
    const path = writeUsageSummary(runDir);
    const parsed = JSON.parse(readFileSync(path, "utf8"));

    expect(parsed.schema_version).toBe(1);
    expect(parsed.totals.invocation_count).toBe(0);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
