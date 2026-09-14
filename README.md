# Whole Foods Cart Builder POC

Local feasibility harness using ChatGPT-authenticated Codex CLI and Microsoft
Playwright MCP. This repository records a **negative / incomplete result**: it
is not a proven cart builder.

## Current outcome

The dedicated-profile live smoke **failed** because Amazon authentication did
not persist into Playwright MCP after a clean manual sign-in. Cart-matching
acceptance runs (staples / ambiguous / substitutions, controlled rerun, later-day
persistence) were **not performed**.

Next architecture recommendation: attach to a normal authenticated browser
session rather than relying on an isolated dedicated Chrome profile for auth.

Operators should **not** assume the dedicated-profile build command below works
end-to-end today. Treat the command as the harness entrypoint for further
experiments, not as a verified workflow.

## Safety warning

This POC gives Codex generic control of a browser that may be signed into a
funded Amazon account. Checkout prevention is prompt-only, not a hard security
boundary. Watch any live run. Stop the process immediately (`Ctrl-C`) if it
enters checkout or changes account settings.

## Prerequisites

- macOS with Google Chrome
- Node.js 22.16.0 or newer
- Codex CLI 0.154.0 or newer, signed into the intended ChatGPT account

## Install

```bash
npm install
npm test
npm run typecheck
npm run lint
```

## One-time browser setup (experimental)

```bash
npm run login
```

Sign into Amazon, set the delivery address, open Whole Foods, then close every
window using the dedicated profile. Live smoke showed this dedicated profile did
**not** retain a usable Amazon session under Playwright MCP.

## Build a cart (harness entrypoint)

```bash
export WFM_EXPECTED_POSTAL_CODE=02139
./scripts/build-wfm-cart.sh examples/staples.json
```

Replace `02139` with the expected five-digit delivery postal code.

This command is the local orchestration harness. Because auth did not persist
into Playwright MCP, it is **not** currently validated as an end-to-end cart
builder.

Sensitive output is written under `runs/` and must never be committed or
uploaded.
