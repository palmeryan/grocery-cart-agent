# Whole Foods Cart Builder POC

Local feasibility harness using the Codex CLI and Microsoft Playwright MCP to
turn recipe JSON into a Whole Foods delivery cart. This repository records
earlier incomplete dedicated-profile results and the current attached-browser
workflow. The first successful end-to-end cart run is still outstanding.

## Current outcome

The earlier dedicated-profile live smoke failed because Amazon authentication
did not persist into Playwright MCP after a clean manual sign-in. Cart-matching
acceptance runs (staples / ambiguous / substitutions, controlled rerun,
later-day persistence) were not performed.

The CLI owns a dedicated Chrome profile and attaches through the official
Playwright MCP Browser Extension. The account's saved default address is the
delivery context; Lamar is the intended Whole Foods store. Treat the commands
below as the harness entrypoint until a live end-to-end run succeeds.

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

## Attached browser authentication

The cart command launches and owns a dedicated normal Chrome instance at
`~/.whole-foods-cart/chrome-profile`. It never attaches to the everyday Chrome
profile.

1. Run `npm run login`.
2. In that dedicated Chrome profile, install Microsoft's official Playwright
   MCP Browser Extension.
3. Sign in to Amazon and confirm the account's saved default address is the
   intended Whole Foods delivery address, with Lamar as the store context.
4. Copy the extension token, then run `npm run setup-extension-token`. Paste
   the token only into the hidden macOS Keychain prompt.
5. Close the dedicated Chrome window.
6. Run `npm run cart -- attachment-check` to verify the extension against
   Example Domain without opening Amazon.
7. Run `npm run auth-check`.
8. After the auth check succeeds, run
   `npm run cart -- build path/to/request.json`.

The CLI starts Chrome on demand and closes only the instance it launched.
The extension token is retrieved by the local shim from Keychain and is not
passed in the recipe prompt or command arguments. Browser-tool connection
details can still appear in tool output and saved run artifacts; treat those
outputs as sensitive and do not commit or upload them.

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
