import type { ReportSectionProps } from "../../reports.ts";
import { ComingSoon, ReportFrame } from "./ReportFrame.tsx";

// Merchants and Recurring charges (spec 07, Reports): Spending at the top Merchants by month, with
// one Merchant as its filter, and the Recurring charges over time. Built in R3.
export function MerchantsReport(_props: ReportSectionProps) {
  return (
    <ReportFrame id="merchants" title="Merchants and Recurring charges" chart={<ComingSoon />} />
  );
}
