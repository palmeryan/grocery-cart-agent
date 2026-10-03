# Working with Whole Foods Cart Builder

When the user asks to set up this project, carry out the workflow below on their
Mac. Handle commands and troubleshooting; involve the user for account login,
delivery context, and shopping-list review. For development tasks, work within
the requested scope rather than starting onboarding.

These setup steps are for the coordinating agent. Ingredients and cart-decision
model subprocesses should perform only their supplied task and output schema;
they must not install software, start onboarding, or invoke another shopping run.

## 1. Establish the project and prerequisites

- Obtain the source from the user's link in a writable project folder. Reuse an
  existing checkout and preserve local changes. Extracted downloads need no Git
  for installation or shopping; Git is needed only to build source releases.
- Read `README.md`, `package.json`, and `src/config.ts`. Run project commands
  from this folder. Current onboarding supports macOS; report other platforms
  as unsupported instead of claiming the macOS browser flow will work there.
- Check `node --version`, `npm --version`, `codex --version`, and the Chrome
  executable. Node must be at least 22.16.0 and Codex CLI at least 0.154.0.
  Verify `codex exec --help` supports the flags used in `src/codex.ts` and
  `src/cart-decision.ts`; a version number alone is not a compatibility check.
- Install missing prerequisites using official distributions and an existing
  user-managed package manager when available. Prefer user-writable installs;
  follow the environment's approval requirements if installation is restricted.
  Reuse working software and do not replace system runtimes or change global
  Codex settings just to set up this project.
- For Codex CLI installation, use the current
  [official installation instructions](https://learn.chatgpt.com/docs/codex/cli).
  An existing CLI may already work even if it was not installed separately.
  If its executable is outside PATH, set `CODEX_BIN` for project commands.
- Default Chrome is `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`.
  `CHROME_EXECUTABLE` overrides harness launches; `npm run login` still uses the
  macOS app named Google Chrome. Resolve that difference if Chrome is elsewhere.

## 2. Verify CLI authentication and install dependencies

- Run `codex login status`. Do not assume desktop sign-in authenticates the CLI.
  If necessary, initiate `codex login` and let the user finish browser sign-in,
  then check status again. Follow
  [official authentication guidance](https://learn.chatgpt.com/docs/auth).
  Never read, print, copy, or ask the user to paste credentials or auth caches.
- Run `npm ci`, then `npm test`, `npm run typecheck`, and `npm run lint`.
  Finish installation before running checks: `npm ci` replaces `node_modules`.
  Reuse a healthy existing install during repeat setup instead of reinstalling
  while another project process is using it.
- Model defaults are in `src/codex.ts` and `src/cart-decision.ts`. Ingredients
  settings are fixed; `--model` and `--effort` override only cart decisions.
  Login success and offline tests do not prove model access. If a real model
  run rejects the configured model or CLI flags, report the precise limitation
  rather than silently editing defaults or retrying indefinitely.

## 3. Connect the dedicated Whole Foods browser

For ingredients-only requests, skip this section and keep Chrome closed.

1. Run `npm run cart -- attachment-check`. It checks owned Chrome/CDP startup
   against Example Domain without invoking a model or touching the cart.
2. Run `npm run login`. Let the user sign in to their Whole Foods account, set
   their own delivery address, select delivery mode, and open the storefront.
   Example names, ZIP codes, and stores are not required account settings.
3. Have the user close the dedicated browser, then run `npm run auth-check`.
   This checks authentication and delivery context without model calls or cart
   mutations. If it leaves Chrome open for correction, let the user fix the
   context, close the window, and retry.

Use only `~/.whole-foods-cart/chrome-profile` or the explicitly configured
`WFM_CHROME_PROFILE_DIR`. Never attach to or copy the everyday Chrome profile.
If a retained lock blocks a retry, inspect its owner PID and processes using the
actual configured profile. Prefer the CLI's conservative automatic stale-lock
recovery. Keep the lock when ownership is uncertain; do not delete it or kill
unrelated Chrome processes to force a run. See `README.md` for manual recovery.

## 4. Finish setup and help with the first run

Report the project folder, checks passed, and any remaining login or model-access
limitations. Setup alone does not authorize adding groceries. Once the user asks
to shop, use `npm run shopper-helper` in a visible interactive terminal. The user
pastes recipes, chooses **Add recipe** between them, **Make shopping list**, then
reviews ingredients before **Start cart**. Escape cancels recipe entry before
an ingredients run starts. Keep the review interactive; do not accept it for the
user. If your terminal cannot expose this UI, open a user-facing terminal in the
project folder and give them the single command there.

Existing recipe files also work with `npm run shopper-helper -- <files...>`.
For compilation alone, use `npm run ingredients -- <files...>`; for review alone,
use `npm run ingredients-review -- <shopping-list.json>`. Keep those requests
within their requested boundary. Inputs are plain recipe text, not PDF parsing.

Supervise live cart runs. The harness owns browser operations and cart mutation
verification; use its reports rather than adding items through a separate browser
workflow. Never enter checkout, place orders, or change payment/account settings.
The user reviews the actual final cart and completes checkout themselves.

## Verification and artifacts

- Follow `docs/manual-test-runbook.md` for live verification. Offline checks and
  `auth-check` do not establish live recipe-to-cart reliability. Report skipped
  browser tests and an `inconclusive` final verification plainly.
- Keep `runs/`, browser state, logs, and session data local. Run artifacts can
  contain recipes, cart responses, and account context; do not publish them as
  examples without reviewing and redacting them.
- For source downloads, run `npm run release:source` from a Git checkout, inspect
  its contents, and verify its checksum from `releases/`. Include `AGENTS.md`
  and `LICENSE`. Do not publish or change repository visibility during setup.
