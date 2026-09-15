/**
 * @deprecated Compatibility exports for the pre-rename browser agent API.
 * New code should import from cart-agent.ts and use Cart Agent terminology.
 */
export {
  flattenCartAgentTasks as flattenIngredientTasks,
  runCartAgentTasks as runIngredientTasks,
} from "./cart-agent.js";
export type {
  CartAgentRecipeContext as IngredientRecipeContext,
  CartAgentTask as IngredientTask,
  CartAgentInvocation as IngredientAgentInvocation,
  CartAgentRunResult as IngredientRunResult,
  CartAgentRunProgress as IngredientRunProgress,
  CartAgentRunnerOptions as IngredientRunnerOptions,
} from "./cart-agent.js";
