import { type ReactNode, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import type { LinkedAccount } from "../../../bank/adapter.ts";
import { CONFIRM_ITEMS_FROM } from "../../../bank/connect-view.ts";
import type { PlaidView } from "../../../bank/plaid-view.ts";
import {
  calendarDateIn,
  dateLabel,
  dollarsAndCents,
  monthLabel,
  timeLabel,
} from "../../../format.ts";
import type { AccountView, ConnectionView, HistoryStatusView } from "../../../server/bank-views.ts";
import { api } from "../../api.ts";
import { Button } from "../../components/Button.tsx";
import { ErrorLine } from "../../components/Fields.tsx";
import { StatusText } from "../../components/Status.tsx";
import type { PollState } from "../../polling.ts";
import { SignedOut } from "../../requests.ts";
import {
  CONNECTIONS_UNREAD,
  type ConnectionsPage,
  type ConnectionsPageView,
  type ConnectionsReads,
  createConnectionsPage,
  type HistoryLoadingView,
  Refused,
} from "./connections-page.ts";
import { BOX, BUTTONS, CHOICE, HINT, LABEL, SettingCard } from "./settings-ui.tsx";

// Settings → Banks: the Connections, and "Link a new bank" through Plaid Link (spec 02, Linking a
// new bank and The 10 lifetime Items). The browser never sees an access token: it hands Link's
// public token to the server once, and the server exchanges it. Repair and Add accounts open Link
// in update mode, which keeps the Connection and its access token; Link's public token is then
// sent nowhere (spec 02, Repair and New accounts at a bank).

// Plaid's Link script. Plaid requires that it load from Plaid's own CDN, never bundled or hosted
// here.
export const PLAID_LINK_SCRIPT = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";

// The parts of Link's onSuccess metadata the app reads: the institution, and each Account the
// Member picked with its last 4 digits.
export type PlaidLinkMetadata = {
  institution: { institution_id: string; name: string } | null;
  accounts: { name: string; mask: string | null; type: string; subtype: string | null }[];
};

// Link's onExit error, or null when the Member closed Link. The app reads only the code and
// Plaid's message for the Member, and checks both, since they come from a script the app does not
// own.
export type PlaidLinkExit = { error_code?: unknown; display_message?: unknown } | null;

type PlaidLinkHandler = { open(): void; destroy(): void };
type PlaidLink = {
  create(config: {
    token: string;
    onSuccess(publicToken: string, metadata: PlaidLinkMetadata): void;
    onExit(error: PlaidLinkExit): void;
  }): PlaidLinkHandler;
};

// Why Link closed with an error: plain words, and Plaid's code when it is a well-formed one.
export type LinkExitProblem = { words: string; code: string | null };

// Plain words for the error codes Plaid Link most often closes with.
const EXIT_WORDS: Record<string, string> = {
  INSTITUTION_DOWN: "The bank is not answering Plaid right now. Try again in a few hours.",
  INSTITUTION_NOT_RESPONDING:
    "The bank is not answering Plaid right now. Try again in a few hours.",
  INSTITUTION_NOT_AVAILABLE: "Plaid cannot reach this bank right now. Try again later.",
  INSTITUTION_NO_LONGER_SUPPORTED: "Plaid no longer connects to this bank.",
  PLANNED_MAINTENANCE: "The bank is down for planned upkeep. Try again later.",
  INVALID_CREDENTIALS: "The bank did not accept the username or password.",
  INVALID_MFA: "The bank did not accept the security code.",
  INSUFFICIENT_CREDENTIALS: "The bank sign-in did not finish.",
  ITEM_LOCKED:
    "The bank locked the sign-in after too many tries. Unlock it on the bank's own site, then try again.",
  USER_SETUP_REQUIRED:
    "The bank needs you to finish something on its own site first, such as new terms. Do that, then try again.",
  MFA_NOT_SUPPORTED: "Plaid cannot pass this bank's kind of security check.",
  NO_ACCOUNTS: "Plaid found no Accounts it can connect at this bank.",
  ITEM_NOT_SUPPORTED: "Plaid cannot connect this kind of Account.",
  ACCESS_NOT_GRANTED: "The bank did not share the Accounts with Plaid.",
  RATE_LIMIT_EXCEEDED: "Too many tries in a short time. Wait a few minutes, then try again.",
  INTERNAL_SERVER_ERROR: "Plaid had a problem on its side. Try again later.",
  INVALID_LINK_TOKEN: "The Plaid window was open too long. Try again.",
};

// Plaid's codes are upper case words joined by underscores.
const PLAID_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
// Plaid's message for the Member is short; anything longer is cut.
const MESSAGE_LIMIT = 200;

// What to tell the Member when Link closes: undefined when the Member closed it (Link then gives no
// error), or the plain words for Plaid's code, else Plaid's own message for the Member as plain
// text, else a general line. Nothing else from the error is shown.
export function linkExitProblem(exit: PlaidLinkExit): LinkExitProblem | undefined {
  if (exit === null || typeof exit !== "object") return undefined;
  const code =
    typeof exit.error_code === "string" && PLAID_CODE.test(exit.error_code)
      ? exit.error_code
      : null;
  const message =
    typeof exit.display_message === "string" ? plainMessage(exit.display_message) : "";
  const words =
    (code === null ? undefined : EXIT_WORDS[code]) ??
    (message === "" ? "Plaid closed before the bank was linked." : message);
  return { words, code };
}

// Plaid's message as one line of plain text. Control characters become spaces, and runs of space
// become one. Format characters go, so a right-to-left override cannot turn the app's own words
// after it around, and nothing hides in a zero-width one. The two joiners stay: an emoji such as a
// family is joined by one, and they reorder nothing. A long message is cut at MESSAGE_LIMIT code
// points, between two graphemes, so the cut never splits an emoji or a letter from its marks.
function plainMessage(text: string): string {
  const line = text
    .toWellFormed()
    .replace(/\p{Cc}/gu, " ")
    .replace(/(?![\u200C\u200D])\p{Cf}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  let cut = "";
  let points = 0;
  for (const { segment } of new Intl.Segmenter("en", { granularity: "grapheme" }).segment(line)) {
    const size = Array.from(segment).length;
    if (points + size > MESSAGE_LIMIT) {
      // One grapheme longer than the limit, such as a letter with hundreds of marks, is cut by
      // code points.
      if (cut === "") cut = Array.from(segment).slice(0, MESSAGE_LIMIT).join("");
      break;
    }
    cut += segment;
    points += size;
  }
  return cut.trim();
}

let loading: Promise<PlaidLink> | undefined;

// Loads Plaid's Link script once, only when a Member opens Link. The request carries no referrer,
// so Plaid's CDN does not learn the app's address or page.
function loadPlaidLink(): Promise<PlaidLink> {
  loading ??= new Promise<PlaidLink>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = PLAID_LINK_SCRIPT;
    script.async = true;
    script.referrerPolicy = "no-referrer";
    script.onload = () => {
      const found = (window as { Plaid?: PlaidLink }).Plaid;
      if (found === undefined) reject(new Error("Plaid Link did not load."));
      else resolve(found);
    };
    script.onerror = () => {
      loading = undefined;
      script.remove();
      reject(new Error("Plaid Link did not load."));
    };
    document.head.append(script);
  });
  return loading;
}

// Opens Plaid Link with a link token from the server.
async function openPlaidLink(
  linkToken: string,
  handlers: {
    onSuccess(publicToken: string, metadata: PlaidLinkMetadata): void;
    // Link closed before it finished: `problem` is undefined when the Member closed it.
    onExit(problem: LinkExitProblem | undefined): void;
  },
): Promise<void> {
  const plaid = await loadPlaidLink();
  const handler = plaid.create({
    token: linkToken,
    onSuccess: (publicToken, metadata) => {
      handler.destroy();
      handlers.onSuccess(publicToken, metadata);
    },
    onExit: (exit) => {
      handler.destroy();
      handlers.onExit(linkExitProblem(exit));
    },
  });
  handler.open();
}

// What the server needs from Link's onSuccess, or undefined when Link named no institution.
export function linkResultOf(publicToken: string, metadata: PlaidLinkMetadata) {
  if (metadata.institution === null) return undefined;
  const accounts: LinkedAccount[] = metadata.accounts.map((account) => ({
    name: account.name,
    type: account.type,
    subtype: account.subtype ?? null,
    mask: account.mask ?? null,
  }));
  return {
    publicToken,
    bankId: metadata.institution.institution_id,
    bankName: metadata.institution.name,
    accounts,
  };
}

async function refusal(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: unknown };
  return typeof body.error === "string" ? body.error : "That did not work.";
}

const accountLabel = (account: AccountView) =>
  `${account.name}${account.mask === null ? "" : ` ··${account.mask}`}${account.closed ? " (Closed)" : ""}`;

// An Account with its current balance, when the bank sent one.
function AccountLine(props: { account: AccountView }) {
  const { account } = props;
  return (
    <li
      className={`flex justify-between gap-3 border-t border-line-soft py-2 ${account.closed ? "text-muted" : ""}`}
    >
      <span className="min-w-0">{accountLabel(account)}</span>
      {account.currentBalance === null ? null : (
        <span className="tabular-nums">{dollarsAndCents(account.currentBalance)}</span>
      )}
    </li>
  );
}

const count = (n: number) => n.toLocaleString("en-US");

// "312 Transactions so far, back to Aug 2025".
export function historySoFar(loading: HistoryLoadingView | undefined): string {
  const transactions = loading?.transactions ?? 0;
  const so = `${count(transactions)} ${transactions === 1 ? "Transaction" : "Transactions"} so far`;
  const oldest = loading?.oldestDate ?? null;
  return oldest === null ? so : `${so}, back to ${monthLabel(oldest)}`;
}

// A Connection's sync state for its row (Settings → Banks): its first sync, its history load, or
// when it last synced, in this browser's time zone. Null while it is removed, held, needs a Member,
// or is Broken: its own note says so.
export function syncState(
  connection: ConnectionView,
  loading: HistoryLoadingView | undefined,
  poll: PollState,
  now = new Date(),
  zone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): { word: string; detail: string | null } | null {
  if (connection.removed || connection.held) return null;
  if (connection.health === "needs a member" || connection.health === "broken") return null;
  const updates =
    poll === "gave up" ? "Reload the page to see newer progress." : "Updates by itself.";
  if (connection.lastSyncedAt === null) {
    return { word: "First sync running", detail: `Getting the Accounts from the bank. ${updates}` };
  }
  if (!connection.historyLoaded) {
    return { word: "Loading history", detail: `${historySoFar(loading)}. ${updates}` };
  }
  const at = new Date(connection.lastSyncedAt);
  const day = calendarDateIn(at, zone);
  const today = calendarDateIn(now, zone);
  const time = timeLabel(at, zone);
  return {
    word: `Synced ${day === today ? time : `${dateLabel(day, today)}, ${time}`}`,
    detail: null,
  };
}

// The grey box each Link panel step shows in, under its button.
const PANEL = "mt-3 rounded-control border border-line bg-page p-3.5";
// A list of Accounts inside a panel or a Connection, one per line.
const ACCOUNT_LIST = "mt-2 text-sm";

// "Opening Plaid" and "Saving the Connection": the Link panel's steps while the Member waits.
export function LinkWaiting(props: { saving?: string }) {
  return (
    <div className={PANEL} role="status">
      {props.saving === undefined ? (
        <>
          <p className="font-semibold">Opening Plaid…</p>
          <p className="mt-1 text-small text-muted">Plaid's window opens over this page.</p>
        </>
      ) : (
        <>
          <p className="font-semibold">Saving {props.saving}…</p>
          <p className="mt-1 text-small text-muted">
            Plaid is confirming the bank. This takes a few seconds.
          </p>
        </>
      )}
    </div>
  );
}

// After a bank is linked: its first sync runs, then its Accounts arrive, with no reload. The page
// reads the Connection list meanwhile (SYNC_POLL) and hands this panel what it read.
export function LinkProgress(props: {
  bankName: string;
  connection: ConnectionView | undefined;
  accounts: AccountView[];
  loading: HistoryLoadingView | undefined;
  poll: PollState;
}) {
  const { connection, bankName } = props;
  const name = connection?.bankName ?? bankName;
  if (connection?.removed) return <p className={PANEL}>{name} was removed.</p>;
  if (connection?.held) {
    return (
      <p className={PANEL}>
        {name} is not in use: another Connection already covers this bank, so it never syncs.
      </p>
    );
  }
  if (connection?.health === "needs a member") {
    return (
      <div className={PANEL} role="status">
        <p className="font-semibold">{name} is linked</p>
        <p className="mt-1">
          The bank asked for a new sign-in before the first sync finished. Use Repair on {name} in
          the list.
        </p>
      </div>
    );
  }
  if (connection?.health === "broken") {
    return (
      <div className={PANEL} role="status">
        <p className="font-semibold">{name} is linked</p>
        <p className="mt-1">
          The bank disconnected before the first sync finished. Use Link again on {name} in the
          list.
        </p>
      </div>
    );
  }
  if (connection === undefined || connection.lastSyncedAt === null) {
    return (
      <div className={PANEL} role="status">
        <p className="font-semibold">{name} is linked</p>
        {props.poll === "gave up" ? (
          <p className="mt-1">
            The first sync is taking longer than usual, so this page stopped checking. It still
            runs: reload the page later to see the Accounts.
          </p>
        ) : (
          <>
            <p className="mt-1">Getting your Accounts from the bank…</p>
            <p className="mt-1 text-small text-muted">
              {connection?.health === "retrying"
                ? "The bank did not answer the first time, so the app tries again by itself."
                : "They show here in about a minute. You can leave this page; nothing stops."}
            </p>
          </>
        )}
      </div>
    );
  }
  const found = props.accounts.length;
  return (
    <div className={PANEL} role="status">
      <p className="font-semibold">
        {found === 0
          ? `The first sync found no Accounts at ${name}`
          : `${found} ${found === 1 ? "Account" : "Accounts"} found`}
      </p>
      <ul className={ACCOUNT_LIST}>
        {props.accounts.map((account) => (
          <AccountLine key={account.id} account={account} />
        ))}
      </ul>
      {connection.historyLoaded ? null : (
        <p className="mt-1 text-small text-muted">
          History is loading: {historySoFar(props.loading)}.
        </p>
      )}
    </div>
  );
}

// Link closed with an error (spec 02): plain words, and Plaid's code. No Item was spent, since
// Plaid makes an Item only when Link succeeds.
export function LinkFailed(props: {
  problem: LinkExitProblem;
  onRetry: () => void;
  onClose: () => void;
}) {
  return (
    <div className="mt-3 rounded-control border border-critical/40 bg-white p-3.5" role="alert">
      <p className="font-semibold text-critical">The bank was not linked</p>
      <p className="mt-1">{props.problem.words} Nothing was saved, and no Item was spent.</p>
      {props.problem.code === null ? null : (
        <p className="mt-1 text-small text-muted">Plaid code: {props.problem.code}</p>
      )}
      <div className={BUTTONS}>
        <Button type="button" onClick={props.onRetry}>
          Try again
        </Button>
        <Button type="button" variant="outlined" onClick={props.onClose}>
          Close
        </Button>
      </div>
    </div>
  );
}

// The banks and Accounts already connected.
export function ConnectionList(props: { connections: ConnectionView[]; accounts: AccountView[] }) {
  if (props.connections.length === 0) return <p className="mt-2">No bank is connected yet.</p>;
  return (
    <ul className="mt-2 list-disc pl-6">
      {props.connections.map((connection) => (
        <li key={connection.id}>
          <span className="font-semibold">{connection.bankName}</span>
          <ul className="list-[circle] pl-6 text-ink-soft">
            {props.accounts
              .filter((account) => account.connectionId === connection.id)
              .map((account) => (
                <li key={account.id}>{accountLabel(account)}</li>
              ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

// What the Member reads before Link opens: the banks already connected, the advice, and N.
export function BeforeLink(props: {
  plaid: PlaidView;
  connections: ConnectionView[];
  accounts: AccountView[];
}) {
  const { itemsUsed, itemLimit } = props.plaid;
  return (
    <>
      <p className="mt-2">Already connected:</p>
      <ConnectionList connections={props.connections} accounts={props.accounts} />
      <p className="mt-2">
        Link each bank once. If a bank is listed above, do not link it again. Pick every Account at
        the bank the first time: at some banks, such as Chase, a second sign-in can break the first
        Connection.
      </p>
      <p className="mt-2 font-semibold tabular-nums">
        At least {itemsUsed} of {itemLimit} used
      </p>
      {itemsUsed >= itemLimit ? (
        <p className="mt-1">
          <StatusText tone="critical">
            All {itemLimit} of Plaid's lifetime Items are used, so the app cannot link a new bank.
            You can still import a Plaid Connection by its access token.
          </StatusText>
        </p>
      ) : (
        <p className="mt-1 text-small text-muted">
          Linking a bank spends one of Plaid's {itemLimit} lifetime Items, and removing it later
          does not give the Item back.
        </p>
      )}
    </>
  );
}

// What shows in place of "Link a new bank" until the Plaid keys are saved. The keys are for real
// banks only: a Connection already linked, such as the dev fake bank, works without them.
export const PLAID_KEYS_FOR_REAL_BANKS =
  "To link a real bank through Plaid, save the Plaid keys above.";

// "Link a new bank", or, with `replaces`, "Link again" for a Broken Connection (spec 02, Repair).
// Link again follows the same steps, with the Item count and its confirmation, and spends a new
// Item. The new Connection replaces the Broken one, and its Accounts carry on the old ones.
export function LinkBank(props: {
  plaid: PlaidView;
  connections: ConnectionView[];
  accounts: AccountView[];
  onLinked: () => void;
  replaces?: ConnectionView;
  // What the page last read of each history load, and whether it still reads.
  loading?: HistoryLoadingView[];
  poll?: PollState;
}) {
  const [step, setStep] = useState<LinkStep>({ step: "closed" });
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const { itemsUsed, itemLimit } = props.plaid;
  const blocked = itemsUsed >= itemLimit;
  const needsConfirm = itemsUsed >= CONFIRM_ITEMS_FROM;
  const replaces = props.replaces?.id;
  const options = replaces === undefined ? { confirmed } : { confirmed, replaces };

  const backTo = (problem: string) => {
    setStep({ step: "before" });
    setError(problem);
  };

  async function finish(publicToken: string, metadata: PlaidLinkMetadata) {
    const result = linkResultOf(publicToken, metadata);
    if (result === undefined) return backTo("Plaid Link named no bank. Nothing was linked.");
    // The name from Link shows only while the server saves; what follows names the server's.
    setStep({ step: "saving", bankName: result.bankName });
    try {
      const res = await api.plaid.link.$post({ json: { ...result, ...options } });
      const body = (await res.json().catch(() => ({}))) as LinkAnswer;
      const linked = linkedConnection(body);
      // After the exchange a refusal may still have added or removed a Connection.
      if (res.ok || res.status === 409) props.onLinked();
      if (linked === undefined || (!res.ok && res.status !== 409)) {
        return backTo(typeof body.error === "string" ? body.error : "That did not work.");
      }
      const note = !res.ok
        ? typeof body.error === "string"
          ? body.error
          : undefined
        : body.bankConfirmed === false
          ? "Plaid did not confirm the bank's name, so check it."
          : undefined;
      setStep({ step: "linked", ...linked, ...(note === undefined ? {} : { note }) });
    } catch {
      backTo("The server did not answer.");
    }
  }

  async function openLink() {
    setStep({ step: "opening" });
    setError(undefined);
    try {
      const res = await api.plaid["link-token"].$post({ json: options });
      if (!res.ok) return backTo(await refusal(res));
      const { linkToken } = (await res.json()) as { linkToken: string };
      await openPlaidLink(linkToken, {
        onSuccess: (publicToken, metadata) => void finish(publicToken, metadata),
        onExit: (problem) =>
          setStep(problem === undefined ? { step: "before" } : { step: "failed", problem }),
      });
    } catch {
      backTo("Plaid Link did not open. If this keeps happening over plain HTTP, use HTTPS.");
    }
  }

  const close = () => {
    setStep({ step: "closed" });
    setConfirmed(false);
    setError(undefined);
  };

  if (!props.plaid.secretSet) {
    return <p className="mt-4 text-muted">{PLAID_KEYS_FOR_REAL_BANKS}</p>;
  }
  return (
    <div className="mt-4">
      <Button
        type="button"
        onClick={() => setStep({ step: "before" })}
        disabled={step.step !== "closed"}
      >
        {props.replaces === undefined ? "Link a new bank" : "Link again"}
      </Button>
      {step.step === "opening" ? <LinkWaiting /> : null}
      {step.step === "saving" ? <LinkWaiting saving={step.bankName} /> : null}
      {step.step === "failed" ? (
        <LinkFailed problem={step.problem} onRetry={() => void openLink()} onClose={close} />
      ) : null}
      {step.step === "linked" ? (
        <>
          <LinkProgress
            bankName={step.bankName}
            connection={props.connections.find((c) => c.id === step.connectionId)}
            accounts={props.accounts.filter((a) => a.connectionId === step.connectionId)}
            loading={props.loading?.find((l) => l.connectionId === step.connectionId)}
            poll={props.poll ?? "ended"}
          />
          {step.note === undefined ? null : <p className="mt-1">{step.note}</p>}
          <div className={BUTTONS}>
            {props.replaces === undefined ? (
              <Button
                type="button"
                onClick={() => {
                  setConfirmed(false);
                  setStep({ step: "before" });
                }}
              >
                Link another bank
              </Button>
            ) : null}
            <Button type="button" variant="outlined" onClick={close}>
              Done
            </Button>
          </div>
        </>
      ) : null}
      {step.step === "before" ? (
        <div className={PANEL}>
          {props.replaces === undefined ? null : (
            <p>
              The bank says the app's access to {props.replaces.bankName} is gone, so Repair cannot
              fix it. Link again links {props.replaces.bankName} as a new Connection, which spends a
              new Item. Its Accounts carry on the old ones, with their history.
            </p>
          )}
          <BeforeLink
            plaid={props.plaid}
            connections={props.connections}
            accounts={props.accounts}
          />
          {needsConfirm && !blocked ? (
            <label className={`${CHOICE} mt-3 items-start`}>
              <input
                className="mt-1"
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />{" "}
              I understand that only {itemLimit - itemsUsed} Items are left, and this bank spends
              one.
            </label>
          ) : null}
          <div className={BUTTONS}>
            {blocked ? null : (
              <Button
                type="button"
                onClick={() => void openLink()}
                disabled={needsConfirm && !confirmed}
              >
                Open Plaid Link
              </Button>
            )}
            <Button type="button" variant="outlined" onClick={close}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      <ErrorLine error={error} />
    </div>
  );
}

// The Link panel's steps after "Link a new bank" (the approved Link states): what the Member reads
// before Plaid opens, Plaid opening, the server saving the Connection, the new Connection with its
// first sync and then its Accounts, or Plaid's error. Each replaces the one before, in place.
type LinkStep =
  | { step: "closed" }
  | { step: "before" }
  | { step: "opening" }
  | { step: "saving"; bankName: string }
  | { step: "linked"; connectionId: string; bankName: string; note?: string }
  | { step: "failed"; problem: LinkExitProblem };

// What POST /api/plaid/link and the dev fake bank route answer.
type LinkAnswer = {
  connection?: { id?: unknown; bankName?: unknown };
  bankConfirmed?: boolean;
  error?: unknown;
};

// The new Connection in a link answer, when the server made one. A 409 may carry one too, such as
// when Plaid linked another bank than the Broken Connection's.
export function linkedConnection(
  answer: LinkAnswer,
): { connectionId: string; bankName: string } | undefined {
  const { id, bankName } = answer.connection ?? {};
  if (typeof id !== "string" || typeof bankName !== "string") return undefined;
  return { connectionId: id, bankName };
}

type ImportPreviewView = { bankName: string; accounts: LinkedAccount[] };

// The bank and Accounts behind a pasted access token, before the Member saves.
export function ImportPreviewList(props: { preview: ImportPreviewView }) {
  return (
    <div className="mt-3">
      <p className="font-semibold">{props.preview.bankName}</p>
      <ul className="list-disc pl-6 text-ink-soft">
        {props.preview.accounts.map((account, i) => (
          // Plaid's account IDs never reach the browser, so the place in the list is the key.
          // biome-ignore lint/suspicious/noArrayIndexKey: the list never changes order.
          <li key={i}>
            {account.name}
            {account.mask === null ? "" : ` ··${account.mask}`}
          </li>
        ))}
      </ul>
    </div>
  );
}

// Import Plaid Connection (spec 02): adopts an access token made outside the app, one at a time.
// The app shows the bank and its Accounts first. The token goes to the server only, and the box
// is emptied once it is saved, so the app never shows it again.
export function ImportConnection(props: { plaid: PlaidView; onImported: () => void }) {
  const [open, setOpen] = useState(false);
  const [accessToken, setAccessToken] = useState("");
  const [preview, setPreview] = useState<ImportPreviewView | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [done, setDone] = useState<string | undefined>();

  async function ask(step: () => Promise<void>) {
    setBusy(true);
    setError(undefined);
    setDone(undefined);
    try {
      await step();
    } catch {
      setError("The server did not answer.");
    } finally {
      setBusy(false);
    }
  }

  const showPreview = () =>
    ask(async () => {
      const res = await api.plaid.import.preview.$post({ json: { accessToken } });
      if (!res.ok) return setError(await refusal(res));
      setPreview((await res.json()) as ImportPreviewView);
    });

  const save = () =>
    ask(async () => {
      const res = await api.plaid.import.$post({ json: { accessToken } });
      if (!res.ok) return setError(await refusal(res));
      const body = (await res.json()) as { connection: { bankName: string } };
      setAccessToken("");
      setPreview(undefined);
      setOpen(false);
      setDone(`Imported ${body.connection.bankName}. Its first sync has started.`);
      props.onImported();
    });

  const close = () => {
    setAccessToken("");
    setPreview(undefined);
    setOpen(false);
  };

  if (!props.plaid.secretSet) return null;
  return (
    <div className="mt-4">
      <Button type="button" variant="outlined" onClick={() => setOpen(true)} disabled={open}>
        Import Plaid Connection
      </Button>
      {open ? (
        <div className={PANEL}>
          <label className={`${LABEL} mt-0`}>
            Access token
            <input
              className={`${BOX} max-w-[340px]`}
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={accessToken}
              onChange={(e) => {
                setAccessToken(e.target.value);
                setPreview(undefined);
              }}
            />
          </label>
          <p className={HINT}>
            An import spends no new Item, but it counts in "at least N of 10 used". If you already
            raised N by hand for this Item, lower N by one after you save.
          </p>
          {preview === undefined ? null : <ImportPreviewList preview={preview} />}
          <div className={BUTTONS}>
            {preview === undefined ? (
              <Button
                type="button"
                onClick={showPreview}
                disabled={busy || accessToken.trim() === ""}
              >
                Show the bank
              </Button>
            ) : (
              <Button type="button" onClick={save} disabled={busy}>
                Save this Connection
              </Button>
            )}
            <Button type="button" variant="outlined" onClick={close}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      <ErrorLine error={error} />
      {done === undefined ? null : (
        <p className="mt-3">
          <StatusText tone="good">{done}</StatusText>
        </p>
      )}
    </div>
  );
}

// `pnpm dev` only: links the next demo bank through the fake adapter, by the normal link path, so
// its first sync and follow-up jobs run. The server offers it only while the fake adapter runs,
// which it never does in the built app.
export function FakeBankLink(props: {
  offered: boolean;
  onLinked: () => void;
  // What the page last read, for the new Connection's first sync and Accounts.
  connections?: ConnectionView[];
  accounts?: AccountView[];
  loading?: HistoryLoadingView[];
  poll?: PollState;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [linked, setLinked] = useState<{ connectionId: string; bankName: string } | undefined>();

  async function link() {
    setBusy(true);
    setError(undefined);
    setLinked(undefined);
    try {
      // The built app's API has no dev routes, so the typed client does not name this one.
      const res = await fetch("/api/dev/fake-bank", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!res.ok) return setError(await refusal(res));
      const made = linkedConnection((await res.json()) as LinkAnswer);
      if (made === undefined) return setError("That did not work.");
      setLinked(made);
      props.onLinked();
    } catch {
      setError("The server did not answer.");
    } finally {
      setBusy(false);
    }
  }

  if (!props.offered) return null;
  return (
    <div className="mt-4">
      <Button
        type="button"
        variant="outlined"
        className="border-dashed border-serious text-serious"
        onClick={link}
        disabled={busy}
      >
        Link a fake bank (dev only)
      </Button>
      <ErrorLine error={error} />
      {linked === undefined ? null : (
        <LinkProgress
          bankName={linked.bankName}
          connection={props.connections?.find((c) => c.id === linked.connectionId)}
          accounts={(props.accounts ?? []).filter((a) => a.connectionId === linked.connectionId)}
          loading={props.loading?.find((l) => l.connectionId === linked.connectionId)}
          poll={props.poll ?? "ended"}
        />
      )}
    </div>
  );
}

// A read's answer. A refusal throws Refused with the server's words, and a 401 throws SignedOut.
export async function readJson<T>(res: Response): Promise<T> {
  if (res.status === 401) throw new SignedOut();
  if (!res.ok) throw new Refused(await refusal(res));
  return (await res.json()) as T;
}

// The Connection list, the Accounts, and the history progress, as Settings → Banks and the
// wizard's step 5 read them.
export const CONNECTIONS_READS: ConnectionsReads = {
  connections: async () =>
    readJson<{ connections: ConnectionView[]; fakeBank: boolean }>(await api.connections.$get()),
  accounts: async () => readJson<{ accounts: AccountView[] }>(await api.accounts.$get()),
  history: async () => readJson<HistoryStatusView>(await api["history-status"].$get()),
};

// "Link a new bank", then `children`, then the fake bank under `pnpm dev`, each with what the page
// last read, so the Link panel follows a new Connection's first sync until its Accounts arrive.
// Settings → Banks and the wizard's step 5 both show them; `onLinked` must start the page's poll.
export function NewBankLinks(props: {
  plaid: PlaidView;
  view: ConnectionsPageView;
  onLinked: () => void;
  children?: ReactNode;
}) {
  const { connections, accounts, loading, poll, fakeBank } = props.view;
  return (
    <>
      <LinkBank
        plaid={props.plaid}
        // A removed Connection covers no bank, so Link lists only the others.
        connections={connections.filter((connection) => !connection.removed)}
        accounts={accounts}
        onLinked={props.onLinked}
        loading={loading}
        poll={poll}
      />
      {props.children}
      <FakeBankLink
        offered={fakeBank}
        onLinked={props.onLinked}
        connections={connections}
        accounts={accounts}
        loading={loading}
        poll={poll}
      />
    </>
  );
}

// The Connections, with the ways to add one. While a first sync or history load runs, the page
// reads the list again by itself (SYNC_POLL), so a new bank's Accounts show with no reload. An
// ended session sends the Member to sign-in.
export function Connections(props: { plaid: PlaidView; onChanged: () => void }) {
  const navigate = useNavigate();
  const [view, setView] = useState(CONNECTIONS_UNREAD);
  const [page, setPage] = useState<ConnectionsPage | undefined>();
  const { connections, accounts, loading, error, poll } = view;

  useEffect(() => {
    const opened = createConnectionsPage(CONNECTIONS_READS, setView, () =>
      navigate("/sign-in", { replace: true }),
    );
    setPage(opened);
    opened.load();
    return opened.stop;
  }, [navigate]);

  // A change to the Connections can change N, so the Plaid settings load again too.
  const changed = () => {
    page?.load();
    props.onChanged();
  };

  // A new bank's first sync starts at once: the page reads until its Accounts arrive.
  const linked = () => {
    page?.linked();
    props.onChanged();
  };

  // A removed Connection covers no bank, so Link lists only the others.
  const connected = connections.filter((connection) => !connection.removed);

  return (
    <SettingCard id="connections" title="Connections">
      {connections.length === 0 ? (
        <p className="mt-1.5 text-muted">No bank is connected yet.</p>
      ) : null}
      <ul className="mt-3 flex flex-col gap-3 empty:hidden">
        {connections.map((connection) => (
          <ConnectionItem
            key={connection.id}
            connection={connection}
            accounts={accounts.filter((account) => account.connectionId === connection.id)}
            loading={loading.find((each) => each.connectionId === connection.id)}
            poll={poll}
            onChanged={changed}
            linkAgain={
              <LinkBank
                plaid={props.plaid}
                connections={connected.filter((other) => other.id !== connection.id)}
                accounts={accounts}
                onLinked={linked}
                replaces={connection}
                loading={loading}
                poll={poll}
              />
            }
          />
        ))}
      </ul>
      <ErrorLine error={error} />
      <NewBankLinks plaid={props.plaid} view={view} onLinked={linked}>
        <ImportConnection plaid={props.plaid} onImported={linked} />
      </NewBankLinks>
    </SettingCard>
  );
}

// Repair or Add accounts: Plaid Link in update mode for one Connection (spec 02, Repair and New
// accounts at a bank). When Link finishes, the server syncs the Connection at once.
export function UpdateMode(props: {
  connection: ConnectionView;
  addAccounts: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [done, setDone] = useState<string | undefined>();
  // The routes read no body, but every Connection route takes only JSON, so the typed client sends
  // an empty object.
  const request = { param: { id: props.connection.id }, json: {} };

  async function finished() {
    try {
      const res = await api.connections[":id"]["update-finished"].$post(request);
      if (!res.ok) return setError(await refusal(res));
      const { syncing } = (await res.json()) as { syncing: boolean };
      const sync = syncing
        ? "A sync has started"
        : "A sync ran a few minutes ago, so the next one starts within minutes";
      setDone(
        props.addAccounts
          ? `Done. ${sync}, and it brings in the Accounts you added.`
          : `Repaired. ${sync}.`,
      );
      props.onChanged();
    } catch {
      setError("The server did not answer.");
    }
  }

  async function open() {
    setBusy(true);
    setError(undefined);
    setDone(undefined);
    try {
      const route = props.addAccounts
        ? api.connections[":id"]["add-accounts"]
        : api.connections[":id"].repair;
      const res = await route.$post(request);
      if (!res.ok) return setError(await refusal(res));
      const { linkToken } = (await res.json()) as { linkToken: string };
      await openPlaidLink(linkToken, {
        // Update mode keeps the access token, so Link's public token goes nowhere.
        onSuccess: () => void finished(),
        onExit: (problem) => {
          if (problem === undefined) return;
          const code = problem.code === null ? "" : ` Plaid code: ${problem.code}.`;
          setError(`${problem.words} Nothing changed.${code}`);
        },
      });
    } catch {
      setError("Plaid Link did not open. If this keeps happening over plain HTTP, use HTTPS.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button type="button" variant="outlined" size="small" onClick={open} disabled={busy}>
        {props.addAccounts ? "Add accounts" : "Repair"}
      </Button>
      <ErrorLine error={error} />
      {done === undefined ? null : (
        <p className="mt-1">
          <StatusText tone="good">{done}</StatusText>
        </p>
      )}
    </>
  );
}

// What a Connection's health asks of a Member, if anything, with its tone.
const HEALTH_NOTES: Partial<
  Record<ConnectionView["health"], { tone: "serious" | "critical"; words: string; border: string }>
> = {
  "needs a member": {
    tone: "serious",
    words: "Needs you to sign in again: use Repair",
    border: "border-serious/40",
  },
  broken: { tone: "critical", words: "Disconnected: use Link again", border: "border-critical/40" },
};

// One Connection with its Accounts, Repair or Link again, Add accounts, and Remove or Delete
// history (spec 02, Repair, New accounts at a bank, and Removing a Connection).
export function ConnectionItem(props: {
  connection: ConnectionView;
  accounts: AccountView[];
  onChanged: () => void;
  // Link again, shown while the Connection is Broken.
  linkAgain?: ReactNode;
  // Its history load progress, and whether the page still reads it again.
  loading?: HistoryLoadingView | undefined;
  poll?: PollState;
}) {
  const { connection } = props;
  const state = syncState(connection, props.loading, props.poll ?? "ended");
  const [asking, setAsking] = useState<"remove" | "delete history" | undefined>();
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const close = () => {
    setAsking(undefined);
    setConfirmed(false);
  };

  async function send(request: () => Promise<Response>) {
    setBusy(true);
    setError(undefined);
    try {
      const res = await request();
      if (!res.ok) return setError(await refusal(res));
      close();
      props.onChanged();
    } catch {
      setError("The server did not answer.");
    } finally {
      setBusy(false);
    }
  }

  // The routes read their bodies themselves, so the typed client does not name them.
  const param = { id: connection.id };
  const removal = { param, json: {} };
  const deletion = { param, json: { confirmed: true } };
  const remove = () => send(() => api.connections[":id"].remove.$post(removal));
  const deleteHistory = () => send(() => api.connections[":id"]["delete-history"].$post(deletion));

  // A removed Connection whose Accounts are gone has nothing left to show.
  if (connection.removed && props.accounts.length === 0) return null;
  const note = connection.removed || connection.held ? undefined : HEALTH_NOTES[connection.health];
  // Synced and its history loaded, or still on its first sync or history load.
  const synced = connection.lastSyncedAt !== null && connection.historyLoaded;
  const repairs = !(connection.removed || connection.held || !connection.actions.repairInApp);
  return (
    <li className={`rounded-xl border bg-white p-4 ${note?.border ?? "border-line"}`}>
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <h4 className={`flex-1 font-semibold ${connection.removed ? "text-muted" : ""}`}>
          {connection.bankName}
          {connection.removed ? " (Removed)" : null}
        </h4>
        {state === null ? null : (
          <span className="text-small font-semibold">
            <StatusText tone={synced ? "good" : "accent"}>{state.word}</StatusText>
          </span>
        )}
      </div>
      {note === undefined ? null : (
        <p className="mt-1 text-small font-semibold">
          <StatusText tone={note.tone}>{note.words}</StatusText>
        </p>
      )}
      {connection.held ? (
        <p className="mt-1 text-small text-muted">
          Not in use: another Connection already covers this bank, so it never syncs. Remove it.
        </p>
      ) : null}
      {state === null || state.detail === null ? null : (
        <p className="mt-1.5 text-small text-muted" role="status">
          {state.detail}
        </p>
      )}
      <ul className={`${ACCOUNT_LIST} empty:hidden`}>
        {props.accounts.map((account) => (
          <AccountLine key={account.id} account={account} />
        ))}
      </ul>
      {repairs && connection.health === "broken" ? props.linkAgain : null}
      <div className="mt-3 flex flex-wrap items-center gap-2 [&>p]:w-full">
        {repairs && connection.health === "needs a member" ? (
          <UpdateMode connection={connection} addAccounts={false} onChanged={props.onChanged} />
        ) : null}
        {repairs && connection.health !== "broken" ? (
          <UpdateMode connection={connection} addAccounts={true} onChanged={props.onChanged} />
        ) : null}
        {asking === undefined ? (
          <Button
            type="button"
            variant="outlined"
            size="small"
            onClick={() => setAsking(connection.removed ? "delete history" : "remove")}
          >
            {connection.removed ? "Delete history" : "Remove"}
          </Button>
        ) : null}
      </div>
      {asking === "remove" ? (
        <div className={PANEL}>
          <p>
            Removing {connection.bankName} does not give its Plaid Item back: the Plaid Trial slot
            stays spent. Its Accounts become Closed, and their history stays.
          </p>
          <div className={BUTTONS}>
            <Button type="button" onClick={remove} disabled={busy}>
              Remove {connection.bankName}
            </Button>
            <Button type="button" variant="outlined" onClick={close}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      {asking === "delete history" ? (
        <div className={PANEL}>
          <p>
            This deletes these Accounts and every one of their Transactions, for good. Transfers and
            Refunds matched to them are undone, and matching runs again.
          </p>
          <label className={`${CHOICE} mt-3`}>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />{" "}
            Delete the history of {connection.bankName}
          </label>
          <div className={BUTTONS}>
            <Button type="button" onClick={deleteHistory} disabled={busy || !confirmed}>
              Delete history
            </Button>
            <Button type="button" variant="outlined" onClick={close}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      <ErrorLine error={error} />
    </li>
  );
}
