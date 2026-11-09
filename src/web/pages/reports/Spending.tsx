import type { ReportSectionProps } from "../../reports.ts";
import { ComingSoon, ReportFrame } from "./ReportFrame.tsx";

// Spending over time (spec 07, Reports): Spending by month, by Category group, with one Category
// group as its filter. Built in R1.
export function SpendingReport(_props: ReportSectionProps) {
  return <ReportFrame id="spending" title="Spending over time" chart={<ComingSoon />} />;
}
