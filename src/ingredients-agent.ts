/** Public naming boundary for the recipe-document agent. */
export {
  assertDraftMatchesDocuments,
  runMealPlanCompiler as runIngredientsAgent,
  compileRecipeDocuments as compileIngredientsDocuments,
} from "./meal-plan-agent.js";
export type {
  RecipeDocument,
  MealPlanCompilerInvocation as IngredientsAgentInvocation,
  InvokeMealPlanCompiler as InvokeIngredientsAgent,
  RunMealPlanCompilerInput as RunIngredientsAgentInput,
} from "./meal-plan-agent.js";
