import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CategoryRuleView } from "../../../server/category-views.ts";
import { CategoryRuleList } from "./Categories.tsx";

// Settings → Categories: the Category rules, as the browser paints them.

const RULE: CategoryRuleView = {
  id: "rule-1",
  merchantName: "Corner Bistro",
  category: "Restaurants",
  madeAt: "2026-10-05T14:00:00.000Z",
};

const text = (html: string) => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, "");

describe("the Category rule list", () => {
  it("lists every rule with its Merchant, its Category, and Delete", () => {
    const html = renderToString(
      <CategoryRuleList
        rules={[RULE, { ...RULE, id: "rule-2", merchantName: "Morgan Lee", category: "Childcare" }]}
        busy={undefined}
        onDelete={() => {}}
      />,
    );

    expect(text(html)).toContain("Corner Bistro: RestaurantsDelete");
    expect(text(html)).toContain("Morgan Lee: ChildcareDelete");
    expect(html).toContain('aria-label="Delete the rule for Morgan Lee"');
  });

  it("says when there is no rule yet", () => {
    const html = renderToString(
      <CategoryRuleList rules={[]} busy={undefined} onDelete={() => {}} />,
    );

    expect(text(html)).toContain("No Category rules yet.");
  });
});
