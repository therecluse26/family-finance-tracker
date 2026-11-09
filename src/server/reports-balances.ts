import { type Database, listDailyBalances } from "../db/index.ts";
import { householdToday } from "../recurring/index.ts";
import { balanceLines, type DailyDetails, reportDays } from "../reports/balances.ts";
import { balanceSets, bankViews } from "./bank-data.ts";
import type { AccountView } from "./bank-views.ts";
import type {
  BalancesReportAccount,
  BalancesReportQuery,
  BalancesReportView,
  ReportRoutes,
} from "./reports-views.ts";

// Balances and debt on the Reports page (spec 07, Reports). With no Account set: Cash on hand and
// Debt over the range, counted as the number tiles count them, each card's credit use, and each
// loan's pay-down. With one Account set: that Account's balance line. Each Account's balances are
// read once.

const named = (account: AccountView): BalancesReportAccount => ({
  id: account.id,
  name: account.name,
  kind: account.kind,
});

export function balancesReports(database: Database, months: ReportRoutes["months"]) {
  const bank = bankViews(database);
  return {
    async balances(
      query: BalancesReportQuery,
      now = new Date(),
    ): Promise<BalancesReportView | undefined> {
      const listed = await bank.accounts();
      const chosen =
        query.account === undefined
          ? undefined
          : listed.find((account) => account.id === query.account);
      if (query.account !== undefined && chosen === undefined) return undefined;
      const range = await months(query.range, now);
      const today = await householdToday(database, now);
      const { counted, cash, debts } = balanceSets(listed);
      const accounts = [
        ...counted,
        ...(chosen !== undefined && !counted.includes(chosen) ? [chosen] : []),
      ].map(named);
      const empty = {
        cashOnHand: [],
        debt: [],
        creditUse: { cards: [], all: [] },
        loans: [],
      };
      const frame = { range: query.range, months: range, today, accounts };

      if (chosen !== undefined) {
        const first = range[0];
        const line =
          first === undefined
            ? undefined
            : await bank.balances(chosen.id, { from: `${first}-01`, to: today });
        return {
          ...frame,
          ...empty,
          account: {
            ...named(chosen),
            points: line?.points ?? [],
            monthEnds: line?.monthEnds ?? [],
          },
        };
      }
      if (range.length === 0) return { ...frame, ...empty, account: null };

      const days = reportDays(range, today);
      const lines = await bank.dayEndBalances([...cash, ...debts], days);
      const cashIds = new Set(cash.map((account) => account.id));
      // A synced card's credit limit and a synced loan's principal live in its saved daily
      // balances.
      const details = new Map<string, DailyDetails[]>();
      for (const { account } of lines) {
        if (account.connectionId === null || cashIds.has(account.id)) continue;
        details.set(account.id, await listDailyBalances(database, account.id));
      }
      return {
        ...frame,
        account: null,
        ...balanceLines({
          months: range,
          days,
          cash: lines.filter((line) => cashIds.has(line.account.id)),
          debts: lines.filter((line) => !cashIds.has(line.account.id)),
          details,
        }),
      };
    },
  };
}
