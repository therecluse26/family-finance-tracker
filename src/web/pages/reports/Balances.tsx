import type { ReportSectionProps } from "../../reports.ts";
import { ComingSoon, ReportFrame } from "./ReportFrame.tsx";

// Balances and debt (spec 07, Reports): Account balances and total Debt by month, with one Account
// as its filter. No net worth. Built in R2.
export function BalancesReport(_props: ReportSectionProps) {
  return <ReportFrame id="balances" title="Balances and debt" chart={<ComingSoon />} />;
}
