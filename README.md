# Whole Foods Cart Builder

Local cart runner using the Codex CLI and Microsoft Playwright MCP to turn
recipes into a Whole Foods delivery cart. The **Ingredients Agent** reads recipe
documents and produces the structured, versioned ingredient list (`ShoppingPlan`).
The **Cart Agent** accepts that list and uses one dedicated Chrome session with
one fresh browser-enabled invocation per ingredient.

The Ingredients Agent is the boundary for unstructured recipe input. It
extracts source-preserving ingredient facts, consistent purchasable identities,
and additive quantities. `src/meal-plan.ts` then derives
opaque intent IDs from source membership, applies pantry and optional policy,
consolidates matching identities, and produces a versioned shopping plan with
provenance and a prioritized decision log. The browser layer is not yet switched
over to this contract; the existing request/report path remains compatible while
the plan contract is validated against real recipe sources.

## Current outcome

The earlier dedicated-profile live smoke did not complete the cart workflow.
Cart-matching acceptance runs (staples / ambiguous / substitutions, controlled
rerun, later-day persistence) remain to be performed.

The CLI owns a dedicated Chrome profile. Both its diagnostics and the Cart Agent
connect directly to that owned Chrome instance over localhost CDP. The expected
visible delivery address defaults to `43214` for the Ryan/Lamar setup and can be
set with `WFM_EXPECTED_DELIVERY_ADDRESS`.

The build has a deterministic shell around an adaptive per-ingredient Cart Agent.
The shell validates the request, owns the Chrome lifecycle and run lock,
configures Playwright MCP, independently confirms delivery mode and the expected
address, records the baseline cart, returns the tab to grocery search, invokes
one fresh Cart Agent for each ingredient, and performs one deterministic final
cart verification. The Cart Agent interprets recipe context, searches, chooses
products or sensible substitutions, and handles the live add flow. There is no
deterministic candidate-search or product-selection pass. Degraded cart
extraction or a final verification mismatch fails closed with a nonzero exit;
the harness does not retry the ingredient or rewrite the Cart Agent selection.

## Operating limits

The Cart Agent is instructed to build a delivery cart, preserve unrelated items, and
stop before checkout or order submission. These are prompt instructions, not a
browser-enforced checkout block. Supervise the first end-to-end run and use
`Ctrl-C` if needed.

Use the dedicated test profile. Local output in `runs/` is gitignored and may
contain account information and connection tokens; keep it local.

## Prerequisites

- macOS with Google Chrome
- Node.js 22.16.0 or newer
- Codex CLI 0.154.0 or newer, signed into the intended ChatGPT account

The cart runner explicitly uses the Codex `gpt-5.6-terra` model with low
reasoning effort for each Cart Agent invocation.

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
