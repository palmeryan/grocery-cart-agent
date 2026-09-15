/**
 * @deprecated Compatibility exports for the pre-rename recipe agent API.
 * New code should import from ingredients-agent.ts.
 */
export {
  assertDraftMatchesDocuments,
  runIngredientsAgent as runMealPlanCompiler,
  compileIngredientsList as compileRecipeDocuments,
} from "./ingredients-agent.js";
export type {
  RecipeDocument,
  IngredientsAgentInvocation as MealPlanCompilerInvocation,
  InvokeIngredientsAgent as InvokeMealPlanCompiler,
  RunIngredientsAgentInput as RunMealPlanCompilerInput,
} from "./ingredients-agent.js";
