import { readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  buildRestrictedCodexInvocation,
  RESTRICTED_MODEL_SETTINGS,
  INGREDIENTS_AGENT_MODEL,
  INGREDIENTS_AGENT_REASONING_EFFORT,
  type CodexInvocation,
  type ReasoningEffort,
} from "./codex.js";

/** Fixed diagnostic only. The model's text is deliberately not used as evidence. */
export const MODEL_TOOL_PROBE_PROMPT = "Reply with the single word ready.";

export interface ModelToolInventory {
  visibleTools: string[];
  traceFiles: number;
}

/** Exact tool-name mappings to settings passed by buildRestrictedCodexInvocation.
 * Keep this explicit: new names and lookalike names remain uncovered. */
export const MODEL_TOOL_DISABLED_SETTING_MAP: Readonly<Record<string, readonly string[]>> = {
  "functions.exec": ["features.code_mode_host=false"],
  "functions.wait": ["features.code_mode_host=false"],
  "collaboration.followup_task": ["agents.enabled=false", "features.multi_agent=false"],
  "collaboration.interrupt_agent": ["agents.enabled=false", "features.multi_agent=false"],
  "collaboration.list_agents": ["agents.enabled=false", "features.multi_agent=false"],
  "collaboration.send_message": ["agents.enabled=false", "features.multi_agent=false"],
  "collaboration.spawn_agent": ["agents.enabled=false", "features.multi_agent=false"],
  "collaboration.wait_agent": ["agents.enabled=false", "features.multi_agent=false"],
};

export interface ModelToolPolicyAssessment {
  status: "covered" | "warning";
  uncovered: string[];
  covered: { name: string; settings: readonly string[] }[];
}

export function assessModelToolInventory(
  inventory: ModelToolInventory | null,
): ModelToolPolicyAssessment {
  if (!inventory) return { status: "warning", uncovered: [], covered: [] };
  const activeSettings = new Set<string>(RESTRICTED_MODEL_SETTINGS);
  const covered: { name: string; settings: readonly string[] }[] = [];
  const uncovered: string[] = [];
  for (const name of new Set(inventory.visibleTools)) {
    const settings = MODEL_TOOL_DISABLED_SETTING_MAP[name];
    if (settings && settings.every((setting) => activeSettings.has(setting))) {
      covered.push({ name, settings });
    } else {
      uncovered.push(name);
    }
  }
  return { status: uncovered.length ? "warning" : "covered", uncovered: uncovered.sort(), covered: covered.sort((a, b) => a.name.localeCompare(b.name)) };
}

export function buildModelToolProbeInvocation(input: {
  rootDir: string;
  workDir: string;
  outputPath: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
}): CodexInvocation {
  return buildRestrictedCodexInvocation({
    rootDir: input.rootDir,
    workDir: input.workDir,
    outputPath: input.outputPath,
    // No schema is sent for this probe; the trace supplies the inventory.
    schemaPath: "schemas/ingredients-agent-output.schema.json",
    model: input.model ?? INGREDIENTS_AGENT_MODEL,
    reasoningEffort: input.reasoningEffort ?? INGREDIENTS_AGENT_REASONING_EFFORT,
    omitStructuredOutput: true,
  });
}

type JsonRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function addToolNames(value: unknown, names: Set<string>, namespace?: string): void {
  if (!Array.isArray(value)) return;
  for (const tool of value) {
    if (typeof tool === "string") names.add(namespace ? `${namespace}.${tool}` : tool);
    else if (isRecord(tool)) {
      const name = typeof tool.name === "string" && tool.name.length > 0 ? tool.name : undefined;
      if (tool.type === "namespace" && name) {
        // Codex serializes additional tools as namespace entries, e.g.
        // {type:"namespace",name:"functions",tools:[{name:"exec"}]}.
        addToolNames(tool.tools, names, name);
      } else if (name) names.add(namespace ? `${namespace}.${name}` : name);
      if (isRecord(tool.tool) && typeof tool.tool.name === "string") {
        names.add(namespace ? `${namespace}.${tool.tool.name}` : tool.tool.name);
      }
    }
  }
}

function collectRequestTools(value: unknown, names: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectRequestTools(item, names);
    return;
  }
  if (!isRecord(value)) return;

  if (value.type === "function" && typeof value.name === "string") names.add(value.name);
  if (Object.hasOwn(value, "tools")) addToolNames(value.tools, names);
  for (const [key, child] of Object.entries(value)) {
    if (key === "tools") continue;
    collectRequestTools(child, names);
  }
}

function parseJsonLines(text: string): unknown[] {
  const values: unknown[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { values.push(JSON.parse(line) as unknown); } catch {
      // Some trace files are pretty-printed JSON rather than JSONL.
      try { return [JSON.parse(text) as unknown]; } catch { /* skip malformed line */ }
    }
  }
  return values;
}

function listTraceFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  visit(root);
  return files;
}

/** Parse only request payloads referenced by inference_started trace records. */
export function parseModelToolTrace(traceRoot: string): ModelToolInventory {
  let files: string[];
  try { files = listTraceFiles(resolve(traceRoot)); } catch {
    throw new Error("Model tool preflight inconclusive: no rollout trace was captured");
  }
  const names = new Set<string>();
  const payloadPaths = new Set<string>();
  for (const file of files) {
    if (!file.endsWith("trace.jsonl")) continue;
    let text: string;
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    for (const value of parseJsonLines(text)) {
      // Rollout trace JSONL records wrap the event under `payload`.
      const event = isRecord(value) && isRecord(value.payload) ? value.payload : value;
      if (!isRecord(event) || event.type !== "inference_started" || !isRecord(event.request_payload)) continue;
      const payloadPath = event.request_payload.path;
      if (typeof payloadPath === "string" && payloadPath.length > 0) {
        payloadPaths.add(isAbsolute(payloadPath) ? resolve(payloadPath) : resolve(dirname(file), payloadPath));
      }
    }
  }
  if (payloadPaths.size === 0) throw new Error("Model tool preflight inconclusive: trace contains no inference_started request payload");
  for (const payloadPath of payloadPaths) {
    let payload: unknown;
    try { payload = JSON.parse(readFileSync(payloadPath, "utf8")) as unknown; } catch {
      throw new Error("Model tool preflight inconclusive: an inference request payload could not be read");
    }
    if (!isRecord(payload) || !Array.isArray(payload.input) ||
        (payload.tools !== undefined && payload.tools !== null && !Array.isArray(payload.tools))) {
      throw new Error("Model tool preflight inconclusive: unrecognized inference request format");
    }
    collectRequestTools(payload, names);
  }
  return { visibleTools: [...names].sort(), traceFiles: payloadPaths.size };
}
