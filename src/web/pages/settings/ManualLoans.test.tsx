import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ManualLoanView } from "../../../server/money-movement-views.ts";
import { ManualLoanForm, ManualLoanList } from "./ManualLoans.tsx";

// Settings → Banks: the Manual loans, as the browser paints them.

const CAR: ManualLoanView = {
  id: "loan-1",
  lender: "Lakeside Auto",
  kind: "car",
  balance: 1_250_000,
  balanceDate: "2026-10-05",
  apr: 7.3,
  regularPayment: 40_000,
  escrow: null,
  loanType: "purchase loan",
  setBy: "app",
};

const text = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;/g, "'");

describe("the Manual loan form", () => {
  it("asks for the lender, the loan type, the balance and its date, the APR, and the optional amounts", () => {
    const html = text(renderToString(<ManualLoanForm loan={null} onSaved={() => {}} />));

    for (const label of [
      "Lender",
      "Personal",
      "Car",
      "Student",
      "Mortgage",
      "Buy now pay later",
      "Current balance",
      "Balance date",
      "Interest rate (APR, %)",
      "Regular payment amount (optional)",
      "Let the app decide",
    ]) {
      expect(html).toContain(label);
    }
    // Escrow shows for a mortgage only.
    expect(html).not.toContain("Escrow per payment");
    const mortgage = { ...CAR, kind: "mortgage" as const, escrow: 40_000 };
    expect(text(renderToString(<ManualLoanForm loan={mortgage} onSaved={() => {}} />))).toContain(
      "Escrow per payment (optional)",
    );
  });

  it("offers a credit card and a line of credit only to refuse them, and says why", () => {
    const html = text(renderToString(<ManualLoanList loans={[]} onSaved={() => {}} />));

    expect(html).toContain("Credit card");
    expect(html).toContain("Line of credit");
    expect(html).toContain(
      "Credit cards and lines of credit can't be added: their balances move with purchases the app cannot see.",
    );
  });

  it("fills in the lender from a link, and lists each loan with its balance and type", () => {
    const html = renderToString(
      <ManualLoanList loans={[CAR]} lender="Riverbank Lending" onSaved={() => {}} />,
    );

    expect(html).toContain('value="Riverbank Lending"');
    expect(text(html)).toContain("Lakeside Auto, Car: $12,500 owed, Purchase loan");
  });
});
