import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PlaidView } from "../../../bank/plaid-view.ts";
import type { AccountView, ConnectionView } from "../../../server/bank-views.ts";
import {
  BeforeLink,
  ConnectionItem,
  FakeBankLink,
  ImportConnection,
  ImportPreviewList,
  LinkBank,
  LinkFailed,
  LinkProgress,
  LinkWaiting,
  linkExitProblem,
  linkedConnection,
  linkResultOf,
  NewBankLinks,
  PLAID_LINK_SCRIPT,
  syncState,
  UpdateMode,
} from "./Connections.tsx";
import {
  type ConnectionsPageView,
  type HistoryLoadingView,
  SYNC_POLL,
  syncKey,
  syncRunning,
} from "./connections-page.ts";

// Settings → Banks: the Connections, and what the Member reads before Plaid Link opens.

const KEYS_SET: PlaidView = {
  clientId: "client-id-shown",
  secretSet: true,
  itemsUsed: 2,
  appItems: 2,
  itemLimit: 10,
};

const CONNECTION: ConnectionView = {
  id: "c1",
  provider: "plaid",
  bankName: "First Bank",
  health: "healthy",
  historyLoaded: true,
  lastSyncedAt: null,
  nextSyncAt: null,
  actions: { repairInApp: true, importExisting: true, refresh: true },
  removed: false,
  held: false,
};

const ACCOUNT: AccountView = {
  id: "a1",
  connectionId: "c1",
  name: "Checking",
  kind: "depository",
  subtype: "checking",
  institutionName: "First Bank",
  mask: "1234",
  currentBalance: 100,
  availableBalance: 100,
  creditLimit: null,
  estimated: false,
  excluded: false,
  closed: false,
  closedAt: null,
};

const text = (html: string) => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, "");

describe("Settings → Banks: linking a new bank", () => {
  it("lists the banks and Accounts already connected, gives the advice, and shows at least N of 10 used", () => {
    const shown = text(
      renderToString(
        <BeforeLink plaid={KEYS_SET} connections={[CONNECTION]} accounts={[ACCOUNT]} />,
      ),
    );

    expect(shown).toContain("First Bank");
    expect(shown).toContain("Checking ··1234");
    expect(shown).toContain("Link each bank once.");
    expect(shown).toContain("Pick every Account at the bank the first time");
    expect(shown).toContain("At least 2 of 10 used");
  });

  it("says linking is blocked at N of 10", () => {
    const shown = text(
      renderToString(
        <BeforeLink plaid={{ ...KEYS_SET, itemsUsed: 10 }} connections={[]} accounts={[]} />,
      ),
    );

    expect(shown).toContain("At least 10 of 10 used");
    expect(shown).toContain("cannot link a new bank");
  });

  it("offers Link only once the Plaid keys are set", () => {
    const none = { ...KEYS_SET, clientId: null, secretSet: false };

    expect(
      text(
        renderToString(
          <LinkBank plaid={none} connections={[]} accounts={[]} onLinked={() => {}} />,
        ),
      ),
    ).toContain("To link a real bank through Plaid, save the Plaid keys above.");
    expect(
      text(
        renderToString(
          <LinkBank plaid={KEYS_SET} connections={[]} accounts={[]} onLinked={() => {}} />,
        ),
      ),
    ).toContain("Link a new bank");
  });

  it("loads Plaid's script from Plaid's CDN over HTTPS", () => {
    expect(new URL(PLAID_LINK_SCRIPT).origin).toBe("https://cdn.plaid.com");
  });

  it("sends the server the institution and each Account's type and last 4 digits from Link's metadata", () => {
    expect(
      linkResultOf("public-token-from-link", {
        institution: { institution_id: "ins_1", name: "First Bank" },
        accounts: [{ name: "Card", mask: "9876", type: "credit", subtype: "credit card" }],
      }),
    ).toEqual({
      publicToken: "public-token-from-link",
      bankId: "ins_1",
      bankName: "First Bank",
      accounts: [{ name: "Card", type: "credit", subtype: "credit card", mask: "9876" }],
    });
    expect(linkResultOf("public-token-from-link", { institution: null, accounts: [] })).toBe(
      undefined,
    );
  });
});

describe("Settings → Banks: Import Plaid Connection", () => {
  it("is offered next to Link a new bank once the Plaid keys are set", () => {
    const shown = text(renderToString(<ImportConnection plaid={KEYS_SET} onImported={() => {}} />));
    const none = renderToString(
      <ImportConnection plaid={{ ...KEYS_SET, secretSet: false }} onImported={() => {}} />,
    );

    expect(shown).toContain("Import Plaid Connection");
    expect(none).toBe("");
  });

  it("shows the bank and each Account's last 4 digits before it saves", () => {
    const shown = text(
      renderToString(
        <ImportPreviewList
          preview={{
            bankName: "First Bank",
            accounts: [
              { name: "Checking", type: "depository", subtype: "checking", mask: "1234" },
              { name: "Loan", type: "loan", subtype: null, mask: null },
            ],
          }}
        />,
      ),
    );

    expect(shown).toContain("First Bank");
    expect(shown).toContain("Checking ··1234");
    expect(shown).toContain("Loan");
  });
});

describe("Settings → Banks: the fake bank, under `pnpm dev` only", () => {
  it("offers Link a fake bank only when the server says the fake adapter runs", () => {
    const shown = text(renderToString(<FakeBankLink offered={true} onLinked={() => {}} />));
    const none = renderToString(<FakeBankLink offered={false} onLinked={() => {}} />);

    expect(shown).toContain("Link a fake bank (dev only)");
    expect(none).toBe("");
  });
});

describe("Settings → Banks: removing a Connection", () => {
  const item = (connection: ConnectionView, accounts: AccountView[]) =>
    text(
      renderToString(
        <ConnectionItem connection={connection} accounts={accounts} onChanged={() => {}} />,
      ),
    );

  it("offers Remove on each Connection, with its Accounts", () => {
    const shown = item(CONNECTION, [ACCOUNT]);

    expect(shown).toContain("First Bank");
    expect(shown).toContain("Checking ··1234");
    expect(shown).toContain("Remove");
    expect(shown).not.toContain("Delete history");
  });

  it("offers Delete history on a removed Connection that still has Accounts, and hides one with none", () => {
    const removed = { ...CONNECTION, removed: true };
    const closed = { ...ACCOUNT, closed: true };

    const shown = item(removed, [closed]);
    expect(shown).toContain("First Bank (Removed)");
    expect(shown).toContain("Checking ··1234 (Closed)");
    expect(shown).toContain("Delete history");
    expect(shown).not.toMatch(/\bRemove\b(?! )/);
    expect(item(removed, [])).toBe("");
  });
});

describe("Settings → Banks: Repair, Link again, and Add accounts", () => {
  const item = (connection: ConnectionView) =>
    text(
      renderToString(
        <ConnectionItem
          connection={connection}
          accounts={[ACCOUNT]}
          onChanged={() => {}}
          linkAgain={<span>LINK AGAIN SHOWN</span>}
        />,
      ),
    );

  it("offers Repair and Add accounts on a Connection that needs a Member", () => {
    const shown = item({ ...CONNECTION, health: "needs a member" });

    expect(shown).toContain("Needs you to sign in again");
    // "use Repair" in the note, and the Repair button.
    expect(shown.match(/Repair/g)).toHaveLength(2);
    expect(shown).toContain("Add accounts");
    expect(shown).not.toContain("LINK AGAIN SHOWN");
  });

  it("draws Repair as a filled serious button and Add accounts as an outlined one", () => {
    const html = renderToString(
      <UpdateMode
        connection={{ ...CONNECTION, health: "needs a member" }}
        addAccounts={false}
        onChanged={() => {}}
      />,
    );
    const addAccounts = renderToString(
      <UpdateMode
        connection={{ ...CONNECTION, health: "needs a member" }}
        addAccounts={true}
        onChanged={() => {}}
      />,
    );

    expect(html).toMatch(
      /<button type="button" class="[^"]*bg-serious[^"]*text-white[^"]*">Repair/,
    );
    expect(addAccounts).not.toContain("bg-serious");
  });

  it("offers Link again, not Repair or Add accounts, on a Broken Connection", () => {
    const shown = item({ ...CONNECTION, health: "broken" });

    expect(shown).toContain("LINK AGAIN SHOWN");
    expect(shown).not.toContain("Repair");
    expect(shown).not.toContain("Add accounts");
  });

  it("offers Add accounts on every Connection that is not Broken or removed", () => {
    for (const health of ["healthy", "retrying"] as const) {
      const shown = item({ ...CONNECTION, health });
      expect(shown).toContain("Add accounts");
      expect(shown).not.toContain("Repair");
    }
    expect(item({ ...CONNECTION, removed: true })).not.toContain("Add accounts");
  });

  it("shows a held Connection as not in use, with Remove and nothing that would sync it", () => {
    const shown = item({ ...CONNECTION, held: true });

    expect(shown).toContain("Not in use: another Connection already covers this bank");
    expect(shown).toContain("Remove");
    expect(shown).not.toContain("Add accounts");
    expect(shown).not.toContain("Repair");
  });

  it("names Link again for the Broken Connection it replaces", () => {
    const shown = text(
      renderToString(
        <LinkBank
          plaid={KEYS_SET}
          connections={[]}
          accounts={[]}
          onLinked={() => {}}
          replaces={{ ...CONNECTION, health: "broken" }}
        />,
      ),
    );

    expect(shown).toContain("Link again");
    expect(shown).not.toContain("Link a new bank");
  });
});

describe("Settings → Banks: a new bank's first sync, with no reload", () => {
  const NEW: ConnectionView = { ...CONNECTION, id: "c2", bankName: "Harbor Savings Bank" };
  const FIRST_SYNC: ConnectionView = { ...NEW, historyLoaded: false, lastSyncedAt: null };
  const SYNCED: ConnectionView = { ...FIRST_SYNC, lastSyncedAt: "2026-11-06T14:42:00.000Z" };
  const HARBOR: AccountView[] = [
    {
      ...ACCOUNT,
      id: "a2",
      connectionId: "c2",
      name: "Harbor Checking",
      mask: "2290",
      currentBalance: 190_245,
    },
    {
      ...ACCOUNT,
      id: "a3",
      connectionId: "c2",
      name: "Harbor Mortgage",
      kind: "loan",
      mask: "8813",
      currentBalance: -21_488_010,
    },
  ];
  const LOADING: HistoryLoadingView = {
    connectionId: "c2",
    bankName: "Harbor Savings Bank",
    transactions: 312,
    oldestDate: "2025-08-14",
    holdsBackAi: true,
  };

  const progress = (
    connection: ConnectionView | undefined,
    poll: "polling" | "ended" | "gave up",
  ) =>
    text(
      renderToString(
        <LinkProgress
          bankName="Harbor Savings Bank"
          connection={connection}
          accounts={connection?.lastSyncedAt ? HARBOR : []}
          loading={LOADING}
          poll={poll}
        />,
      ),
    );

  it("shows Plaid opening, then the server saving the bank", () => {
    expect(text(renderToString(<LinkWaiting />))).toBe(
      "Opening Plaid…Plaid&#x27;s window opens over this page.",
    );
    expect(text(renderToString(<LinkWaiting saving="Harbor Savings Bank" />))).toBe(
      "Saving Harbor Savings Bank…Plaid is confirming the bank. This takes a few seconds.",
    );
  });

  it("shows the new Connection at once while its first sync runs", () => {
    for (const connection of [undefined, FIRST_SYNC]) {
      const shown = progress(connection, "polling");
      expect(shown).toContain("Harbor Savings Bank is linked");
      expect(shown).toContain("Getting your Accounts from the bank…");
      expect(shown).toContain(
        "They show here in about a minute. You can leave this page; nothing stops.",
      );
    }
    expect(progress({ ...FIRST_SYNC, health: "retrying" }, "polling")).toContain(
      "the app tries again by itself",
    );
  });

  it("shows the Accounts with their balances and the history progress once the first sync stored them", () => {
    const shown = progress(SYNCED, "polling");

    // A status: its icon, its color, and its words.
    expect(shown).toContain("✓ 2 Accounts found");
    const html = renderToString(
      <LinkProgress
        bankName="Harbor Savings Bank"
        connection={SYNCED}
        accounts={HARBOR}
        loading={LOADING}
        poll="polling"
      />,
    );
    expect(html).toContain(
      '<span class="text-good"><span aria-hidden="true">✓ </span>2 Accounts found',
    );
    expect(shown).toContain("Harbor Checking ··2290$1,902.45");
    expect(shown).toContain("Harbor Mortgage ··8813−$214,880.10");
    expect(shown).toContain("History is loading: 312 Transactions so far, back to Aug 2025.");
    expect(progress({ ...SYNCED, historyLoaded: true }, "ended")).not.toContain(
      "History is loading",
    );
  });

  it("says so when it gives up waiting, and when the first sync stops on a Member", () => {
    expect(progress(FIRST_SYNC, "gave up")).toContain(
      "The first sync is taking longer than usual, so this page stopped checking. It still runs: reload the page later to see the Accounts.",
    );
    expect(progress({ ...FIRST_SYNC, health: "needs a member" }, "ended")).toContain(
      "The bank asked for a new sign-in before the first sync finished.",
    );
    expect(progress({ ...FIRST_SYNC, health: "broken" }, "ended")).toContain(
      "The bank disconnected before the first sync finished.",
    );
  });

  it("keeps reading only while a first sync or history load runs on a Connection that can sync", () => {
    expect(syncRunning(FIRST_SYNC)).toBe(true);
    expect(syncRunning(SYNCED)).toBe(true);
    expect(syncRunning({ ...SYNCED, historyLoaded: true })).toBe(false);
    expect(syncRunning({ ...FIRST_SYNC, health: "retrying" })).toBe(true);
    for (const stopped of [
      { ...FIRST_SYNC, health: "needs a member" as const },
      { ...FIRST_SYNC, health: "broken" as const },
      { ...FIRST_SYNC, removed: true },
      { ...FIRST_SYNC, held: true },
    ]) {
      expect(syncRunning(stopped)).toBe(false);
    }
    // At most 10 minutes of reads.
    expect(SYNC_POLL.everyMs * SYNC_POLL.maxReads).toBeLessThanOrEqual(10 * 60_000);
  });

  it("reads the Accounts again only when a sync finished or a Connection changed state", () => {
    const before = syncKey([CONNECTION, FIRST_SYNC]);

    expect(syncKey([CONNECTION, { ...FIRST_SYNC }])).toBe(before);
    expect(syncKey([CONNECTION, SYNCED])).not.toBe(before);
    expect(syncKey([CONNECTION, { ...FIRST_SYNC, historyLoaded: true }])).not.toBe(before);
    expect(syncKey([CONNECTION, { ...FIRST_SYNC, health: "retrying" }])).not.toBe(before);
    expect(syncKey([CONNECTION, { ...FIRST_SYNC, removed: true }])).not.toBe(before);
    expect(syncKey([CONNECTION, { ...FIRST_SYNC, held: true }])).not.toBe(before);
    expect(syncKey([CONNECTION])).not.toBe(before);
  });

  it("shows each Connection's first sync, history load, or last sync in its row", () => {
    const now = new Date("2026-11-06T18:00:00.000Z");
    const zone = "America/New_York";

    expect(syncState(FIRST_SYNC, undefined, "polling", now, zone)).toEqual({
      word: "First sync running",
      detail: "Getting the Accounts from the bank. Updates by itself.",
    });
    expect(syncState(SYNCED, LOADING, "polling", now, zone)).toEqual({
      word: "Loading history",
      detail: "312 Transactions so far, back to Aug 2025. Updates by itself.",
    });
    expect(syncState(SYNCED, LOADING, "gave up", now, zone)?.detail).toBe(
      "312 Transactions so far, back to Aug 2025. Reload the page to see newer progress.",
    );
    expect(syncState({ ...SYNCED, historyLoaded: true }, undefined, "ended", now, zone)).toEqual({
      word: "Synced 9:42 AM",
      detail: null,
    });
    expect(
      syncState(
        { ...SYNCED, historyLoaded: true, lastSyncedAt: "2026-11-03T14:42:00.000Z" },
        undefined,
        "ended",
        now,
        zone,
      )?.word,
    ).toBe("Synced Nov 3, 9:42 AM");
    // The last sync's time waits for the Household time zone; the first sync does not.
    expect(syncState({ ...SYNCED, historyLoaded: true }, undefined, "ended", now, undefined)).toBe(
      null,
    );
    expect(syncState(FIRST_SYNC, undefined, "polling", now, undefined)?.word).toBe(
      "First sync running",
    );
    for (const own of [
      { ...SYNCED, removed: true },
      { ...SYNCED, held: true },
      { ...SYNCED, health: "needs a member" as const },
      { ...SYNCED, health: "broken" as const },
    ]) {
      expect(syncState(own, LOADING, "polling", now, zone)).toBeNull();
    }

    const row = text(
      renderToString(
        <ConnectionItem
          connection={SYNCED}
          accounts={HARBOR}
          loading={LOADING}
          poll="polling"
          onChanged={() => {}}
        />,
      ),
    );
    expect(row).toContain("Harbor Savings Bank● Loading history");
    expect(row).toContain("312 Transactions so far, back to Aug 2025. Updates by itself.");
    expect(row).toContain("Harbor Checking ··2290$1,902.45");
  });

  it("takes the new Connection from the server's answer, never from Link's metadata", () => {
    expect(linkedConnection({ connection: { id: "c2", bankName: "Harbor Savings Bank" } })).toEqual(
      {
        connectionId: "c2",
        bankName: "Harbor Savings Bank",
      },
    );
    expect(linkedConnection({ error: "Harbor Savings Bank is already linked." })).toBeUndefined();
    expect(linkedConnection({ connection: { id: 2, bankName: "Harbor" } })).toBeUndefined();
  });

  it("follows the dev fake bank's first sync the same way", () => {
    expect(
      text(
        renderToString(
          <FakeBankLink
            offered={true}
            onLinked={() => {}}
            connections={[SYNCED]}
            accounts={HARBOR}
          />,
        ),
      ),
    ).toContain("Link a fake bank (dev only)");
  });
});

describe("Settings → Banks: Plaid Link closing with an error", () => {
  it("is nothing to report when the Member closed Link", () => {
    expect(linkExitProblem(null)).toBeUndefined();
  });

  it("puts a known code in plain words, with the code", () => {
    expect(linkExitProblem({ error_code: "INSTITUTION_DOWN", display_message: "Ignored" })).toEqual(
      {
        words: "The bank is not answering Plaid right now. Try again in a few hours.",
        code: "INSTITUTION_DOWN",
      },
    );
    expect(linkExitProblem({ error_code: "ITEM_LOCKED" })?.words).toContain("locked the sign-in");
  });

  it("shows Plaid's message for the Member for an unknown code, as one plain line", () => {
    expect(
      linkExitProblem({
        error_code: "SOME_NEW_CODE",
        display_message: "  The bank\nis\tbusy.\u0000  ",
      }),
    ).toEqual({ words: "The bank is busy.", code: "SOME_NEW_CODE" });
    expect(linkExitProblem({ display_message: "x".repeat(500) })?.words).toHaveLength(200);
  });

  it("drops format characters, so a right-to-left override cannot turn the app's words around", () => {
    // A right-to-left override, zero-width space, word joiner, byte order mark, left-to-right
    // isolate and its end, and a soft hyphen: all format characters, none of them visible.
    const [rlo, zwsp, joiner, bom, isolate, isolateEnd, softHyphen] = [
      0x202e, 0x200b, 0x2060, 0xfeff, 0x2066, 0x2069, 0xad,
    ].map((point) => String.fromCodePoint(point));
    const problem = linkExitProblem({
      display_message: `Try later${rlo}.tnepS saw metI${zwsp}${joiner}${bom}${isolate}x${isolateEnd}${softHyphen}`,
    }) ?? { words: "", code: null };
    expect(problem.words).toBe("Try later.tnepS saw metIx");
    expect(problem.words).not.toMatch(/\p{Cf}/u);

    const html = renderToString(
      <LinkFailed problem={problem} onRetry={() => {}} onClose={() => {}} />,
    );
    expect(html).not.toMatch(/\p{Cf}/u);
    expect(text(html)).toContain("Nothing was saved, and no Item was spent.");
  });

  it("cuts a long message at 200 code points, never inside an emoji or a letter's marks", () => {
    const at = (words: string | undefined) => Array.from(words ?? "");
    const x = (n: number) => "x".repeat(n);
    const joiner = String.fromCodePoint(0x200d);
    const acute = String.fromCodePoint(0x301);
    // 199 letters, then emoji of two UTF-16 units each: the cut counts each emoji as one code
    // point, so the first stays whole and no lone surrogate is left.
    const emoji = linkExitProblem({ display_message: `${x(199)}😀😀` })?.words;
    expect(emoji).toBe(`${x(199)}😀`);
    expect(emoji?.isWellFormed()).toBe(true);
    expect(linkExitProblem({ display_message: `${x(200)}😀` })?.words).toBe(x(200));
    // A family emoji is one grapheme of seven code points, held by joiners: whole, or not at all.
    const family = ["👨", "👩", "👧", "👦"].join(joiner);
    expect(linkExitProblem({ display_message: `${x(193)}${family}` })?.words).toBe(
      `${x(193)}${family}`,
    );
    expect(linkExitProblem({ display_message: `${x(195)}${family}` })?.words).toBe(x(195));
    // A letter with its mark is not split from it.
    expect(linkExitProblem({ display_message: `${x(199)}e${acute}` })?.words).toBe(x(199));
    // A lone surrogate from Plaid becomes a replacement character, not a broken string.
    const lone = String.fromCharCode(0xd83d);
    expect(linkExitProblem({ display_message: `Busy ${lone} now` })?.words).toBe(
      `Busy ${String.fromCodePoint(0xfffd)} now`,
    );
    // One grapheme longer than the limit is cut by code points rather than dropped.
    expect(at(linkExitProblem({ display_message: `e${acute.repeat(500)}` })?.words)).toHaveLength(
      200,
    );
  });

  it("never shows a malformed code or any other part of the error", () => {
    const shown = linkExitProblem({
      error_code: "<img src=x onerror=alert(1)>",
      display_message: null,
      error_message: "access-sandbox-0000 internal detail",
      request_id: "req-123",
    } as never);

    expect(shown).toEqual({ words: "Plaid closed before the bank was linked.", code: null });
    expect(linkExitProblem({ error_code: "lower_case" })?.code).toBeNull();
    expect(linkExitProblem({ error_code: { nested: "INSTITUTION_DOWN" } })?.code).toBeNull();
  });

  it("says the bank was not linked, why, Plaid's code, and that no Item was spent", () => {
    const shown = text(
      renderToString(
        <LinkFailed
          problem={{
            words: "The bank is not answering Plaid right now. Try again in a few hours.",
            code: "INSTITUTION_DOWN",
          }}
          onRetry={() => {}}
          onClose={() => {}}
        />,
      ),
    );

    expect(shown).toBe(
      "▲ The bank was not linkedThe bank is not answering Plaid right now. Try again in a few hours. Nothing was saved, and no Item was spent.Plaid code: INSTITUTION_DOWNTry againClose",
    );
  });
});

// Every element of `type` in a component's answer, at any depth. Components that use no hooks are
// called directly, so a test reads what each child is handed.
function elementsOf<P>(node: ReactNode, type: (props: P) => ReactNode): ReactElement<P>[] {
  if (Array.isArray(node)) return node.flatMap((child: ReactNode) => elementsOf(child, type));
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  const own = node.type === type ? [node as unknown as ReactElement<P>] : [];
  return [...own, ...elementsOf(node.props.children, type)];
}

describe("Settings → Banks and the wizard's step 5: what the Link panels are handed", () => {
  const REMOVED: ConnectionView = { ...CONNECTION, id: "c0", bankName: "Gone Bank", removed: true };
  const FIRST_SYNC: ConnectionView = { ...CONNECTION, id: "c2", bankName: "Harbor Savings Bank" };
  const LOADING: HistoryLoadingView = {
    connectionId: "c2",
    bankName: "Harbor Savings Bank",
    transactions: 312,
    oldestDate: "2025-08-14",
    holdsBackAi: true,
  };
  const VIEW: ConnectionsPageView = {
    connections: [REMOVED, CONNECTION, FIRST_SYNC],
    accounts: [ACCOUNT],
    loading: [LOADING],
    fakeBank: true,
    error: undefined,
    poll: "polling",
  };
  const onLinked = () => {};
  const answer = NewBankLinks({ plaid: KEYS_SET, view: VIEW, onLinked, children: "Import" });

  it("hands Link a new bank what the page last read, with no removed Connection", () => {
    const [link, ...more] = elementsOf(answer, LinkBank);
    expect(more).toEqual([]);
    expect(link?.props).toEqual({
      plaid: KEYS_SET,
      connections: [CONNECTION, FIRST_SYNC],
      accounts: [ACCOUNT],
      onLinked,
      loading: [LOADING],
      poll: "polling",
    });
  });

  it("hands the fake bank the whole view, so its panel follows the first sync", () => {
    const [fake, ...more] = elementsOf(answer, FakeBankLink);
    expect(more).toEqual([]);
    expect(fake?.props).toEqual({
      offered: true,
      onLinked,
      connections: VIEW.connections,
      accounts: [ACCOUNT],
      loading: [LOADING],
      poll: "polling",
    });
  });

  it("shows Settings → Banks' Import between the two", () => {
    expect(text(renderToString(answer))).toMatch(/^Link a new bankImportLink a fake bank/);
  });

  it('leaves a removed Connection out of "Already connected"', () => {
    const [link] = elementsOf(answer, LinkBank);
    const before = text(
      renderToString(
        <BeforeLink
          plaid={KEYS_SET}
          connections={link?.props.connections ?? []}
          accounts={[ACCOUNT]}
        />,
      ),
    );
    expect(before).toContain("First Bank");
    expect(before).toContain("Harbor Savings Bank");
    expect(before).not.toContain("Gone Bank");
  });
});
