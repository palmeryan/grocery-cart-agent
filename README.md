# Grocery Cart Agent

Turn recipes into a reviewed shopping list and a Whole Foods delivery cart.
This is an experimental local tool for macOS; supervise cart runs and review
the final cart before checking out yourself.

## Get started with Codex

Open Codex on your Mac, paste the project link, and tell it to set up:

> Set up https://github.com/palmeryan/grocery-cart-agent on my machine.

Codex handles downloading the project, checking and installing prerequisites,
installing dependencies, and running setup checks. You complete any sign-in
steps and choose your delivery address in the dedicated Whole Foods browser.
When you're ready to shop, ask Codex to help you enter recipes and review the
shopping list.

**For the setup agent:** obtain the linked project's source in a writable local
folder, then read [AGENTS.md](AGENTS.md) and follow its setup workflow. Reuse an
existing checkout without overwriting local changes. A source archive works
without Git. If the link is inaccessible, report that and ask for an accessible
source link; do not substitute another project. Run setup on the user's Mac,
where the browser and accounts will be used.

## How it works

Local cart runner using the Codex CLI and a Playwright/CDP harness. It exposes
four commands around the validated **Shopping List**:

1. `shopper-helper`: recipe documents → **Ingredients Agent** → deterministic
   compilation → mandatory interactive review → harness-operated cart.
2. `cart-build`: reviewed or prebuilt Shopping List → harness-operated cart.
3. `ingredients`: recipe documents → **Ingredients Agent** → deterministic
   compilation, without opening Chrome or running the cart harness.
4. `ingredients-review`: existing Shopping List → interactive review → a new
   cart-ready Shopping List, without opening Chrome or starting the cart.

The Ingredients Agent is the boundary for unstructured recipe input. It
extracts source-preserving ingredient facts, consistent purchasable identities,
and additive quantities. `src/shopping-list-compiler.ts` then derives
opaque intent IDs from source membership, consolidates matching identities,
and emits every extracted ingredient in the Shopping List consumed by the
cart harness. Each source recipe appears once in that list; ingredients refer
to the relevant recipes so cart decisions receive their full context.
Generated lists place consolidated items in a top-level `ingredients` array.

## Model isolation

Ingredients and cart-decision subprocesses receive task data through stdin and
run with a restricted Codex permission profile. Sandboxed commands cannot read
unrelated local files, write files, or access the network. Codex itself still
handles authentication, schema loading, and output writing. The runner forwards
only approved startup, authentication, proxy, and certificate environment
variables, and uses an empty working directory under the run folder.

Direct model capabilities such as shell, browser, web search, connectors,
plugins, hooks, and delegation are explicitly disabled. This configuration was
tested on Codex CLI 0.160.0; other versions warn and still run if they accept the
required settings. Unsupported settings fail without retrying with broader
permissions. Individual feature switches are not a universal tool allowlist;
new CLI capabilities require revalidation.

These restrictions apply to model subprocesses, not the coordinating Codex
agent, Node harness, or Chrome. Recipes and cart context supplied in the prompt
remain visible to the model. Free-form search retries remain an outbound channel
through the harness to Whole Foods. Supervise cart runs.

## Current outcome

The earlier dedicated-profile live smoke did not complete the cart workflow.
Later local work included a recipe-to-cart run that needed manual repairs.
Cart-matching acceptance runs (staples / ambiguous / substitutions, controlled
rerun, later-day persistence) remain to be performed. Treat this as an
experimental local tool and supervise cart runs.

The CLI owns a dedicated Chrome profile. Both its diagnostics and the cart harness
connect directly to that owned Chrome instance over localhost CDP. Readiness
requires authentication and the Whole Foods storefront. It does not inspect
delivery mode or require visible address text.

The build has a deterministic harness around a bounded per-item shopping decision.
The shell validates the Shopping List, owns the Chrome lifecycle and run lock,
independently confirms the Whole Foods storefront, records the baseline cart,
returns the tab to grocery search, and invokes a shopping decision for each list
item. It verifies the browser remains in the
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

Codex can install missing prerequisites during setup. These are the underlying
requirements, not steps you need to complete before handing it the link.

- macOS with Google Chrome
- Node.js 22.16.0 or newer
- Codex CLI supporting the isolation settings (tested on 0.160.0), signed into the intended ChatGPT account

Shopping decisions default to `gpt-5.6-terra` with medium reasoning effort.
Ingredients Agent settings remain fixed for recipe compilation.

All harness commands below run from the repository root.

## Manual setup

If you prefer to run setup yourself, download and extract the source or clone
the repository, then run these commands from the project folder:

```bash
npm ci
npm test
npm run typecheck
npm run lint
```

## Browser authentication

The cart command launches and owns a dedicated normal Chrome instance at
`~/.whole-foods-cart/chrome-profile`. It never attaches to the everyday Chrome
profile.

1. Run `npm run login`.
2. Sign in to Whole Foods Market and set your own delivery address and its
   available store context.
3. Close the dedicated Chrome window.
4. Run `npm run cart -- attachment-check` to verify deterministic Chrome/CDP
   startup against Example Domain without opening the storefront.
5. Run `npm run auth-check` to verify authentication and the storefront
   deterministically, without invoking Codex.
   Authentication is read from `/api/account/summary` using
   `customer.authenticated`; the check does not infer it from a name or header
   string.
6. After the auth check succeeds, choose one path:

```bash
# Full E2E from one or more recipe documents, including mandatory review
npm run shopper-helper -- monday-shawarma.md tuesday-braised-chicken-beans.md

# Or paste recipes into the interactive terminal editor
npm run shopper-helper

# Direct harness path from a prebuilt Shopping List
npm run cart-build -- path/to/shopping-list.json

# Ingredients Agent and compiler only
npm run ingredients -- monday-shawarma.md tuesday-braised-chicken-beans.md

# Review an existing list; output defaults to a unique runs/<run-id>/ folder
npm run ingredients-review -- path/to/shopping-list.json

# Choose a specific reviewed-list output path
npm run ingredients-review -- path/to/shopping-list.json --output runs/this-week.json

# Example decision-model override
npm run cart-build -- path/to/shopping-list.json --model gpt-5.6-luna --effort medium
```

With no recipe filenames, `shopper-helper` opens a terminal editor. Paste a
recipe, choose **Add recipe** for another, then choose **Make shopping list**
to continue through the Ingredients Agent, mandatory ingredient review, and
cart flow. Press Escape to cancel. Recipe text stays in memory and is included
in the normal run artifacts after compilation starts.

Recipe and cart runs print the current step and a 15-second heartbeat while a
step is still running. The heartbeat pauses while the shopping-list checklist
is open so it does not overwrite the review screen.

Accepted effort values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`,
`max`, and `ultra`. The selected model may support only a subset; Codex reports
an unsupported model/effort combination when the run starts.

Shopping Lists validate against `schemas/shopping-list.schema.json`. A full
recipe run saves its reviewed list as `runs/<run-id>/reviewed-shopping-list.json`,
along with its original generated list as `runs/<run-id>/shopping-list.json` and its
source-preserving intermediate as `runs/<run-id>/recipe-compilation.json`.
An ingredients-only run saves those same two compiled artifacts, plus the raw
Ingredients Agent output under `runs/<run-id>/ingredients-agent/`.
`ingredients-review` prints the path to its new cart-ready output; pass that
path to `npm run cart-build -- <path>`.
Both paths also write `runs/<run-id>/usage.json`, which rolls up every reported
Ingredients Agent and cart-decision turn (including retries). It shows cached and
uncached input, cache writes, output and reasoning tokens, cache rate, and a
clearly labeled public API list-price equivalent. That estimate is not a
statement of a ChatGPT subscription charge; pricing assumptions and caveats are
embedded in the file.
`runs/<run-id>/timings.json` records total wall time plus per-ingredient search,
decision, and interaction/confirmation time. Keep both files when comparing
this harness with earlier agent-driven runs. If a weighted product opens a
quantity chooser, the harness sends its estimated-weight options to the
decision model before the final Add; that second call appears in both files.

The CLI starts Chrome on demand and closes only the instance it launched.
If a cart or authentication check finds that sign-in or the storefront is not
ready, the CLI prints the specific reason and leaves that dedicated window open
so you can correct it manually. Close the window before retrying. Authentication
and the Whole Foods storefront are readiness requirements.
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

## Source downloads

Run `npm run release:source` to create a source archive and SHA-256 checksum
under `releases/`. The archive includes the current source files, including
uncommitted changes, examples, recipes, tests, and dependency lockfile. It
excludes Git history, browser profiles, run output, debug screenshots, and
historical design notes. Build downloads with this command instead of zipping
the working folder.

The archive includes `AGENTS.md`, so Codex can continue setup after extraction.
For manual setup, run `npm ci` from its top-level folder and follow the steps
above. Each user signs in with their own Codex and Whole Foods accounts.
Ingredients-only commands do not need Chrome or Whole Foods authentication.

See [release preparation](docs/release-preparation.md) for packaging and
verification.

## Disclaimers & Safety

- **Amazon Account & Conditions of Use:** This tool automates browser interactions with Whole Foods Market on Amazon using your personal credentials and session. Automated access to commercial storefronts may trigger bot detection, CAPTCHAs, or run afoul of Amazon's Conditions of Use. You run this tool entirely at your own risk with respect to your Amazon account.
- **Cart & Financial Responsibility:** This tool mutates your active shopping cart on a funded Amazon account. While the harness is explicitly constrained to stop before checkout and never accesses payment or order placement flows, automated selection can still select unexpected items, quantities, or package sizes. You are solely responsible for reviewing your cart items, quantities, substitutions, and total prices before completing checkout.

## License

Project code is available under the [MIT License](LICENSE). Third-party
dependencies and recipe content retain their respective terms.
