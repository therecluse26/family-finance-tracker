import type { ReportSectionProps } from "../../reports.ts";
import { ComingSoon, ReportFrame } from "./ReportFrame.tsx";

// Cash flow (spec 07, Reports): Income, Spending and Saving by month, and what is left over. It
// has no filter. Built in R1.
export function CashFlowReport(_props: ReportSectionProps) {
  return <ReportFrame id="cash-flow" title="Cash flow" chart={<ComingSoon />} />;
}
