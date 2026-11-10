// Line item Categories and Item rules (spec 14, Item rules), as the routes answer them. Types only,
// so the web app reads them too.

// One Item rule on Settings > Categories.
export type ItemRuleView = {
  id: string;
  // The name of the Line item it was made from.
  name: string;
  category: string;
  // In UTC.
  madeAt: string;
};

export type LineItemCategoryRoutes = {
  // A Member's change of a Line item's Category: hand-set, plus an Item rule unless only this item.
  change(
    id: string,
    change: { category: string; onlyThisItem: boolean },
    memberId: string,
  ): Promise<"changed" | "not found" | "not a Category">;
  itemRules(): Promise<ItemRuleView[]>;
  // False when no rule has the ID.
  deleteItemRule(id: string): Promise<boolean>;
};
