export interface GroceryIngredient {
  id: string;
  request: string;
  preferences?: string[];
  context?: string;
  purchaseRequirement?: {
    total: ShoppingQuantity;
    optional: boolean;
    alternatives: RecipeIngredientAlternative[];
    sources: string[];
  };
}

export interface GroceryRecipe {
  id: string;
  name: string;
  servings?: number;
  context: string;
  ingredients: GroceryIngredient[];
}

/** Public input shared by the full recipe path and direct cart path. */
export type ShoppingList = {
  sourceRecipes?: { sourceName: string; text: string }[];
} & (
  | { ingredients: GroceryIngredient[]; recipes?: never }
  | { recipes: GroceryRecipe[]; ingredients?: never }
);


export interface RecipeIngredientQuantity {
  quantity: number;
  quantityMax: number | null;
  unit: string;
  approximate: boolean;
}

export type ShoppingQuantity = Omit<RecipeIngredientQuantity, "quantityMax">;

/** Source-facing and additive representations of one recipe amount. */
export interface RecipeIngredientAmount {
  raw: string;
  sourceQuantity: RecipeIngredientQuantity | null;
  additiveQuantity: ShoppingQuantity;
}

export interface RecipeIngredientAlternative {
  name: string;
  guidance: string;
}

export interface RecipeIngredientUnresolved {
  priority: DecisionPriority;
  message: string;
}

/** The recipe-facing side of the Ingredients Agent contract. */
export interface RecipeIngredientLine {
  sourceText: string;
  sourceOccurrence: number;
  componentIndex: number;
  name: string;
  amount: RecipeIngredientAmount;
  preparation: string | null;
  /** Only product-choice or substitution context needed by the cart agent. */
  context: string | null;
  optional: boolean;
  alternatives: RecipeIngredientAlternative[];
  unresolved: RecipeIngredientUnresolved[];
  purchaseIntentId: string;
}

export interface CompiledRecipe {
  sourceName: string;
  ingredients: RecipeIngredientLine[];
}

export interface PurchaseIntentSource {
  sourceName: string;
  sourceText: string;
  sourceOccurrence: number;
  componentIndex: number;
  context: string | null;
}

export type PurchaseIntentSourceRef = Pick<
  PurchaseIntentSource,
  "sourceName" | "sourceText" | "sourceOccurrence" | "componentIndex"
>;

export interface PurchaseIntent {
  id: string;
  primary: {
    name: string;
  };
  alternatives: RecipeIngredientAlternative[];
  sourceLines: PurchaseIntentSource[];
  sourceAmounts: RecipeIngredientAmount[];
  additiveAmount: ShoppingQuantity;
  optional: boolean;
}

export type DecisionPriority = "high" | "medium" | "low";

export interface CompilationDecision {
  priority: DecisionPriority;
  code:
    | "consolidated"
    | "unresolved_interpretation";
  message: string;
  sources: PurchaseIntentSourceRef[];
  purchaseIntentId: string;
}

/** Internal source-preserving result used to derive the public ShoppingList. */
export interface RecipeCompilation {
  contractVersion: 6;
  recipes: CompiledRecipe[];
  purchaseIntents: PurchaseIntent[];
  decisionLog: CompilationDecision[];
}


export type SelectionStatus = "added" | "already_present" | "skipped";

export type CartItemResultStatus = SelectionStatus | "failed";

export interface CartItemResult {
  ingredientId: string;
  requested: string;
  status: CartItemResultStatus;
  productName: string | null;
  productId: string | null;
  packageSize: string | null;
  quantity: number;
  price: string | null;
  rationale: string;
  confidence: "high" | "medium" | "low";
  failureReason: string | null;
}


export interface CartSelection {
  ingredientId: string;
  requested: string;
  status: SelectionStatus;
  productName: string | null;
  productId: string | null;
  packageSize: string | null;
  quantity: number;
  price: string | null;
  rationale: string;
  confidence: "high" | "medium" | "low";
}

export interface CartItemSnapshot {
  productName: string;
  productId?: string;
  quantity: number;
}

export interface CartReport {
  runStatus: "completed" | "partial" | "failed";
  verificationStatus: "confirmed" | "inconclusive" | "not_run";
  requestSha256: string;
  authenticated: boolean;
  wholeFoodsStorefrontConfirmed: boolean;
  baselineCartCount: number;
  baselineItems: CartItemSnapshot[];
  finalCartCount: number;
  finalCartDelta: CartItemSnapshot[];
  selections: CartSelection[];
  verificationNotes?: string[];
  failureReason: string | null;
}

export interface RunPaths {
  kind: "build" | "shopper-helper" | "ingredients" | "ingredients-review" | "auth-check" | "attachment-check";
  runId: string;
  runDir: string;
  shoppingListPath: string;
  reportPath: string;
}

export interface BrowserStopResult {
  stopped: boolean;
  remainingProfilePids: number[];
}

export interface OwnedChromeSession {
  pid: number;
  remoteDebuggingPort?: number;
  stop(): Promise<BrowserStopResult>;
}

export interface AuthReport {
  runStatus: "completed" | "failed";
  authenticated: boolean;
  wholeFoodsStorefrontConfirmed: boolean;
  failureReason: string | null;
}

export interface AttachmentReport {
  connected: boolean;
  url: "https://example.com/" | null;
  title: "Example Domain" | null;
  navigationPerformed: boolean;
  interactionPerformed: boolean;
  failureReason: string | null;
}
