# Whole Foods Cart Builder POC

Local feasibility experiment using ChatGPT-authenticated Codex CLI and
Microsoft Playwright MCP.

## Safety warning

This POC gives Codex generic control of a browser signed into a funded Amazon
account. Checkout prevention is prompt-only, not a hard security boundary.
Watch the first run. Stop the process immediately if it enters checkout or
changes account settings.

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

## One-time browser setup

```bash
npm run login
```

Sign into Amazon, set the delivery address, open Whole Foods, then close every
window using the dedicated profile.

## Build a cart

```bash
export WFM_EXPECTED_POSTAL_CODE=02139
./scripts/build-wfm-cart.sh examples/staples.json
```

Replace `02139` with the expected five-digit delivery postal code.

Sensitive output is written under `runs/` and must never be committed or
uploaded.
