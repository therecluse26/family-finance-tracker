// The categorization module's interface (spec 04, The categorization cascade). Other modules
// import from here.
export {
  type CascadeAnswer,
  type CascadeInput,
  type CascadeStep,
  type Choice,
  provenance,
  type RegisteredStep,
  registerCascadeStep,
} from "./cascade.ts";
export {
  AI_UNSURE_KIND,
  type AiStep,
  BEST_GUESS_KIND,
  type CategoryRun,
  categorize,
  chooseCategories,
  startCategorization,
} from "./categorize.ts";
export {
  type CategoryRule,
  type Correction,
  categoryRules,
  correctCategory,
  deleteCategoryRule,
} from "./rules.ts";
export { transactionWebLookupLine } from "./web-lookup.ts";
