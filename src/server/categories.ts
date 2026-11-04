import { isCategory } from "../categories/index.ts";
import {
  type CategoryRule,
  categoryRules,
  correctCategory,
  deleteCategoryRule,
} from "../categorization/index.ts";
import type { Database } from "../db/index.ts";
import type { CategoryRoutes, CategoryRuleView } from "./category-views.ts";

// The Category rule routes, through the categorization module.
export function categoryRoutes(database: Database): CategoryRoutes {
  const view = (rule: CategoryRule): CategoryRuleView => ({
    id: rule.id,
    merchantName: rule.merchant.name,
    category: rule.category,
    madeAt: rule.madeAt.toISOString(),
  });

  return {
    async correct(transactionId, category, onlyThisTransaction, memberId) {
      if (!isCategory(category)) throw new Error("The route takes only a Category.");
      const corrected = await correctCategory(database, transactionId, category, {
        onlyThisTransaction,
        memberId,
      });
      if (corrected.result !== "corrected") return corrected.result;
      return {
        category: corrected.category,
        rule: corrected.rule === null ? null : view(corrected.rule),
        setSpending: corrected.setSpending,
      };
    },

    async rules() {
      return (await categoryRules(database)).map(view);
    },

    deleteRule(id) {
      return deleteCategoryRule(database, id);
    },
  };
}
