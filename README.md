# Whole Foods Cart Builder

Local cart runner using the Codex CLI and a Playwright/CDP harness. It exposes
two paths that converge on the same validated **Shopping List**:

1. `cart-recipes`: recipe documents → **Ingredients Agent** → deterministic
   compilation → Shopping List → harness-operated cart.
2. `cart-list`: prebuilt Shopping List → harness-operated cart.

The Ingredients Agent is the boundary for unstructured recipe input. It
extracts source-preserving ingredient facts, consistent purchasable identities,
and additive quantities. `src/shopping-list-compiler.ts` then derives
opaque intent IDs from source membership, applies pantry and optional policy,
consolidates matching identities, and emits the Shopping List consumed by the
cart harness. The richer recipe compilation is saved alongside the run for
provenance and debugging.

## Current outcome

The earlier dedicated-profile live smoke did not complete the cart workflow.
Cart-matching acceptance runs (staples / ambiguous / substitutions, controlled
rerun, later-day persistence) remain to be performed.

The CLI owns a dedicated Chrome profile. Both its diagnostics and the cart harness
connect directly to that owned Chrome instance over localhost CDP. Readiness
requires authentication, delivery mode, and the Whole Foods storefront; it does
not inspect or require visible address text.

The build has a deterministic harness around a bounded per-item shopping decision.
The shell validates the Shopping List, owns the Chrome lifecycle and run lock,
independently confirms delivery mode and the Whole
Foods storefront, records the baseline cart, returns the tab to grocery search, and invokes
one shopping decision for each list item, verifies the browser remains in the
shopping flow after every decision, and performs one deterministic final
cart verification. The decision model chooses among observed product cards,
requests a better search, identifies an existing item, or skips. The harness
operates controls and confirms each mutation from cart responses. Degraded cart
extraction before mutation fails the run because the baseline cannot safely
prevent duplicates. Final reconciliation is reported independently as
`verificationStatus`: a mismatch or degraded final read is `inconclusive`,
does not rewrite a successfully completed decision outcome, and leaves Chrome
open for inspection. Execution failures and safety-boundary violations still
return a nonzero exit.

## Operating limits

The decision model receives storefront observations as data and ignores
instructions embedded in product text. The harness only operates allowlisted
Whole Foods pages and never enters checkout, payment, or account settings. An
ambiguous page or cart mutation stops with diagnostics and leaves Chrome open.

Use the dedicated test profile. Local output in `runs/` is gitignored because it
contains run diagnostics and may include active browser-session details.

## Prerequisites

- macOS with Google Chrome
- Node.js 22.16.0 or newer
- Codex CLI 0.154.0 or newer, signed into the intended ChatGPT account

Shopping decisions default to `gpt-5.6-terra` with medium reasoning effort.
Ingredients Agent settings remain fixed for recipe compilation.

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
2. Sign in to Whole Foods Market and confirm the account is in delivery mode
   with Lamar as the store context.
3. Close the dedicated Chrome window.
4. Run `npm run cart -- attachment-check` to verify deterministic Chrome/CDP
   startup against Example Domain without opening the storefront.
5. Run `npm run auth-check` to verify authentication and delivery context
   deterministically, without invoking Codex.
   Authentication is read from `/api/account/summary` using
   `customer.authenticated`; the check does not infer it from a name or header
   string.
6. After the auth check succeeds, choose one path:

```bash
# Full E2E from one or more recipe documents
npm run cart-recipes -- recipe-one.md recipe-two.md

# Direct harness path from a prebuilt Shopping List
npm run cart-list -- path/to/shopping-list.json

# Example decision-model override (works with cart-list or cart-recipes)
npm run cart-list -- path/to/shopping-list.json --model gpt-5.6-luna --effort medium
```

Accepted effort values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`,
`max`, and `ultra`. The selected model may support only a subset; Codex reports
an unsupported model/effort combination when the run starts.

Shopping Lists validate against `schemas/shopping-list.schema.json`. A full
recipe run saves its generated list as `runs/<run-id>/shopping-list.json` and its
source-preserving intermediate as `runs/<run-id>/recipe-compilation.json`.
Both paths also write `runs/<run-id>/usage.json`, which rolls up every reported
Ingredients Agent and cart-decision turn (including retries). It shows cached and
uncached input, cache writes, output and reasoning tokens, cache rate, and a
clearly labeled public API list-price equivalent. That estimate is not a
statement of a ChatGPT subscription charge; pricing assumptions and caveats are
embedded in the file.
`runs/<run-id>/timings.json` records total wall time plus per-ingredient search,
decision, and interaction/confirmation time. Keep both files when comparing
this harness with earlier agent-driven runs.

The CLI starts Chrome on demand and closes only the instance it launched.
If a cart or authentication check finds that sign-in or delivery context is not
ready, the CLI prints the specific reason and leaves that dedicated window open
so you can correct it manually. Close the window before retrying. Authentication
and delivery context are readiness requirements; the separate safety checks are
the checkout and account/settings boundaries.
The harness connects directly to the owned Chrome over localhost CDP. It does
not start a model browser tool server or require a second browser window. Do not
publish an artifact containing a live session token.

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
