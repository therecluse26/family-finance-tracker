// The categorization module's interface (spec 04, The categorization cascade). Other modules
// import from here.
export {
  type CascadeAnswer,
  type CascadeInput,
  type CascadeStep,
  type Choice,
  type RegisteredStep,
  registerCascadeStep,
} from "./cascade.ts";
export {
  BEST_GUESS_KIND,
  categorize,
  chooseCategories,
  startCategorization,
} from "./categorize.ts";
