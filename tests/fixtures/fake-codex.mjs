let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
process.stdout.write(`${JSON.stringify({ type: "prompt", prompt })}\n`);
process.stderr.write("fake-codex-stderr\n");
if (process.argv.includes("--hang")) {
  await new Promise(() => setInterval(() => {}, 1_000));
}
