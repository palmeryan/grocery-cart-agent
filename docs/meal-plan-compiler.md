# Meal-plan compiler boundary

```text
unstructured recipes
  -> semantic ingredient extraction (agent)
  -> policy and integrity compilation (local code)
  -> purchase intents with provenance
  -> cart-agent tasks (future integration)
```

The compiler's product promise is an autonomous shopping plan that remains
traceable to every recipe. It is not merely a transcription layer, and it does
not choose live products or package sizes.

## Agent responsibility

The model resolves facts that require reading recipe language: independently
purchasable components, purchasable identity, verbatim amounts, preparation,
product-choice context, optionality, pantry status, and ordered substitutions.
Using a consistent purchasable identity across recipes is its consolidation
decision. Genuine, purchase-affecting uncertainty is attached to the relevant
ingredient with semantic priority and never stops the run.

The model does not produce recipe titles, servings, IDs, grouping keys,
purchase-intent objects, dispositions, or prose decision logs. Those fields
either do not affect the cart or are safer to derive locally.

## Deterministic responsibility

Local code validates source provenance, assigns structural source references,
groups matching purchasable identities, applies optional and pantry policy,
combines additive quantities and ranges, and emits the prioritized end-of-flow
decision log. The only public ID is an opaque purchase-intent ID derived from
its sorted source membership; model wording cannot change it. Pantry uncertainty
becomes `buy`; it is reported rather than blocking. Every source ingredient
remains in the recipe ledger and points to exactly one purchase intent,
including omitted optional and assumed-pantry items.

Pantry classification is role-based: ordinary seasoning fundamentals and
general-purpose cooking fats are assumed available when used supportively;
produce, proteins, and recipe-defining pantry products are purchases. The model
uses `uncertain` only when the recipe leaves that role or identity genuinely
ambiguous, not merely because actual household inventory is unknown.

Each extracted amount retains its verbatim source phrase and primary source
quantity separately from an additive quantity. The additive representation can
use source-stated package arithmetic or an explicitly supplied equivalent
measure, allowing compatible totals without losing the original count,
packaging, approximation, or range.

The cart-facing contract is
[`schemas/shopping-plan.schema.json`](../schemas/shopping-plan.schema.json).
The browser layer still consumes the legacy request contract; this work does
not change cart execution.
