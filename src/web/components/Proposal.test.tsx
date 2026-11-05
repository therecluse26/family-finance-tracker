import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ProposalView } from "../../server/proposals-views.ts";
import {
  ENTER_AMOUNT,
  ENTER_WORDS,
  editFields,
  editOf,
  ProposalCard,
  UndoableProposals,
} from "./Proposal.tsx";

// A Proposal's card, its Edit, and the Undo list, as the browser first paints them (spec 08,
// Proposals; Lifecycle). The requests themselves go through the app in
// src/server/proposals-api.test.ts.

const text = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();

const proposal = (fields: Partial<ProposalView> = {}): ProposalView => ({
  id: "p1",
  kind: "Budget change",
  source: "Monthly review",
  createdAt: "2026-10-20T14:00:00.000Z",
  reason: "Takeout and clothing have run under Budget.",
  changes: ["Restaurants Budget: $600 → $480", "Travel Budget: $4,800 a year → $4,000 a year"],
  budgets: [
    { category: "Restaurants", from: 60_000, to: 48_000, period: "monthly" },
    { category: "Travel", from: 480_000, to: 400_000, period: "yearly" },
  ],
  goal: null,
  words: null,
  ...fields,
});

const GOAL_AMOUNT = proposal({
  kind: "Goal amount",
  changes: ['Goal amount for "Spend less on takeout": $480'],
  budgets: [],
  goal: { id: "g1", words: "Spend less on takeout", goalAmount: 48_000 },
});

const NEW_GOAL = proposal({
  kind: "new Goal",
  changes: ['New Goal: "Save $1,000 for emergencies"'],
  budgets: [],
  words: "Save $1,000 for emergencies",
});

describe("a Proposal's card", () => {
  it("shows each change and the reason, with Accept, Edit, Skip, and Ask about this, and no Done", () => {
    const html = renderToString(<ProposalCard proposal={proposal()} onChanged={() => {}} />);

    expect(text(html)).toBe(
      "Proposal Restaurants Budget: $600 → $480 Travel Budget: $4,800 a year → $4,000 a year Takeout and clothing have run under Budget. AI Accept Edit Skip Ask about this",
    );
    expect(html).not.toContain("Done");
  });

  it("opens Edit with the proposed amounts or words, and Save and accept", () => {
    const budgets = renderToString(
      <ProposalCard proposal={proposal()} onChanged={() => {}} editing />,
    );
    expect(text(budgets)).toContain("Restaurants Budget, in dollars");
    expect(text(budgets)).toContain("Travel Budget a year, in dollars");
    expect(budgets).toContain('value="480"');
    expect(budgets).toContain('value="4000"');
    expect(text(budgets)).toContain("Save and accept Cancel");
    expect(text(budgets)).not.toContain("Skip");

    const goalAmount = renderToString(
      <ProposalCard proposal={GOAL_AMOUNT} onChanged={() => {}} editing />,
    );
    expect(text(goalAmount)).toContain("Goal amount, in dollars");
    expect(goalAmount).toContain('value="480"');

    const newGoal = renderToString(
      <ProposalCard proposal={NEW_GOAL} onChanged={() => {}} editing />,
    );
    expect(text(newGoal)).toContain("The Goal, in your own words");
    expect(newGoal).toContain('value="Save $1,000 for emergencies"');
  });

  it("turns Edit into the body Save and accept sends, or says what to fix", () => {
    const fields = editFields(proposal());
    expect(editOf(proposal(), fields)).toEqual({
      budgets: { Restaurants: 48_000, Travel: 400_000 },
    });
    expect(
      editOf(proposal(), { ...fields, amounts: { ...fields.amounts, Restaurants: "$250.50" } }),
    ).toEqual({ budgets: { Restaurants: 25_050, Travel: 400_000 } });
    expect(editOf(proposal(), { ...fields, amounts: { ...fields.amounts, Travel: "" } })).toBe(
      ENTER_AMOUNT,
    );
    expect(editOf(proposal(), { ...fields, amounts: { ...fields.amounts, Travel: "-5" } })).toBe(
      ENTER_AMOUNT,
    );

    expect(editOf(GOAL_AMOUNT, editFields(GOAL_AMOUNT))).toEqual({ goalAmount: 48_000 });
    expect(editOf(NEW_GOAL, editFields(NEW_GOAL))).toEqual({
      words: "Save $1,000 for emergencies",
    });
    expect(editOf(NEW_GOAL, { amounts: {}, words: "  " })).toBe(ENTER_WORDS);
  });
});

describe("the accepted Proposals with Undo", () => {
  const list = [proposal(), GOAL_AMOUNT, NEW_GOAL];

  it("lists each accepted Proposal of the page's kinds with Undo", () => {
    const budgets = renderToString(
      <UndoableProposals kinds={["Budget change"]} onChanged={() => {}} initial={list} />,
    );
    expect(text(budgets)).toBe(
      "Accepted Proposals Restaurants Budget: $600 → $480; Travel Budget: $4,800 a year → $4,000 a year Undo",
    );

    const goals = renderToString(
      <UndoableProposals kinds={["Goal amount", "new Goal"]} onChanged={() => {}} initial={list} />,
    );
    expect(text(goals)).toBe(
      'Accepted Proposals Goal amount for "Spend less on takeout": $480 Undo New Goal: "Save $1,000 for emergencies" Undo',
    );
  });

  it("shows nothing with none to undo", () => {
    expect(
      renderToString(
        <UndoableProposals kinds={["Budget change"]} onChanged={() => {}} initial={[NEW_GOAL]} />,
      ),
    ).toBe("");
  });
});
