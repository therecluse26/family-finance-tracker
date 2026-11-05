import { isValidElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GoalView } from "../../server/goals-views.ts";
import { type GoalsAnswer, markGoal, readingParts, saveGoal } from "../goals.ts";
import { type GoalForm, type GoalFormActions, GoalsReport } from "./Goals.tsx";

// The Goals page (spec 07, Goals page), drawn from the Goal routes' answer. The routes themselves
// are checked through the app's HTTP interface in src/server/goals-api.test.ts.

const TODAY = "2026-10-20";

const goal = (fields: Partial<GoalView> = {}): GoalView => ({
  id: "g1",
  words: "Spend less on eating out",
  authorId: "m1",
  author: "Alex",
  date: "2026-09-02",
  status: "active",
  endedOn: null,
  endedBy: null,
  reading: {
    target: { kind: "Category", category: "Restaurants" },
    change: { percent: 20 },
    deadline: null,
  },
  goalAmount: 48_000,
  startsOn: "2026-09-01",
  list: "active",
  progress: {
    kind: "spend less",
    percentage: 62,
    state: "Behind",
    detail: "On pace for $540 this month; Goal is $480",
    estimated: false,
  },
  ...fields,
});

const ACCOUNT_NAMES = new Map([
  ["a-savings", "Rainy Day Savings"],
  ["a-brokerage", "Brokerage"],
]);

// One active Goal, one done this month (still with the active Goals), one in the done list, and
// one in the dropped list.
const ANSWER: GoalsAnswer = {
  aiProvider: true,
  waitsForHistory: false,
  goals: [
    goal(),
    goal({
      id: "g2",
      words: "Save $5,000 for the trip by June",
      author: "Sam",
      date: "2026-10-05",
      status: "done",
      endedOn: "2026-10-12",
      endedBy: "m2",
      reading: {
        target: { kind: "Accounts", accountIds: ["a-savings", "a-brokerage"] },
        change: { amount: 500_000 },
        deadline: "2027-06-30",
      },
      progress: {
        kind: "save toward an amount",
        percentage: 100,
        state: "Done",
        detail: "$5,000 of $5,000",
        estimated: true,
      },
    }),
    goal({
      id: "g3",
      words: "Pay off the card",
      status: "done",
      endedOn: "2026-08-03",
      list: "done",
      progress: null,
    }),
    goal({
      id: "g4",
      words: "Skip coffee shops",
      author: null,
      authorId: null,
      status: "dropped",
      endedOn: "2026-07-14",
      list: "dropped",
      progress: null,
    }),
  ],
};

const report = (answer: GoalsAnswer, onMark: (id: string, status: string) => void = () => {}) => (
  <GoalsReport answer={answer} accountNames={ACCOUNT_NAMES} today={TODAY} onMark={onMark} />
);

const render = (answer: GoalsAnswer) =>
  renderToString(<MemoryRouter>{report(answer)}</MemoryRouter>);

const text = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// The words of each <li> in the list labelled `label`.
function listItems(html: string, label: string): string[] {
  const list = new RegExp(`<ul aria-label="${label}"[^>]*>(.*?)</ul>`, "s").exec(html)?.[1] ?? "";
  return [...list.matchAll(/<li[^>]*>(.*?)<\/li>/gs)].map((item) => text(item[1] ?? ""));
}

// The buttons in a tree, by their words and the Goal they sit in, with what each does. The parts
// the tree holds have no state of their own, so each is called for its tree.
function buttonsOf(element: ReactNode): Map<string, () => void> {
  const buttons = new Map<string, () => void>();
  const words = (node: ReactNode): string =>
    typeof node === "string"
      ? node
      : Array.isArray(node)
        ? node.map(words).join("")
        : isValidElement<{ children?: ReactNode }>(node)
          ? words(node.props.children)
          : "";
  const walk = (node: ReactNode, goalId: string) => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child, goalId);
      return;
    }
    if (!isValidElement<Record<string, unknown> & { children?: ReactNode }>(node)) return;
    if (typeof node.type === "function")
      return walk((node.type as (p: unknown) => ReactNode)(node.props), goalId);
    const inGoal = typeof node.props["data-goal"] === "string" ? node.props["data-goal"] : goalId;
    if (node.type === "button")
      buttons.set(`${inGoal} ${words(node.props.children)}`, node.props.onClick as () => void);
    walk(node.props.children, inGoal);
  };
  walk(element, "");
  return buttons;
}

describe("the Goals page", () => {
  it("lists the active Goals first, each with its author, words, date, progress, and the AI's reading", () => {
    const html = render(ANSWER);

    expect(listItems(html, "Active Goals")).toEqual([
      "Alex “Spend less on eating out” ◆ Behind 62% On pace for $540 this month; Goal is $480 " +
        "Sep 2 AI Target: Restaurants · Change: 20% · Deadline: not said Mark done Mark dropped",
      "Sam “Save $5,000 for the trip by June” ✓ Done 100% estimated $5,000 of $5,000 Oct 5 " +
        "AI Target: Rainy Day Savings, Brokerage · Change: $5,000 · Deadline: Jun 30, 2027",
    ]);
    expect(html.indexOf("Active Goals")).toBeLessThan(html.indexOf('data-slot="done-list"'));
    expect(html.indexOf('data-slot="done-list"')).toBeLessThan(
      html.indexOf('data-slot="dropped-list"'),
    );
  });

  it("holds the done list and the dropped list in collapsed sections at the end", () => {
    const html = render(ANSWER);

    for (const slot of ["done-list", "dropped-list"]) {
      const open = new RegExp(`<details([^>]*)data-slot="${slot}"`).exec(html);
      expect(open).not.toBeNull();
      expect(open?.[1]).not.toContain("open");
    }
    expect(listItems(html, "Done Goals")).toEqual(["Alex “Pay off the card” Done on Aug 3"]);
    expect(listItems(html, "Dropped Goals")).toEqual([
      "A removed Member “Skip coffee shops” Dropped on Jul 14",
    ]);
    expect(text(html)).toContain("Done (1)");
    expect(text(html)).toContain("Dropped (1)");
  });

  it("marks an active Goal done or dropped, and offers neither for a Goal already done", () => {
    const marked: string[] = [];
    const buttons = buttonsOf(report(ANSWER, (id, status) => marked.push(`${id} ${status}`)));

    expect([...buttons.keys()]).toEqual(["g1 Mark done", "g1 Mark dropped"]);
    buttons.get("g1 Mark done")?.();
    buttons.get("g1 Mark dropped")?.();
    expect(marked).toEqual(["g1 done", "g1 dropped"]);
  });

  it("says that Goals need an AI provider, linking to the AI settings, with no AI provider", () => {
    const html = render({ ...ANSWER, aiProvider: false });

    expect(html).toMatch(/<a (?=[^>]*href="\/settings\/ai")[^>]*data-slot="needs-ai"/);
    expect(text(html)).toContain("Goals need an AI provider");
    expect(listItems(html, "Active Goals")).toHaveLength(2);
    expect(render(ANSWER)).not.toContain("Goals need an AI provider");
  });

  it("says so with no active Goal, and shows no empty sections", () => {
    const html = render({ ...ANSWER, goals: [] });

    expect(text(html)).toBe("No active Goal.");
  });
});

describe("Add a Goal and Edit the words", () => {
  // The form's actions, each recorded as it is called.
  function recorded(form?: GoalForm) {
    const calls: string[] = [];
    const actions: GoalFormActions = {
      form,
      onOpen: (goalId, words) => calls.push(`open ${goalId} ${words}`),
      onDraft: (draft) => calls.push(`draft ${draft}`),
      onSave: (sendAnyway) => calls.push(`save ${sendAnyway}`),
      onCancel: () => calls.push("cancel"),
    };
    return { calls, actions };
  }

  const withWriting = (answer: GoalsAnswer, actions: GoalFormActions) => (
    <GoalsReport
      answer={answer}
      accountNames={ACCOUNT_NAMES}
      today={TODAY}
      onMark={() => {}}
      writing={actions}
    />
  );
  const renderWith = (answer: GoalsAnswer, actions: GoalFormActions) =>
    renderToString(<MemoryRouter>{withWriting(answer, actions)}</MemoryRouter>);

  it("offers Add a Goal, and Edit the words on each active Goal, which open the form", () => {
    const { calls, actions } = recorded();
    const buttons = buttonsOf(withWriting(ANSWER, actions));

    expect([...buttons.keys()]).toEqual([
      " Add a Goal",
      "g1 Edit the words",
      "g1 Mark done",
      "g1 Mark dropped",
    ]);
    buttons.get(" Add a Goal")?.();
    buttons.get("g1 Edit the words")?.();
    expect(calls).toEqual(["open null ", "open g1 Spend less on eating out"]);
  });

  it("offers neither with no AI provider, or until history has loaded, and says why", () => {
    const { actions } = recorded();
    const keys = (answer: GoalsAnswer) => [...buttonsOf(withWriting(answer, actions)).keys()];
    const marks = ["g1 Mark done", "g1 Mark dropped"];

    expect(keys({ ...ANSWER, aiProvider: false })).toEqual(marks);
    expect(text(renderWith({ ...ANSWER, aiProvider: false }, actions))).toContain(
      "Goals need an AI provider",
    );
    expect(keys({ ...ANSWER, waitsForHistory: true })).toEqual(marks);
    const waiting = renderWith({ ...ANSWER, waitsForHistory: true }, actions);
    expect(waiting).toContain('data-slot="goals-wait"');
    expect(text(waiting)).toContain("Goals open when your history has loaded.");
  });

  it("shows the open form in place of Add a Goal, or of the Goal's Edit the words, with its words", () => {
    const adding = recorded({ goalId: null, draft: "Save $10,000 for a house", busy: false });
    const html = renderWith(ANSWER, adding.actions);
    expect(html).toContain("Save $10,000 for a house</textarea>");
    expect([...buttonsOf(withWriting(ANSWER, adding.actions)).keys()]).toEqual([
      " Save",
      " Cancel",
      "g1 Edit the words",
      "g1 Mark done",
      "g1 Mark dropped",
    ]);

    const editing = recorded({ goalId: "g1", draft: "Spend less on eating out", busy: false });
    const buttons = buttonsOf(withWriting(ANSWER, editing.actions));
    expect([...buttons.keys()]).toEqual([
      " Add a Goal",
      "g1 Save",
      "g1 Cancel",
      "g1 Mark done",
      "g1 Mark dropped",
    ]);
    buttons.get("g1 Cancel")?.();
    expect(editing.calls).toEqual(["cancel"]);
  });

  it('asks "Send anyway?" past the AI cost cap, and sends the yes', () => {
    const problem = {
      error: "Reading this Goal is past the AI cost cap. Send anyway?",
      sendAnyway: true,
      tryAgain: false,
    };
    const { calls, actions } = recorded({ goalId: null, draft: "Save more", busy: false, problem });
    const buttons = buttonsOf(withWriting(ANSWER, actions));

    expect(text(renderWith(ANSWER, actions))).toContain(problem.error);
    expect(buttons.has(" Save")).toBe(false);
    buttons.get(" Send anyway")?.();
    expect(calls).toEqual(["save true"]);
  });

  it('shows a failed reading with "Try again", which sends again only when pressed', () => {
    const problem = {
      error: "The AI did not answer within 120 seconds.",
      sendAnyway: false,
      tryAgain: true,
    };
    const form = { goalId: "g1", draft: "Spend less", busy: false, problem };
    const first = recorded(form);
    expect(text(renderWith(ANSWER, first.actions))).toContain(problem.error);
    expect(first.calls).toEqual([]);
    buttonsOf(withWriting(ANSWER, first.actions)).get("g1 Try again")?.();
    expect(first.calls).toEqual(["save false"]);

    // After "Send anyway", "Try again" sends the same yes.
    const anyway = recorded({ ...form, sentAnyway: true });
    buttonsOf(withWriting(ANSWER, anyway.actions)).get("g1 Try again")?.();
    expect(anyway.calls).toEqual(["save true"]);
  });
});

describe("long words", () => {
  it("wrap a Goal's one long word in the active, done and dropped lists, so no page scrolls sideways", () => {
    const long = "x".repeat(90);
    const html = render({
      ...ANSWER,
      goals: ANSWER.goals.map((each) => ({ ...each, words: long })),
    });
    const wrapped = html.match(
      new RegExp(
        `<span class="[^"]*\\bwrap-anywhere\\b[^"]*" data-slot="goal-words">“(?:<!-- -->)?${long}`,
        "g",
      ),
    );
    expect(wrapped).toHaveLength(4);
  });
});

describe("the AI's reading", () => {
  it("names each kind of target, and says which fields the words do not say", () => {
    const parts = (reading: GoalView["reading"]) => readingParts(reading, ACCOUNT_NAMES, TODAY);

    expect(parts({ target: null, change: null, deadline: null })).toEqual({
      target: "not said",
      change: "not said",
      deadline: "not said",
    });
    expect(
      parts({
        target: { kind: "Merchant", merchant: { id: null, name: "Bluebird Books" } },
        change: { amount: 10_000 },
        deadline: "2026-12-31",
      }),
    ).toEqual({ target: "Bluebird Books", change: "$100", deadline: "Dec 31" });
    expect(parts({ target: { kind: "Saving" }, change: null, deadline: null }).target).toBe(
      "Saving",
    );
    expect(
      parts({ target: { kind: "loan", accountId: "gone" }, change: null, deadline: null }).target,
    ).toBe("an Account no longer here");
  });
});

describe("Mark done and Mark dropped", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("post the status as JSON to the Goal's status route", async () => {
    const sent: { line: string; type: string | null; body: string }[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(
        new URL(String(input instanceof Request ? input.url : input), "http://app"),
        {
          ...(input instanceof Request ? input : {}),
          ...init,
        },
      );
      sent.push({
        line: `${request.method} ${new URL(request.url).pathname}`,
        type: request.headers.get("content-type"),
        body: await request.text(),
      });
      return Response.json({ goal: {} });
    });

    expect(await markGoal("g1", "dropped")).toBeUndefined();
    expect(sent).toEqual([
      { line: "POST /api/goals/g1/status", type: "application/json", body: '{"status":"dropped"}' },
    ]);
  });

  it("answers the route's error, such as for a Goal no longer active", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json(
        { error: "Only an active Goal can be marked done or dropped." },
        { status: 409 },
      ),
    );

    expect(await markGoal("g1", "done")).toBe("Only an active Goal can be marked done or dropped.");
  });
});

describe("saving a Goal", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Each request the page sends, and the answer to each.
  function recordRequests(answer: { status: number; body: unknown }) {
    const sent: { line: string; type: string | null; body: string }[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(
        new URL(String(input instanceof Request ? input.url : input), "http://app"),
        { ...(input instanceof Request ? input : {}), ...init },
      );
      sent.push({
        line: `${request.method} ${new URL(request.url).pathname}`,
        type: request.headers.get("content-type"),
        body: await request.text(),
      });
      return Response.json(answer.body, { status: answer.status });
    });
    return sent;
  }

  it("posts a new Goal's words, or a Goal's new words, as JSON with the Member's yes", async () => {
    const sent = recordRequests({ status: 200, body: { goal: {} } });

    expect(await saveGoal(null, "Save $10,000 for a house", false)).toBeUndefined();
    expect(await saveGoal("g1", "Spend 20% less on restaurants", true)).toBeUndefined();
    expect(sent).toEqual([
      {
        line: "POST /api/goals",
        type: "application/json",
        body: '{"words":"Save $10,000 for a house","sendAnyway":false}',
      },
      {
        line: "POST /api/goals/g1/words",
        type: "application/json",
        body: '{"words":"Spend 20% less on restaurants","sendAnyway":true}',
      },
    ]);
  });

  it('reads "Send anyway?", a failed reading, and any other refusal', async () => {
    recordRequests({
      status: 409,
      body: { error: "Past the cap. Send anyway?", pause: "send anyway?" },
    });
    expect(await saveGoal(null, "Save more", false)).toEqual({
      error: "Past the cap. Send anyway?",
      sendAnyway: true,
      tryAgain: false,
    });

    recordRequests({ status: 504, body: { error: "No answer.", tryAgain: true } });
    expect(await saveGoal(null, "Save more", false)).toEqual({
      error: "No answer.",
      sendAnyway: false,
      tryAgain: true,
    });

    recordRequests({
      status: 409,
      body: { error: "Goals need an AI provider", pause: "no AI provider" },
    });
    expect(await saveGoal(null, "Save more", false)).toEqual({
      error: "Goals need an AI provider",
      sendAnyway: false,
      tryAgain: false,
    });
  });
});
