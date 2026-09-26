# Ingredients Agent boundary

```text
unstructured recipes
  -> semantic ingredient extraction (agent)
  -> policy and integrity compilation (local code)
  -> consolidated purchase intents
  -> Shopping List with recipe text once and ingredient-to-recipe references
  -> Cart Agent tasks
```

The compiled Shopping List keeps each source recipe once and links each
ingredient to the recipes the Cart Agent needs for product decisions. It does
not choose live products or package sizes.
Its top-level `ingredients` array contains the consolidated items.

## Agent responsibility

The model resolves facts that require reading recipe language: independently
purchasable components, purchasable identity, verbatim amounts, preparation,
product-choice context, optionality, and ordered substitutions.
Using a consistent purchasable identity across recipes is its consolidation
decision. Genuine, purchase-affecting uncertainty is attached to the relevant
ingredient with semantic priority and never stops the run.

The model does not produce recipe titles, servings, IDs, grouping keys,
purchase-intent objects or prose decision logs. Those fields
either do not affect the cart or are safer to derive locally.

## Deterministic responsibility

Local code validates source provenance, assigns structural source references,
groups matching purchasable identities, includes every extracted ingredient,
combines chosen shopping quantities, and emits the prioritized end-of-flow
decision log. The only public ID is an opaque purchase-intent ID derived from
its sorted source membership; model wording cannot change it. Every source
ingredient remains in the recipe ledger and points to exactly one purchase
intent, including seasonings, cooking fats, and optional ingredients. The user
removes unneeded products from the cart.

Each extracted amount retains its verbatim source phrase and primary source
quantity separately from an additive quantity for that source line. The
additive representation can use package arithmetic, ordinary culinary
conversions, or contextual quantity inference, marked approximate where
appropriate. It chooses one amount when the recipe gives a range; the original
wording remains in the source quantity. The local compiler adds these chosen
line quantities and rounds whole-item counts up to the number to buy.

The direct Cart Agent contract is
[`schemas/shopping-list.schema.json`](../schemas/shopping-list.schema.json).
The detailed recipe compilation is validated against
[`schemas/recipe-compilation.schema.json`](../schemas/recipe-compilation.schema.json)
and saved with the run.
