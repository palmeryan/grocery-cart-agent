# Whole Foods Cart Builder

Local cart runner using the Codex CLI and Microsoft Playwright MCP to
turn recipe JSON into a Whole Foods delivery cart. This repository records
earlier incomplete dedicated-profile results and the current attached-browser
workflow. The first successful end-to-end cart run is still outstanding.

## Current outcome

The earlier dedicated-profile live smoke did not complete the cart workflow.
Cart-matching acceptance runs (staples / ambiguous / substitutions, controlled
rerun, later-day persistence) remain to be performed.

The CLI owns a dedicated Chrome profile. Both its diagnostics and the
cart-building agent connect directly to that owned Chrome instance over
localhost CDP. The account's saved default address is the delivery context;
Lamar is the intended Whole Foods store. Treat the commands below as the cart
entrypoint until a live end-to-end run succeeds.

The build has a deterministic shell and one adaptive browser-agent middle. The
shell validates the request, owns the Chrome lifecycle and run lock, configures
Playwright MCP, and validates the final report. A single browser-enabled Codex
run performs the storefront work: it interprets recipe context, searches,
chooses products or sensible substitutions, adds items, and verifies the cart.
There is no separate deterministic candidate-search or product-selection pass.

## Operating limits

The agent is instructed to build a delivery cart, preserve unrelated items, and
stop before checkout or order submission. These are prompt instructions, not a
browser-enforced checkout block. Supervise the first end-to-end run and use
`Ctrl-C` if needed.

Use the dedicated test profile. Local output in `runs/` is gitignored and may
contain account information and connection tokens; keep it local.

## Prerequisites

- macOS with Google Chrome
- Node.js 22.16.0 or newer
- Codex CLI 0.154.0 or newer, signed into the intended ChatGPT account

The cart runner explicitly uses the Codex `gpt-5.6-terra` model with medium
reasoning effort.

All harness commands below run from the repository root.

## Install

```bash
npm install
npm test
npm run typecheck
npm run lint
```

## Browser authentication

The cart command launches and owns a dedicated normal Chrome instance at
`~/.whole-foods-cart/chrome-profile`. It never attaches to the everyday Chrome
profile.

1. Run `npm run login`.
2. Sign in to Whole Foods Market and confirm the account's saved default
   address is the intended delivery address, with Lamar as the store context.
3. Close the dedicated Chrome window.
4. Run `npm run cart -- attachment-check` to verify deterministic Chrome/CDP
   startup against Example Domain without opening the storefront.
5. Run `npm run auth-check` to verify authentication and delivery context
   deterministically, without invoking Codex.
6. After the auth check succeeds, run
   `npm run cart -- build path/to/request.json`.

The CLI starts Chrome on demand and closes only the instance it launched.
The build passes the owned Chrome's localhost CDP endpoint to Playwright MCP;
it does not open an MCP connection tab or require a second browser window.
Browser-tool connection details can still appear in tool output and saved run
artifacts; treat those outputs as sensitive and do not commit or upload them.

### Recovery lock

If the CLI says Chrome still uses the dedicated profile, it intentionally
leaves `.wfm-cart.lock` in place. Do not remove it while any process uses
`~/.whole-foods-cart/chrome-profile`.

From the repository root, inspect first:

```bash
ps -axo pid=,command= | grep -- '--user-data-dir=.*/.whole-foods-cart/chrome-profile'
```

After confirming that no matching Chrome process remains, remove the lock from
the repository root only:

```bash
rm .wfm-cart.lock
```

## Manual verification

Use `docs/manual-test-runbook.md` for the short live verification sequence.
Do not remove a recovery lock until the repository-root inspect step shows no
Chrome process on the dedicated profile.
