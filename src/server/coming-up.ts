import {
  type Database,
  listCardPaymentsSince,
  listDueAccounts,
  listLoanLinkedTransactions,
  listPairedLoanPayments,
  listUntrackedLoanPaymentsSince,
} from "../db/index.ts";
import {
  addDays,
  addMonths,
  householdToday,
  nextExpected,
  paydayAfter,
  paydays,
  recurringCharges,
} from "../recurring/index.ts";
import type { ComingUpRoutes, ComingUpRowView, ComingUpView } from "./coming-up-views.ts";

// "Coming up" (spec 07, 6. Coming up): what is due from tomorrow to 14 days from today, and the
// checking balance after each row. Each active Recurring charge and each counted Income series
// shows at every expected date in the window, from its next expected date on (spec 05, Paydays),
// at its latest amount. An active Recurring charge whose expected date has come with no charge
// yet shows on today, as late when that date is before today. Excluded and Closed Accounts owe nothing here and hold no checking
// balance.

const WINDOW_DAYS = 14;

// How far back a connected loan's last payment may be, to give its usual day and amount.
const LOAN_PAYMENT_MONTHS = 3;

type DueAccount = Awaited<ReturnType<typeof listDueAccounts>>[number];
type Row = Omit<ComingUpRowView, "checkingAfter">;
type Payment = { postedDate: string; amount: number };

const nameOf = (account: DueAccount) => account.memberName ?? account.name;
const counted = (account: DueAccount) => account.closedAt === null && !account.excluded;
const isCard = (account: DueAccount) => account.kind === "credit";

// A lender's name as the untracked loan rule compares it (spec 03, Untracked loans).
const lenderKey = (name: string | null) => name?.trim().toLowerCase() ?? "";

// A loan's next usual day from `from` on: the day of the month of its last payment. A day the
// month lacks means its last day.
function nextUsualDay(lastPayment: string, from: string): string {
  const months =
    (Number(from.slice(0, 4)) - Number(lastPayment.slice(0, 4))) * 12 +
    Number(from.slice(5, 7)) -
    Number(lastPayment.slice(5, 7));
  let count = Math.max(1, months - 1);
  let next = addMonths(lastPayment, count);
  while (next < from) {
    count += 1;
    next = addMonths(lastPayment, count);
  }
  return next;
}

// The expected dates of a series from `first` to `to`: `first`, then one interval after each.
function datesThrough(first: string, to: string, after: (date: string) => string): string[] {
  const dates: string[] = [];
  for (let date = first; date <= to; date = after(date)) {
    const previous = dates.at(-1);
    if (previous !== undefined && date <= previous) break;
    dates.push(date);
  }
  return dates;
}

// Same day: money out first, the larger first, so the lowest balance is never later than it can
// be. Then by name.
function byDate(a: Row, b: Row): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.amount !== b.amount) return a.amount - b.amount;
  return a.what.localeCompare(b.what);
}

export function comingUpRoutes(database: Database): ComingUpRoutes {
  // Each connected card's payment due, at the statement balance. A card whose payments since the
  // statement was issued reach the statement balance shows no row.
  async function cardRows(cards: DueAccount[], within: (date: string) => boolean) {
    const due = cards.filter(
      (card) =>
        card.paymentDueDate !== null &&
        within(card.paymentDueDate) &&
        (card.statementBalance ?? 0) < 0,
    );
    const issued = due.flatMap((card) => card.statementIssueDate ?? []).sort();
    const payments =
      issued[0] === undefined
        ? []
        : await listCardPaymentsSince(
            database,
            due.map((card) => card.id),
            issued[0],
          );
    return due.flatMap((card): Row[] => {
      const owed = -(card.statementBalance ?? 0);
      const issuedOn = card.statementIssueDate;
      const paid =
        issuedOn === null
          ? 0
          : payments
              .filter((each) => each.accountId === card.id && each.postedDate >= issuedOn)
              .reduce((sum, each) => sum + each.amount, 0);
      if (paid >= owed) return [];
      return [
        {
          date: card.paymentDueDate ?? "",
          late: false,
          kind: "card payment",
          what: `${nameOf(card)} payment`,
          amount: -owed,
          onCard: false,
        },
      ];
    });
  }

  // The last payment of each connected loan with no minimum payment, in the past 3 months: the
  // paying side of its last Transfer pair, or, with none, its lender's last untracked loan payment.
  // The lender's payments count only when no other open loan of any kind (`openLoans`) has that
  // lender, and when they come at most once in each month; else they may pay another loan.
  async function lastConnectedPayments(
    loans: DueAccount[],
    openLoans: DueAccount[],
    today: string,
  ) {
    const last = new Map<string, Payment>();
    if (loans.length === 0) return last;
    const since = addMonths(today, -LOAN_PAYMENT_MONTHS);
    for (const payment of await listPairedLoanPayments(
      database,
      loans.map((loan) => loan.id),
      since,
    )) {
      last.set(payment.loanAccountId, payment);
    }
    const unpaired = loans.filter((loan) => !last.has(loan.id));
    if (unpaired.length === 0) return last;
    const loansAt = new Map<string, number>();
    for (const loan of openLoans) {
      const lender = lenderKey(loan.institutionName);
      loansAt.set(lender, (loansAt.get(lender) ?? 0) + 1);
    }
    const paymentsTo = new Map<string, Payment[]>();
    for (const payment of await listUntrackedLoanPaymentsSince(database, since)) {
      const lender = lenderKey(payment.lender);
      paymentsTo.set(lender, [...(paymentsTo.get(lender) ?? []), payment]);
    }
    for (const loan of unpaired) {
      const lender = lenderKey(loan.institutionName);
      if (lender === "" || loansAt.get(lender) !== 1) continue;
      const payments = paymentsTo.get(lender) ?? [];
      const months = new Set(payments.map((payment) => payment.postedDate.slice(0, 7)));
      if (months.size !== payments.length) continue;
      const payment = payments.at(-1);
      if (payment !== undefined) last.set(loan.id, payment);
    }
    return last;
  }

  // Each loan payment due. A connected loan with a minimum payment pays it on its due date. A
  // Manual loan pays its regular payment, or its last linked payment's amount, a month after that
  // payment; so does a connected loan with no minimum payment, from its last payment. With no
  // payment to give the day, a loan has no row.
  async function loanRows(
    loans: DueAccount[],
    openLoans: DueAccount[],
    today: string,
    from: string,
    within: (date: string) => boolean,
  ) {
    const rows: Row[] = [];
    const row = (loan: DueAccount, date: string, amount: number): Row => ({
      date,
      late: false,
      kind: "loan payment",
      what: `${nameOf(loan)} payment`,
      amount: -amount,
      onCard: false,
    });
    const connected = loans.filter((loan) => loan.connectionId !== null);
    const withMinimum = connected.filter((loan) => (loan.minimumPayment ?? 0) > 0);
    for (const loan of withMinimum) {
      const due = loan.paymentDueDate;
      if (due !== null && within(due)) rows.push(row(loan, due, loan.minimumPayment ?? 0));
    }

    const manual = loans.filter((loan) => loan.connectionId === null);
    const linked = await listLoanLinkedTransactions(
      database,
      manual.map((loan) => loan.id),
    );
    const last = await lastConnectedPayments(
      connected.filter((loan) => !withMinimum.includes(loan)),
      openLoans,
      today,
    );
    for (const loan of manual) {
      const payment = linked
        .filter((each) => each.loanAccountId === loan.id && each.amount < 0)
        .at(-1);
      if (payment !== undefined) last.set(loan.id, payment);
    }
    for (const loan of loans) {
      const payment = last.get(loan.id);
      if (payment === undefined) continue;
      const amount = loan.regularPayment ?? -payment.amount;
      const date = nextUsualDay(payment.postedDate, from);
      if (amount > 0 && within(date)) rows.push(row(loan, date, amount));
    }
    return rows;
  }

  return {
    async view(now = new Date()): Promise<ComingUpView> {
      const today = await householdToday(database, now);
      const from = addDays(today, 1);
      const to = addDays(today, WINDOW_DAYS);
      const within = (date: string) => from <= date && date <= to;

      const accounts = await listDueAccounts(database);
      const byId = new Map(accounts.map((account) => [account.id, account]));
      const open = accounts.filter(counted);
      const connected = open.filter((account) => account.connectionId !== null);
      const checkings = connected.filter(
        (account) => account.kind === "depository" && account.subtype === "checking",
      );

      const charges = (await recurringCharges(database, now))
        .filter((charge) => charge.status === "active")
        .flatMap((charge): Row[] => {
          const account = byId.get(charge.accountId);
          const onCard = account !== undefined && isCard(account);
          const after = (date: string) => nextExpected(charge.schedule, date);
          return datesThrough(charge.nextExpectedDate, to, after).flatMap((date) => {
            // An expected date of today or before, with no charge yet, shows on today. Only one
            // before today is late.
            const due = date < from && date === charge.nextExpectedDate;
            if (!due && !within(date)) return [];
            return [
              {
                date: due ? today : date,
                late: date < today,
                kind: "Recurring charge",
                what: charge.merchant.name,
                amount: -charge.latestAmount,
                onCard,
              },
            ];
          });
        });
      const income = (await paydays(database, now)).flatMap((payday) =>
        datesThrough(payday.date, to, (date) => paydayAfter(payday, date))
          .filter(within)
          .map(
            (date): Row => ({
              date,
              late: false,
              kind: "payday",
              what: payday.payer.name,
              amount: payday.amount,
              onCard: false,
            }),
          ),
      );
      const rows = [
        ...charges,
        ...income,
        ...(await cardRows(connected.filter(isCard), within)),
        ...(await loanRows(
          open.filter((account) => account.kind === "loan"),
          // Every loan not closed, Excluded ones too, to know which loans share a lender.
          accounts.filter((account) => account.kind === "loan" && account.closedAt === null),
          today,
          from,
          within,
        )),
      ].sort(byDate);

      const checking =
        checkings.length === 0
          ? null
          : checkings.reduce((sum, account) => sum + (account.currentBalance ?? 0), 0);
      let balance = checking;
      let lowest = checking === null ? null : { amount: checking, date: today };
      const shown = rows.map((row): ComingUpRowView => {
        if (balance === null || row.onCard) return { ...row, checkingAfter: null };
        balance += row.amount;
        if (lowest !== null && balance < lowest.amount)
          lowest = { amount: balance, date: row.date };
        return { ...row, checkingAfter: balance };
      });
      return {
        from,
        to,
        outgoing: rows.reduce((sum, row) => sum + Math.max(0, -row.amount), 0),
        checking,
        lowest,
        rows: shown,
      };
    },
  };
}
