import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { assessModelToolInventory, buildModelToolProbeInvocation, MODEL_TOOL_PROBE_PROMPT, parseModelToolTrace } from "./model-tool-probe.js";
import { runCodex } from "./codex.js";

const config = loadConfig();
const stamp = new Date().toISOString().replaceAll(":", "-").replace(".", "-");
const runDir = join(config.runsDir, `model-tool-probe-${stamp}`);
const modelDir = join(runDir, "model-work");
mkdirSync(modelDir, { recursive: true, mode: 0o700 });
const outputPath = join(runDir, "inventory.json");
const traceRoot = join(runDir, "rollout-trace");
mkdirSync(traceRoot, { recursive: true, mode: 0o700 });
const invocation = buildModelToolProbeInvocation({ rootDir: config.rootDir, workDir: modelDir, outputPath });
const result = await runCodex({
  executable: config.codexBin,
  args: invocation.args,
  workDir: invocation.workDir,
  prompt: MODEL_TOOL_PROBE_PROMPT,
  eventsPath: join(runDir, "codex-events.jsonl"),
  stderrPath: join(runDir, "codex-stderr.log"),
  timeoutMs: config.maxRunMs,
  rolloutTraceRoot: traceRoot,
});
if (result.timedOut || result.exitCode !== 0) {
  throw new Error(`Model tool probe failed (exit ${result.exitCode}${result.signal ? `, ${result.signal}` : ""}); inspect ${runDir}`);
}
const inventory = parseModelToolTrace(traceRoot);
console.log(JSON.stringify({ ...inventory, assessment: assessModelToolInventory(inventory), runDir }, null, 2));
