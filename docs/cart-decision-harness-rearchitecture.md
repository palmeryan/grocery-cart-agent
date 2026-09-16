# Cart Decision Harness Re-architecture

- Date: 2026-09-16
- Status: Proposed; no implementation in this branch
- Scope: Shopping List → Whole Foods cart. Recipe extraction and compilation remain separate.

## Decision

Replace the per-ingredient LLM browser agent with a harness-operated storefront and a bounded LLM **shopping decision** interface. The harness searches, reads the page, operates controls, observes cart mutations, and writes results. The model decides which listed product and purchase quantity satisfy an ingredient, whether to search again, or whether no defensible choice exists.

The model does not locate text fields, type, click, navigate, inspect an add it just made, or report that an add succeeded. A verified cart mutation is the completion event for an addition.

This is a local, single-operator tool. A Whole Foods page change may stop a run; the intended recovery is for the operator to inspect the run evidence, update the harness, and retry only after establishing the cart's actual state. Unattended recovery and automatic adaptation are not requirements.

## Why change

Today `src/cli.ts` launches a fresh Codex process with Playwright MCP for each ingredient. The prompt in `prompts/cart-agent.md` asks the model to search, inspect, choose, click, and return an `added` result. `src/cart-network.ts` observes full-cart POSTs, but `src/cli.ts` reconciles them only **after** the agent exits. This spends model turns on mechanical page operations and on describing an outcome the harness can observe directly.

The harness already connects to the owned Chrome instance through Playwright/CDP for authentication, cart inspection, page preparation, and network observation. Giving it the search and add interactions does not require a second browser or a new source of storefront evidence. The product list sent to the model should contain the same result-card information the browser agent currently reads with `browser_evaluate`.

## First-build scope

Implementation status (2026-09-16): the harness/decision path is built and the
old browser-enabled cart agent path is removed. Automated checks pass; live
Whole Foods cart acceptance and before/after speed/cost comparison are still
pending.

Keep the existing Shopping List, Ingredients Agent, browser ownership, authentication, and final report. Replace only the cart middle: search and add are harness operations; product and quantity choice remain model judgments. Process ingredients sequentially in one browser, with one final cart check. Do not enter checkout or change account/fulfillment settings. Do not build browser-agent recovery, a persistent site-interaction config, or automatic repair. Compare latency and tokens with the current runner after a live smoke; speedup is a hypothesis, not an acceptance substitute for correct cart contents.

## Responsibility boundary

| Responsibility | Owner |
| --- | --- |
| Own Chrome, authentication, delivery context, run lock, and baseline cart | Harness |
| Enter search query, wait for results, extract cards/options | Harness |
| Judge product fit, substitution, and desired purchase quantity | LLM |
| Request a revised query when results are poor | LLM |
| Validate the chosen ID against the current result set | Harness |
| Operate add, variant, and quantity controls | Harness |
| Observe full-cart mutation and derive actual quantity delta | Harness |
| Record `added`, advance to next ingredient, and reconcile final cart | Harness |

The LLM sees storefront observations as data and has no Playwright MCP tools on the cart path.

## Per-ingredient flow

1. The harness takes the next ingredient and current cart snapshot, starts watching cart responses, and searches Whole Foods. Use the existing `request` as the initial query; the model may request another query if results are poor.
2. The harness extracts the visible result cards: ASIN, name, size/options, price, availability, and relevant card text. The model receives these with the ingredient, recipe context, and cart context. It returns `select(candidateId, quantity, option?)`, `search_again(query)`, `already_present(cartProductId)`, or `skip(reason)`.
3. The harness checks that the selected ID belongs to the current results (or that an `already_present` ID is in the cart), then uses the associated product and quantity controls. If it cannot read or operate a necessary control, it stops with diagnostics; it does not ask a browser agent to improvise.
4. A successful full-cart response showing the selected ASIN's intended increase completes the ingredient. The harness derives `added` and product metadata from the observed mutation and card, then moves on without another model call. Weighted quantities must be compared in the units WFM actually reports. One final cart reconciliation closes the run.

If a click may have committed but the cart effect is unknown, stop and inspect the cart before retrying. Never repeat the click merely because the UI or response timed out.

## Decision and evidence contracts

Use one strict decision schema, separate from the existing final-result schema. A model choice is not an `added` claim. Keep the public report contract unchanged in the first build; the harness fills it from the chosen card and confirmed cart delta. The page adapter resolves the ASIN back to its current card before clicking, rather than trusting a stale position or model-generated element reference. Send the model the same product-card evidence available to today's browser agent, but not account data or raw cart responses.

## Failure and retry behavior

- **Before mutation:** an invalid model decision or unreadable page stops the ingredient; a poor search may be retried with a model-supplied query. The harness never selects a substitute itself.
- **During or after mutation:** an unknown control, timeout, malformed cart response, or unrelated cart change stops the queue. Re-read cart state before any manual retry. Do not automatically click again.
- **Account or delivery context changed:** stop; the model does not repair settings.

### Operator diagnostic contract

On a stopped run, print the ingredient, failed stage, whether an add may have committed, and artifact path. Save the current URL, last harness action, selected candidate/quantity, page snapshot or screenshot, model decision, baseline cart, and latest parsed cart response or parse error. Keep artifacts gitignored and omit credentials/account responses. Leave the owned browser available when an uncertain add needs inspection.

The operating standard is **clear failure with recoverable evidence**, not automatic completion across arbitrary WFM changes. After fixing an adapter, add the observed page shape as a regression fixture before retrying the shopping run.

## Implementation sequence

1. Build the search/result-card adapter and compare its output with saved MCP result-card evidence.
2. Add the model decision schema and invocation without browser tools.
3. Add the ASIN-targeted executor, cart-response completion, and failure artifacts; integrate them into the existing sequential runner.
4. Remove the old cart-agent prompt/MCP path and update docs and usage accounting before live acceptance. Do not keep two production cart paths.

Keep these as reviewable increments, with a line-count/scope audit before merging a large implementation.

## Verification and acceptance

Automated fixtures must cover product choice, search retry, existing items, weighted/quantity controls, stale IDs, and uncertain cart mutations. Assert that the model cannot call browser tools or claim `added`, the harness cannot click an unobserved candidate, and a confirmed mutation advances without another model call. A changed page must either work or stop with the diagnostic contract above; silent misselection is unacceptable.

Use captured storefront evidence to check decision quality, not only JSON validity. Then run a supervised live smoke on the dedicated profile with a small, known Shopping List: inspect the baseline first, verify the selected product and quantity, watch the mutation, and compare the final cart. Stop before checkout. A passing unit suite or CDP attachment check is not live cart acceptance.

Record per-ingredient model calls/tokens, browser operations, and time to confirmed mutation. Compare equivalent items with the current runner. Establish weighted-item cart units from captured evidence before enabling those adds; do not guess a conversion.
