import { spawn } from "node:child_process";

let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
process.stdout.write(`${JSON.stringify({ type: "prompt", prompt })}\n`);
process.stderr.write("fake-codex-stderr\n");

const descendantFlag = process.argv.indexOf("--spawn-descendant");
const resistantFlag = process.argv.indexOf(
  "--spawn-term-resistant-descendant",
);

if (descendantFlag !== -1) {
  const markerPath = process.argv[descendantFlag + 1];
  if (!markerPath) {
    throw new Error("--spawn-descendant requires a marker path");
  }
  // Stay in the same process group so group termination reaps this child.
  spawn(
    process.execPath,
    [
      "-e",
      "const fs=require('node:fs');fs.writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000);",
      markerPath,
    ],
    { stdio: "ignore", detached: false },
  );
}

if (resistantFlag !== -1) {
  const markerPath = process.argv[resistantFlag + 1];
  if (!markerPath) {
    throw new Error(
      "--spawn-term-resistant-descendant requires a marker path",
    );
  }
  // Descendant ignores SIGTERM and only dies on SIGKILL; remains in this group.
  spawn(
    process.execPath,
    [
      "-e",
      'process.on("SIGTERM",()=>{});const fs=require("node:fs");fs.writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000);',
      markerPath,
    ],
    { stdio: "ignore", detached: false },
  );
  // Leader uses default SIGTERM disposition (exit) so close can race killTimer.
}

if (
  process.argv.includes("--hang") ||
  process.argv.includes("--spawn-descendant") ||
  process.argv.includes("--spawn-term-resistant-descendant")
) {
  await new Promise(() => setInterval(() => {}, 1_000));
}
