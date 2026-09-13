export interface GroceryIngredient {
  id: string;
  request: string;
  preferences?: string[];
}

export interface GroceryRecipe {
  id: string;
  name: string;
  servings: number;
  context: string;
  ingredients: GroceryIngredient[];
}

export interface GroceryRequest {
  recipes: GroceryRecipe[];
}

export type SelectionStatus = "added" | "already_present" | "skipped";

export interface CartSelection {
  ingredientId: string;
  requested: string;
  status: SelectionStatus;
  productName: string | null;
  packageSize: string | null;
  quantity: number;
  price: string | null;
  rationale: string;
  confidence: "high" | "medium" | "low";
}

export interface CartItemSnapshot {
  productName: string;
  quantity: number;
}

export interface CartReport {
  runStatus: "completed" | "partial" | "failed";
  requestSha256: string;
  authenticated: boolean;
  expectedLocationConfirmed: boolean;
  wholeFoodsStorefrontConfirmed: boolean;
  checkoutVisited: boolean;
  settingsChanged: boolean;
  baselineCartCount: number;
  baselineItems: CartItemSnapshot[];
  finalCartCount: number;
  finalCartDelta: CartItemSnapshot[];
  selections: CartSelection[];
  failureReason: string | null;
}

export interface RunPaths {
  runId: string;
  runDir: string;
  requestPath: string;
  reportPath: string;
  eventsPath: string;
  stderrPath: string;
  browserOutputDir: string;
}
