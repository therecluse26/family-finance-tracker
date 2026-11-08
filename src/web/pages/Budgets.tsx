import { type ReactNode, useEffect, useState } from "react";
import { YEARLY_CATEGORIES } from "../../budgets/periods.ts";
import type { Category } from "../../categories/list.ts";
import { calendarDateIn, percent, wholeDollars } from "../../format.ts";
import type { BudgetsView, MonthBudgetView } from "../../server/budgets-views.ts";
import type { HouseholdFactsView } from "../../server/household-views.ts";
import { api } from "../api.ts";
import { browserZone } from "../browser-zone.ts";
import {
  acceptAll,
  type BudgetRow,
  type BudgetRows,
  type BudgetStatusShown,
  budgetRequests,
  budgetRows,
  type ChangeOutcome,
  editBudget,
  followTheBill,
  STATUS_SHOWN,
  typedBudget,
} from "../budgets.ts";
import { Button } from "../components/Button.tsx";
import { Card } from "../components/Card.tsx";
import { ErrorLine } from "../components/Fields.tsx";
import { Meter } from "../components/Meter.tsx";
import { Page, PageHeading } from "../components/Page.tsx";
import { UndoableProposals } from "../components/Proposal.tsx";
import { AiMark, Status } from "../components/Status.tsx";
import { barShare, dashboardMonth, groupStatus, leftToSpend, monthName } from "../dashboard.ts";

// The Budgets page (spec 07, Budgets page): every Category by Category group, with this month's
// Spending, its Budget, and its status, and the yearly Budgets in their own section at the end. A
// Member edits any Budget here, switches a pinned Bills Budget back to "Follow the bill", and
// accepts the whole draft with "Accept all".

export const BEFORE_FIRST_DRAFT = "Budgets appear when your history has loaded.";

// The draft box's soft blue, from the board. It has no shared token yet.
const DRAFT_BOX = "rounded-card border border-[#C9D7F8] bg-[#EEF3FE] px-4 py-3.5 sm:px-[18px]";

// A row's edit box and the answer to its last change.
export type RowState = { typed?: string; error?: string; busy?: boolean };

// `type` and `save` take the Category, so a Category with no Budget can get its first one.
export type BudgetActions = {
  type(category: string, typed: string): void;
  // `keyboard` when the keyboard pressed "Save", so the focus goes back to the amount box after.
  save(category: string, typed: string, how?: { keyboard: boolean }): void;
  followTheBill(budget: MonthBudgetView): void;
  acceptAll(): void;
};

// A form field's ID from a Category, such as "budget-phone-and-internet".
const fieldId = (category: string) =>
  `budget-${category.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

// After "Save" from the keyboard, the focus goes back to the row's amount box when the save left
// it nowhere or on "Save", which is disabled while it saves and hidden once the save is done.
export function focusAfterSave(
  doc: Pick<Document, "activeElement" | "body" | "getElementById">,
  category: string,
): void {
  const box = doc.getElementById(fieldId(category));
  const active = doc.activeElement;
  if (box === null) return;
  if (active === null || active === doc.body || box.closest("form")?.contains(active) === true) {
    box.focus();
  }
}

// A Budget's status, with the amount where it is not on track (spec 07, Status): "▲ $8 over",
// "◆ on pace for $435", or "✓ On track". On pace with no projection keeps its word.
export function budgetStatus(budget: MonthBudgetView): BudgetStatusShown {
  if (budget.status === "Over Budget") {
    return { tone: "critical", word: `${wholeDollars(budget.spending - budget.amount)} over` };
  }
  if (budget.status === "On pace" && budget.projected !== null) {
    return { tone: "serious", word: `on pace for ${wholeDollars(budget.projected)}` };
  }
  return STATUS_SHOWN[budget.status];
}

// The Budget's box, always open: Enter or "Save" sends it. A yearly Budget is per year. As on the
// board, the boxes stand alone at rest: "Save" shows once the box holds a new amount (or while it
// saves, or after a refusal), and keeps its place while hidden so nothing moves as it appears. A
// Category with no Budget has an empty box: what a Member saves there is its first Budget, per
// year for a yearly Category.
function BudgetEdit(props: {
  category: string;
  budget: MonthBudgetView | undefined;
  state: RowState;
  actions: BudgetActions;
}) {
  const { category, budget, state, actions } = props;
  const shown = budget === undefined ? "" : typedBudget(budget.amount);
  const typed = state.typed ?? shown;
  const id = fieldId(category);
  const yearly =
    budget === undefined
      ? YEARLY_CATEGORIES.includes(category as Category)
      : budget.period === "yearly";
  const showSave = typed !== shown || state.busy === true || state.error !== undefined;
  return (
    <form
      className="flex items-center gap-2 sm:justify-end"
      onSubmit={(e) => {
        e.preventDefault();
        actions.save(category, typed);
      }}
    >
      <label className="sr-only" htmlFor={id}>
        {`${category} ${yearly ? "Budget per year" : "Budget per month"}`}
      </label>
      <span className="relative before:pointer-events-none before:absolute before:top-1/2 before:left-2.5 before:-translate-y-1/2 before:text-muted before:content-['$']">
        <input
          id={id}
          className="h-9 w-24 rounded-control border border-field bg-white pr-2 pl-5 text-right text-sm tabular-nums"
          inputMode="decimal"
          required
          value={typed}
          onChange={(e) => actions.type(category, e.target.value)}
        />
      </span>
      <Button
        type="button"
        variant="outlined"
        size="small"
        disabled={state.busy === true}
        className={showSave ? undefined : "invisible"}
        data-slot="budget-save"
        // A click from the keyboard, Enter or Space, has no pointer and a detail of 0.
        onClick={(e) => actions.save(category, typed, { keyboard: e.detail === 0 })}
      >
        Save
      </Button>
    </form>
  );
}

// "Follow the bill" is on while the Bills Budget follows the formula. A Member's edit pins it and
// turns it off; turning it on puts the Budget back on the formula from the next month. The
// checkbox stays the switch for keyboards and screen readers; the track beside it is drawn.
function FollowTheBill(props: {
  budget: MonthBudgetView;
  state: RowState;
  actions: BudgetActions;
}) {
  const { budget, state, actions } = props;
  return (
    <label className="inline-flex items-center gap-1.5 text-xs text-ink-soft">
      <input
        type="checkbox"
        role="switch"
        className="peer sr-only"
        aria-checked={budget.pinned !== true}
        checked={budget.pinned !== true}
        disabled={budget.pinned !== true || state.busy === true}
        onChange={() => actions.followTheBill(budget)}
      />
      <span
        aria-hidden="true"
        className="relative inline-block h-[18px] w-[30px] shrink-0 rounded-full bg-muted peer-checked:bg-accent peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent peer-disabled:opacity-70 after:absolute after:top-0.5 after:left-0.5 after:size-3.5 after:rounded-full after:bg-white after:content-[''] peer-checked:after:left-[14px]"
      />
      Follow the bill
    </label>
  );
}

// One row: the Category, its Spending and status, a meter of Spending against the Budget, and the
// Budget's box. From 640 px the four sit in a line, as on the board; on a phone the meter and the
// box each take a line under the Category, and a Category with no Budget drops its empty meter. A
// Category with no Budget says "no Budget" under its Spending, and its box is empty.
// The box's column has one width, so the meters line up down the card. `today` is where the meter's "today" tick goes: the
// share of the month gone for a flexible Category, the share of the year for a yearly Budget, and
// none for Bills.
function BudgetLine(props: {
  category: string;
  spending: number;
  spent: string;
  budget: MonthBudgetView | undefined;
  today: number | undefined;
  facts: ReactNode;
  state: RowState;
  actions: BudgetActions;
}) {
  const { budget, state, actions } = props;
  const tone =
    budget?.status === "Over Budget"
      ? "critical"
      : budget?.status === "On pace"
        ? "serious"
        : "accent";
  return (
    <li
      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 border-t border-line-soft py-2.5 text-sm sm:grid-cols-[minmax(0,1.4fr)_minmax(0,2fr)_9.75rem_minmax(0,1.3fr)] sm:gap-x-3.5"
      data-category={props.category}
    >
      <div className="min-w-0">
        <span className="font-semibold">{props.category}</span>
        {props.facts}
      </div>
      <div className="col-start-2 row-start-1 flex flex-col items-end gap-1 text-right sm:col-start-4 sm:items-start sm:text-left">
        <span className="tabular-nums">{props.spent}</span>
        {budget === undefined ? (
          <span className="text-small text-muted">no Budget</span>
        ) : (
          <span className="text-small">
            <Status {...budgetStatus(budget)} />
          </span>
        )}
        {budget === undefined || budget.pinned === null ? null : (
          <FollowTheBill budget={budget} state={state} actions={actions} />
        )}
      </div>
      <Meter
        share={budget === undefined ? 0 : barShare(props.spending, budget.amount)}
        tone={tone}
        size="small"
        {...(budget === undefined || props.today === undefined ? {} : { today: props.today })}
        className={`col-span-2 sm:col-span-1 sm:col-start-2 sm:row-start-1 ${budget === undefined ? "hidden sm:block" : ""}`}
      />
      <div className="col-span-2 sm:col-span-1 sm:col-start-3 sm:row-start-1 sm:text-right">
        <BudgetEdit category={props.category} budget={budget} state={state} actions={actions} />
      </div>
      {state.error === undefined ? null : (
        <div className="col-span-full">
          <ErrorLine error={state.error} />
        </div>
      )}
    </li>
  );
}

// `monthGone` is the share of the month gone, for the "today" tick on each flexible Category's
// meter. Bills come once a month, so they get none.
export function BudgetRowItem(props: {
  row: BudgetRow;
  state: RowState;
  actions: BudgetActions;
  monthGone?: number;
}) {
  const { row, state, actions } = props;
  const { budget } = row;
  const flexible = budget?.categoryGroup !== "Bills";
  return (
    <BudgetLine
      category={row.category}
      spending={row.spending}
      spent={`${wholeDollars(row.spending)} spent`}
      budget={budget}
      today={flexible ? props.monthGone : undefined}
      facts={
        <>
          {budget?.context == null ? null : (
            <p className="mt-0.5 text-small text-muted">{budget.context}</p>
          )}
          {budget?.reason == null ? null : (
            <p className="mt-0.5 text-small text-muted" data-slot="budget-reason">
              {budget.reason} <AiMark />
            </p>
          )}
        </>
      }
      state={state}
      actions={actions}
    />
  );
}

// A yearly Budget shows the year's Spending, the yearly Budget, and how much of the year has
// passed. It is never On pace (spec 05, Yearly Budgets). Its tick is the share of the year.
export function YearlyBudgetItem(props: {
  budget: MonthBudgetView;
  state: RowState;
  actions: BudgetActions;
}) {
  const { budget, state, actions } = props;
  return (
    <BudgetLine
      category={budget.category}
      spending={budget.spending}
      spent={`${wholeDollars(budget.spending)} spent this year`}
      budget={budget}
      today={budget.shareOfYear ?? undefined}
      facts={
        budget.shareOfYear === null ? null : (
          <p className="mt-0.5 text-small text-muted">
            {percent(budget.shareOfYear)} of the year has passed
          </p>
        )
      }
      state={state}
      actions={actions}
    />
  );
}

// A Category group's box: its heading, "$spent of $Budget" for its monthly Budgets, and its status
// (spec 07, 5. "A usual month"): "▲ N over", "◆ N on pace to go over", or "✓ on track".
function GroupHeading(props: { title: string; group: BudgetsView["groups"][number] | undefined }) {
  const { group } = props;
  const status = groupStatus(group);
  return (
    <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 pt-1.5 pb-2">
      <h2 className="text-heading font-bold" id={`${fieldId(props.title)}-group`}>
        {props.title}
      </h2>
      {group === undefined || group.monthly === 0 || group.spending === null ? null : (
        <span className="text-small text-muted tabular-nums" data-slot="group-total">
          {wholeDollars(group.spending)} of {wholeDollars(group.monthly)}
        </span>
      )}
      {status === undefined ? null : (
        <span className="ml-auto text-small" data-slot="group-status">
          <Status {...status} />
        </span>
      )}
    </div>
  );
}

// A Category group with no monthly Budget, folded to one line: its name and its Spending, then
// "no Budget", or "no monthly Budget" when it has a yearly one. Its name is a button that opens
// its rows in place; each row's empty box gives its Category a first Budget. As on the board, folded groups that
// follow each other share one box. The page holds which are open.
function FoldedGroup(props: {
  title: string;
  rows: BudgetRow[];
  // Whether the group has a yearly Budget, whose rows are under Yearly Budgets.
  yearly: boolean;
  monthGone: number | undefined;
  states: Readonly<Record<string, RowState>>;
  actions: BudgetActions;
  open: boolean;
  onToggle: () => void;
}) {
  const { open } = props;
  const id = `${fieldId(props.title)}-group`;
  const spending = props.rows.reduce((sum, row) => sum + row.spending, 0);
  return (
    <section
      aria-labelledby={id}
      className="border-t border-line-soft first:border-t-0"
      data-slot="folded-group"
    >
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 py-1.5">
        <h2 className="min-w-0 flex-1 text-heading font-bold" id={id}>
          <button
            type="button"
            aria-controls={`${id}-rows`}
            aria-expanded={open}
            className="flex w-full items-center gap-2 rounded-control py-1.5 text-left hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            onClick={props.onToggle}
          >
            <svg
              aria-hidden="true"
              className={`size-3.5 shrink-0 text-muted transition-transform ${open ? "rotate-90" : ""}`}
              viewBox="0 0 16 16"
            >
              <path
                d="M6 3l5 5-5 5"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
              />
            </svg>
            {props.title}
          </button>
        </h2>
        <span className="text-small text-muted tabular-nums" data-slot="folded-total">
          {wholeDollars(spending)} spent, {props.yearly ? "no monthly Budget" : "no Budget"}
        </span>
      </div>
      <ul hidden={!open} id={`${id}-rows`}>
        {props.rows.map((row) => (
          <BudgetRowItem
            key={row.category}
            row={row}
            state={props.states[row.category] ?? {}}
            actions={props.actions}
            {...(props.monthGone === undefined ? {} : { monthGone: props.monthGone })}
          />
        ))}
      </ul>
    </section>
  );
}

// The Category groups in list order, with each run of groups that have no monthly Budget folded
// into one box. A group whose only Budget is yearly folds too: its yearly rows are under Yearly
// Budgets.
type GroupPart =
  | { kind: "open"; group: BudgetRows["groups"][number] }
  | { kind: "folded"; groups: BudgetRows["groups"] };

function groupParts(groups: BudgetRows["groups"]): GroupPart[] {
  const parts: GroupPart[] = [];
  for (const group of groups) {
    const last = parts.at(-1);
    if (group.rows.some((row) => row.budget !== undefined)) parts.push({ kind: "open", group });
    else if (last?.kind === "folded") last.groups.push(group);
    else parts.push({ kind: "folded", groups: [group] });
  }
  return parts;
}

export function BudgetsReport(props: {
  view: BudgetsView;
  states: Readonly<Record<string, RowState>>;
  accept: RowState;
  actions: BudgetActions;
  // The share of the month gone, for the "today" ticks. None draws no tick.
  monthGone?: number;
  // The folded Category groups a Member opened, and the switch for each.
  openGroups?: readonly string[];
  toggleGroup?: (categoryGroup: string) => void;
}) {
  const { view, states, actions } = props;
  if (!view.drafted) {
    return (
      <Card>
        <p className="text-muted">{BEFORE_FIRST_DRAFT}</p>
      </Card>
    );
  }
  const { groups, yearly } = budgetRows(view);
  const stateOf = (category: string) => states[category] ?? {};
  const groupOf = (name: string) => view.groups.find((group) => group.categoryGroup === name);
  return (
    <>
      {view.notice === null ? null : <p className="text-small text-muted">{view.notice}</p>}
      {view.fitNote === null ? null : <p>{view.fitNote}</p>}
      {view.draftAccepted ? (
        <p className="text-small text-muted">The draft is accepted.</p>
      ) : (
        <section className={`flex flex-wrap items-center gap-3 ${DRAFT_BOX}`}>
          <p className="min-w-[min(100%,260px)] flex-1">
            These Budgets are a draft. Edit any of them, or take the whole draft at once.
          </p>
          <Button
            type="button"
            disabled={props.accept.busy === true}
            onClick={() => actions.acceptAll()}
          >
            Accept all
          </Button>
          {props.accept.error === undefined ? null : (
            <div className="basis-full">
              <ErrorLine error={props.accept.error} />
            </div>
          )}
        </section>
      )}
      {groupParts(groups).map((part) => {
        if (part.kind === "folded") {
          return (
            <Card
              as="div"
              key={part.groups.map((group) => group.categoryGroup).join("+")}
              padding="list"
            >
              {part.groups.map((group) => (
                <FoldedGroup
                  key={group.categoryGroup}
                  title={group.categoryGroup}
                  rows={group.rows}
                  yearly={(groupOf(group.categoryGroup)?.yearly ?? 0) > 0}
                  monthGone={props.monthGone}
                  states={states}
                  actions={actions}
                  open={props.openGroups?.includes(group.categoryGroup) === true}
                  onToggle={() => props.toggleGroup?.(group.categoryGroup)}
                />
              ))}
            </Card>
          );
        }
        const { group } = part;
        return (
          <Card
            key={group.categoryGroup}
            padding="list"
            aria-labelledby={`${fieldId(group.categoryGroup)}-group`}
          >
            <GroupHeading title={group.categoryGroup} group={groupOf(group.categoryGroup)} />
            <ul>
              {group.rows.map((row) => (
                <BudgetRowItem
                  key={row.category}
                  row={row}
                  state={stateOf(row.category)}
                  actions={actions}
                  {...(props.monthGone === undefined ? {} : { monthGone: props.monthGone })}
                />
              ))}
            </ul>
          </Card>
        );
      })}
      {yearly.length === 0 ? null : (
        <Card padding="list" aria-labelledby={`${fieldId("Yearly Budgets")}-group`}>
          <GroupHeading title="Yearly Budgets" group={undefined} />
          <ul>
            {yearly.map((budget) => (
              <YearlyBudgetItem
                key={budget.category}
                budget={budget}
                state={stateOf(budget.category)}
                actions={actions}
              />
            ))}
          </ul>
        </Card>
      )}
      {props.monthGone === undefined ? null : (
        <p className="text-small text-muted" data-slot="tick-note">
          The black tick on each meter is today. Bills have no tick: they come once a month.
        </p>
      )}
    </>
  );
}

// "$1,220 of $5,400 spent": the month's Spending against its monthly Budgets, as Left to spend
// counts them (spec 07, 2. Left to spend). Yearly Budgets stay out.
export function monthSpentLine(view: BudgetsView): string | undefined {
  const left = leftToSpend(view);
  if (!left.drafted) return undefined;
  return `${wholeDollars(left.spending)} of ${wholeDollars(left.budget)} spent`;
}

export function Budgets() {
  const [view, setView] = useState<BudgetsView | undefined>();
  const [monthGone, setMonthGone] = useState<number | undefined>();
  const [states, setStates] = useState<Record<string, RowState>>({});
  const [accept, setAccept] = useState<RowState>({});
  const [error, setError] = useState<string | undefined>();
  const [openGroups, setOpenGroups] = useState<readonly string[]>([]);
  // Counts the page's reads, so the accepted Proposals read again with it.
  const [reads, setReads] = useState(0);

  const setState = (category: string, change: RowState) =>
    setStates((all) => ({ ...all, [category]: { ...all[category], ...change } }));

  // This month is the Household's, as for the edits.
  async function load() {
    try {
      const household = await api.household.$get();
      const facts = household.ok
        ? ((await household.json()) as { facts: HouseholdFactsView | null }).facts
        : null;
      const zone = facts?.timeZone ?? browserZone();
      const now = new Date();
      const month = calendarDateIn(now, zone).slice(0, 7);
      const res = await budgetRequests.budgets(month);
      if (!res.ok) return setError("That did not work.");
      const days = dashboardMonth(now, zone);
      setView((await res.json()) as BudgetsView);
      setMonthGone(days.day / days.days);
      setReads((count) => count + 1);
      setError(undefined);
    } catch {
      setError("The server did not answer.");
    }
  }

  // Each change reads the page again: an edit or "Follow the bill" changes the status too.
  // After "Save" from the keyboard, the focus goes back to the row's amount box.
  async function change(
    category: string,
    send: () => Promise<ChangeOutcome>,
    how?: { keyboard: boolean },
  ) {
    setState(category, { busy: true, error: undefined });
    const outcome = await send();
    if (how?.keyboard === true) focusAfterSave(document, category);
    if (outcome.changed) {
      setStates((all) => ({ ...all, [category]: {} }));
      return load();
    }
    setState(category, { busy: false, error: outcome.error });
  }

  const actions: BudgetActions = {
    type: (category, typed) => setState(category, { typed }),
    save: (category, typed, how) => void change(category, () => editBudget(category, typed), how),
    followTheBill: (budget) => void change(budget.category, () => followTheBill(budget.category)),
    async acceptAll() {
      setAccept({ busy: true });
      const outcome = await acceptAll();
      setAccept(outcome.changed ? {} : { error: outcome.error });
      if (outcome.changed) await load();
    },
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: load once, when the page opens.
  useEffect(() => {
    void load();
  }, []);

  // The heading stays one element while the page loads, so the focus a menu choice puts on it
  // stays there. The month joins it once the Budgets have loaded.
  const spent = view === undefined ? undefined : monthSpentLine(view);
  return (
    <Page width="wide">
      <PageHeading title={view === undefined ? "Budgets" : `Budgets · ${monthName(view.month)}`}>
        {spent === undefined ? null : (
          <span className="text-muted tabular-nums" data-slot="month-spent">
            {spent}
          </span>
        )}
      </PageHeading>
      <ErrorLine error={error} />
      <UndoableProposals key={reads} kinds={["Budget change"]} onChanged={() => void load()} />
      {view === undefined ? null : (
        <BudgetsReport
          view={view}
          states={states}
          accept={accept}
          actions={actions}
          openGroups={openGroups}
          toggleGroup={(name) =>
            setOpenGroups((all) =>
              all.includes(name) ? all.filter((each) => each !== name) : [...all, name],
            )
          }
          {...(monthGone === undefined ? {} : { monthGone })}
        />
      )}
    </Page>
  );
}
