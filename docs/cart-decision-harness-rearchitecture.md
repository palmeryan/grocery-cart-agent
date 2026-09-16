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

The harness already connects to the owned Chrome instance through Playwright/CDP for authentication, cart inspection, page preparation, and network observation. Giving it the search and add interactions does not require a second browser or a new source of storefront evidence. The product list sent to the model should contain the same result-card information the browser agent currently reads with `browser_evaluate`, with a bounded request for more detail if needed.

## Goals

- Keep product and quantity judgment adaptive; do not reinstate deterministic product ranking or substitution policy.
- Move all routine browser operation and success detection into the harness.
- Preserve source ingredient text, recipe context, preferences, and baseline/prior cart context in model decisions and reports.
- Use the observed cart delta, not model testimony or a changed button label, as proof of an add.
- Continue through ingredients sequentially in one owned browser session, with one final cart reconciliation and no per-item cart-page navigation.
- Reduce browser-tool turns, model tokens, elapsed time, and duplicate-add risk; measure rather than assume the size of each improvement.
- Keep checkout, order, account, address, payment, and fulfillment changes outside the executor's permitted actions.

## Non-goals

- No checkout or order submission.
- No new deterministic rule that chooses products for the model.
- No browser-agent handoff, self-updating interaction config, or automatic repair when an interaction is unsupported.
- No change to the Ingredients Agent or recipe compiler in the first implementation slice.
- No assumption that a successful click, HTTP 200 alone, or model output proves cart contents.

## Responsibility boundary

| Responsibility | Owner |
| --- | --- |
| Own Chrome, authentication, delivery context, run lock, and baseline cart | Harness |
| Enter search query, wait for results, extract cards/options | Harness |
| Judge product fit, substitution, and desired purchase quantity | LLM |
| Request a revised query or more product detail when needed | LLM |
| Validate the chosen ID against the current result set | Harness |
| Operate add, variant, and quantity controls | Harness |
| Observe full-cart mutation and derive actual quantity delta | Harness |
| Record `added`, advance to next ingredient, and reconcile final cart | Harness |

This is **decision automation**, not an LLM-controlled browser. The LLM sees storefront observations as data and returns a constrained choice; it receives no Playwright MCP tools for the cart path.

## Per-ingredient flow

1. The harness takes the next Shopping List ingredient and current cart snapshot. It attaches the cart-response observer before any possible mutation.
2. It searches Whole Foods using the ingredient's `request` verbatim as the initial query. The current Shopping List has no separate normalized search term; do not silently strip quantities or preferences. The model can request a more useful query after seeing results. A later schema change may add an explicit search term if evidence warrants it.
3. It extracts a bounded result set with stable candidate IDs (ASINs), displayed name, size/variant, price and unit price when shown, availability, purchase controls, and product URL. Keep the raw card text or a bounded detail-read path for information the structured fields miss. Label missing fields as missing; do not invent them.
4. The model receives the ingredient and recipe/cart context plus these candidates. It returns one of:
   - `select(candidateId, purchaseQuantity, option?)`
   - `search_again(query)`
   - `inspect(candidateId, question)` for a product detail or option not in the list
   - `already_present(cartProductId)`
   - `skip(reason)` or `blocked(reason)`
5. The harness validates the decision. A selected ID must be present in the current observation and available; a claimed existing ID must be in the baseline/current cart. Search and detail requests have bounded budgets. Invalid decisions are reported as such, not treated as clicks.
6. For `select`, the harness records the chosen card metadata, performs only that product's add/quantity interaction, and observes cart responses. If a variant or weighted-item option requires a judgment absent from the decision, it returns that option set to the model and resumes execution after a choice.
7. The ingredient completes only when a successful **full-cart** response shows the chosen ASIN increased by the intended amount, with no unexplained change to other cart items. A weighted item's recorded cart quantity may be fractional; compare using the product's actual purchase-unit semantics rather than assuming every item is an integer count. If multiple commits are needed, track the cumulative delta and stop at the requested target. Do not issue another add while an earlier mutation is unresolved.
8. The harness constructs `added` from the confirmed mutation plus captured product metadata, records progress, and proceeds to the next ingredient. It does not ask the model to confirm success. At the end, it performs final cart reconciliation once.

The executor's result should distinguish `added`, `already_present`, `skipped`, and `failed` from `unverified_mutation`: the latter means a click may have changed the cart but no authoritative response established the outcome. Stop the queue and inspect the cart before any retry; blindly repeating the add could duplicate it.

## Decision and evidence contracts

Define a strict, versioned decision schema separate from the existing `cart-agent-result` schema. The model's `select` output refers to a harness-issued candidate ID/ASIN and purchase quantity; it is **not** a final cart result. The harness, not the model, fills product name, ID, package size, displayed price, and actual cart delta in the result. A short selection reason is useful for substitutions or ambiguity; an exact match can have a harness-generated factual reason rather than requiring post-add prose.

Candidate observations should be structured JSON with a stable ID and the visible evidence the current MCP result would expose. Store bounded, redacted observation/decision records in the run artifact directory for debugging. Never send authentication data, raw account responses, or cart-response bodies to the model. Treat product titles and card text as untrusted storefront data, not instructions.

Do not tie correctness to one CSS selector or a model-generated click reference. The page adapter should resolve a selected ASIN back to its current card, verify the intended control is associated with that card, and report an explicit extraction/interaction error if the page changed. Product-detail and variant observations use the same bounded data interface.

## Failure and retry behavior

- **No results or poor results:** the model may requery within a fixed budget, then skip with a reason. The harness never substitutes a product on its own.
- **Unknown variant or quantity control:** present the options to the model if the harness can still operate the controls and only a choice is missing; otherwise stop with `unsupported_interaction` and diagnostic evidence.
- **Ambiguous cart response, unrelated cart delta, or missing response:** stop the current queue. Re-read the cart to establish actual state before deciding whether a retry is safe.
- **Model timeout/invalid output:** retry the decision call only, within a small bound. No browser mutation has occurred at that point.
- **Add interaction timeout:** do not repeat the click until cart state is established. A timed-out click may still have committed.
- **Authentication or delivery-context change:** stop; do not let the model repair account or fulfillment settings.

Use concrete outcome names in implementation and diagnostics. Avoid a generic `safe` flag that conflates navigation, cart verification, and executor errors.

### Operator diagnostic contract

On a stopped run, print the failed ingredient, failed stage (search, extraction, decision, interaction, or cart confirmation), and run-artifact path. Save enough local evidence to diagnose a site change without repeating the add: current URL, timestamp, last completed harness action, the selected candidate/quantity if any, a bounded page snapshot or screenshot, relevant element/control observations, the model decision, baseline cart, and the latest parsed cart response or parse error. Keep run artifacts gitignored and avoid writing credentials or full account responses. If an add may have committed, report that explicitly and leave the owned browser available for inspection; do not automatically click again.

The operating standard is **clear failure with recoverable evidence**, not automatic completion across arbitrary WFM changes. After fixing an adapter, add the observed page shape as a regression fixture before retrying the shopping run.

## Implementation sequence

1. **Observation seam:** add a tested Whole Foods search-page adapter returning candidate observations and product-detail/variant observations. Compare its output with the existing MCP `browser_evaluate` evidence from saved runs. No cart mutation in this step.
2. **Decision interface:** add the strict schema, prompt, model invocation without Playwright MCP, and validation for IDs, quantities, requery bounds, and existing-cart claims. Keep selection policy in the model.
3. **Executor and observer:** add ASIN-targeted add/quantity operations and invocation-scoped cart-mutation tracking. Tie each observed delta to the current selected ASIN and baseline; handle fractional weighted quantities and uncertain commits.
4. **Runner integration:** switch the build path to the decision loop, retain existing Chrome/preflight/lock/final-report behavior, and remove per-ingredient Codex/Playwright MCP startup. Synthesize successful selection results from evidence.
5. **Contract cleanup:** remove the old browser-agent prompt/schema and post-hoc `added` reconciliation once the new path passes acceptance. Update README, runbook, usage accounting, and report terminology. Avoid maintaining two production cart paths indefinitely.

Keep these as reviewable increments, with a line-count/scope audit before merging a large implementation.

## Verification and acceptance

Automated fixtures should cover exact products, substitutions, no suitable item, already-present items, multiple sizes, weighted/quantity-selector products, unavailable cards, stale candidate IDs, search retry, model timeout, click timeout, delayed POST, malformed/partial cart payload, unrelated cart changes, and a committed add whose response arrives after a UI timeout. Assert that the model cannot call browser tools or claim `added`, that the executor cannot click a candidate not in the current observation, and that a successful mutation advances the queue without another model call. Changed labels or card structure should either still work or stop with the diagnostic contract above; silent misselection is unacceptable.

Use captured storefront evidence to check decision quality, not only JSON validity. Then run a supervised live smoke on the dedicated profile with a small, known Shopping List: inspect the baseline first, verify the selected product and quantity, watch the mutation, and compare the final cart. Stop before checkout. A passing unit suite or CDP attachment check is not live cart acceptance.

Record per-ingredient model calls/tokens, browser operations, time from search to confirmed mutation, and total run time. Compare with the current browser-agent run on equivalent items; report medians and failure categories, not a promised speedup.

## Open implementation decisions

- Which current Whole Foods response fields, if any, can supply name/size/price more reliably than the product card? Inspect real, redacted payload shapes before binding parsers to them.
- What unit and tolerance represent a weighted-item target in each observed control/POST shape? Establish from fixtures and a supervised live example.
- Should an explicit normalized `searchTerm` be added to Shopping List later? Start with the existing request plus model-directed requery, then decide from observed search failures.
- Does the final report need the old `rationale`/`confidence` fields for every addition, or only a concise reason for non-obvious selections? Resolve with report consumers before changing the public schema.

These questions refine the interface; they do not change the owner of browser operation or successful-add detection.
