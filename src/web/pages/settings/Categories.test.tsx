import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CategoryRuleView } from "../../../server/category-views.ts";
import type { TransferAnswerView } from "../../../server/money-movement-views.ts";
import { CategoryRuleList, TransferAnswerList } from "./Categories.tsx";

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

describe("the remembered Transfer answer list", () => {
  const ANSWER: TransferAnswerView = {
    id: "answer-1",
    merchantName: "Online Transfer To Sav",
    lastFours: ["5678"],
    answer: "Pinecrest savings",
    madeAt: "2026-10-05T14:00:00.000Z",
  };

  it("lists every answer with its name, its account number's last 4, its answer, and Delete", () => {
    const html = renderToString(
      <TransferAnswerList
        answers={[
          ANSWER,
          {
            ...ANSWER,
            id: "answer-2",
            merchantName: "Rent Transfer",
            lastFours: [],
            answer: "Not a Transfer",
          },
        ]}
        busy={undefined}
        onDelete={() => {}}
      />,
    );

    expect(text(html)).toContain("Online Transfer To Sav, ending 5678: Pinecrest savingsDelete");
    expect(text(html)).toContain("Rent Transfer: Not a TransferDelete");
    expect(html).toContain('aria-label="Delete the answer for Rent Transfer"');
  });

  it("says when there is none yet", () => {
    const html = renderToString(
      <TransferAnswerList answers={[]} busy={undefined} onDelete={() => {}} />,
    );

    expect(text(html)).toContain("No remembered answers yet.");
  });
});
