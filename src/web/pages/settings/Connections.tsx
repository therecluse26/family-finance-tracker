import { type ReactNode, useCallback, useEffect, useState } from "react";
import type { LinkedAccount } from "../../../bank/adapter.ts";
import { CONFIRM_ITEMS_FROM } from "../../../bank/connect-view.ts";
import type { PlaidView } from "../../../bank/plaid-view.ts";
import type { AccountView, ConnectionView } from "../../../server/bank-views.ts";
import { api } from "../../api.ts";
import { BUTTON, ErrorLine, FIELD } from "../../components/Fields.tsx";

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

type PlaidLinkHandler = { open(): void; destroy(): void };
type PlaidLink = {
  create(config: {
    token: string;
    onSuccess(publicToken: string, metadata: PlaidLinkMetadata): void;
    onExit(error: { error_code?: string } | null): void;
  }): PlaidLinkHandler;
};

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
    // Link closed before it finished: `failed` is true when Plaid named an error.
    onExit(failed: boolean): void;
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
      handlers.onExit(exit !== null);
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

// The banks and Accounts already connected.
export function ConnectionList(props: { connections: ConnectionView[]; accounts: AccountView[] }) {
  if (props.connections.length === 0) return <p className="mt-2">No bank is connected yet.</p>;
  return (
    <ul className="mt-2 list-disc pl-6">
      {props.connections.map((connection) => (
        <li key={connection.id}>
          {connection.bankName}
          <ul className="list-[circle] pl-6 text-gray-700">
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
      <p className="mt-2 text-lg">
        At least {itemsUsed} of {itemLimit} used
      </p>
      {itemsUsed >= itemLimit ? (
        <p className="mt-2 text-red-700">
          All {itemLimit} of Plaid's lifetime Items are used, so the app cannot link a new bank. You
          can still import a Plaid Connection by its access token.
        </p>
      ) : (
        <p className="mt-2 text-gray-600">
          Linking a bank spends one of Plaid's {itemLimit} lifetime Items, and removing it later
          does not give the Item back.
        </p>
      )}
    </>
  );
}

// "Link a new bank", or, with `replaces`, "Link again" for a Broken Connection (spec 02, Repair).
// Link again follows the same steps, with the Item count and its confirmation, and spends a new
// Item. The new Connection replaces the Broken one, and its Accounts carry on the old ones.
export function LinkBank(props: {
  plaid: PlaidView;
  connections: ConnectionView[];
  accounts: AccountView[];
  onLinked: () => void;
  replaces?: ConnectionView;
}) {
  const [open, setOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [done, setDone] = useState<string | undefined>();
  const { itemsUsed, itemLimit } = props.plaid;
  const blocked = itemsUsed >= itemLimit;
  const needsConfirm = itemsUsed >= CONFIRM_ITEMS_FROM;
  const replaces = props.replaces?.id;
  const options = replaces === undefined ? { confirmed } : { confirmed, replaces };

  async function finish(publicToken: string, metadata: PlaidLinkMetadata) {
    const result = linkResultOf(publicToken, metadata);
    if (result === undefined) return setError("Plaid Link named no bank. Nothing was linked.");
    setBusy(true);
    try {
      const res = await api.plaid.link.$post({ json: { ...result, ...options } });
      if (!res.ok) {
        setError(await refusal(res));
        // After the exchange a refusal may still have added or removed a Connection.
        if (res.status === 409) props.onLinked();
        return;
      }
      const body = (await res.json()) as {
        connection: { bankName: string };
        bankConfirmed?: boolean;
      };
      const unconfirmed =
        body.bankConfirmed === false ? " Plaid did not confirm the bank's name, so check it." : "";
      setDone(`Linked ${body.connection.bankName}. Its first sync has started.${unconfirmed}`);
      setOpen(false);
      props.onLinked();
    } catch {
      setError("The server did not answer.");
    } finally {
      setBusy(false);
    }
  }

  async function openLink() {
    setBusy(true);
    setError(undefined);
    setDone(undefined);
    try {
      const res = await api.plaid["link-token"].$post({ json: options });
      if (!res.ok) return setError(await refusal(res));
      const { linkToken } = (await res.json()) as { linkToken: string };
      await openPlaidLink(linkToken, {
        onSuccess: (publicToken, metadata) => void finish(publicToken, metadata),
        onExit: (failed) => {
          if (failed) setError("Plaid Link closed before the bank was linked.");
        },
      });
    } catch {
      setError("Plaid Link did not open. If this keeps happening over plain HTTP, use HTTPS.");
    } finally {
      setBusy(false);
    }
  }

  if (!props.plaid.secretSet) {
    return <p className="mt-4">Enter the Plaid keys to link a bank.</p>;
  }
  return (
    <div className="mt-4">
      <button className={BUTTON} type="button" onClick={() => setOpen(true)} disabled={open}>
        {props.replaces === undefined ? "Link a new bank" : "Link again"}
      </button>
      {open ? (
        <div className="mt-3">
          {props.replaces === undefined ? null : (
            <p className="mt-2">
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
            <label className="mt-3 block">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />{" "}
              I understand that only {itemLimit - itemsUsed} Items are left, and this bank spends
              one.
            </label>
          ) : null}
          {blocked ? null : (
            <button
              className={BUTTON}
              type="button"
              onClick={openLink}
              disabled={busy || (needsConfirm && !confirmed)}
            >
              Open Plaid Link
            </button>
          )}
          <button className="mt-4 ml-3 underline" type="button" onClick={() => setOpen(false)}>
            Cancel
          </button>
        </div>
      ) : null}
      <ErrorLine error={error} />
      {done === undefined ? null : <p className="mt-3">{done}</p>}
    </div>
  );
}

type ImportPreviewView = { bankName: string; accounts: LinkedAccount[] };

// The bank and Accounts behind a pasted access token, before the Member saves.
export function ImportPreviewList(props: { preview: ImportPreviewView }) {
  return (
    <div className="mt-3">
      <p>{props.preview.bankName}</p>
      <ul className="list-disc pl-6 text-gray-700">
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
      <button className={BUTTON} type="button" onClick={() => setOpen(true)} disabled={open}>
        Import Plaid Connection
      </button>
      {open ? (
        <div className="mt-3">
          <label className="mt-3 block">
            Access token
            <input
              className={FIELD}
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
          <p className="mt-2 text-gray-600">
            An import spends no new Item, but it counts in "at least N of 10 used". If you already
            raised N by hand for this Item, lower N by one after you save.
          </p>
          {preview === undefined ? (
            <button
              className={BUTTON}
              type="button"
              onClick={showPreview}
              disabled={busy || accessToken.trim() === ""}
            >
              Show the bank
            </button>
          ) : (
            <>
              <ImportPreviewList preview={preview} />
              <button className={BUTTON} type="button" onClick={save} disabled={busy}>
                Save this Connection
              </button>
            </>
          )}
          <button className="mt-4 ml-3 underline" type="button" onClick={close}>
            Cancel
          </button>
        </div>
      ) : null}
      <ErrorLine error={error} />
      {done === undefined ? null : <p className="mt-3">{done}</p>}
    </div>
  );
}

// The Connections, with the ways to add one.
export function Connections(props: { plaid: PlaidView; onChanged: () => void }) {
  const [connections, setConnections] = useState<ConnectionView[]>([]);
  const [accounts, setAccounts] = useState<AccountView[]>([]);
  const [error, setError] = useState<string | undefined>();

  const load = useCallback(() => {
    Promise.all([api.connections.$get(), api.accounts.$get()])
      .then(async ([connectionsRes, accountsRes]) => {
        if (!connectionsRes.ok) return setError(await refusal(connectionsRes));
        if (!accountsRes.ok) return setError(await refusal(accountsRes));
        setConnections(
          ((await connectionsRes.json()) as { connections: ConnectionView[] }).connections,
        );
        setAccounts(((await accountsRes.json()) as { accounts: AccountView[] }).accounts);
      })
      .catch(() => setError("The server did not answer."));
  }, []);

  useEffect(load, [load]);

  // A change to the Connections can change N, so the Plaid settings load again too.
  const changed = () => {
    load();
    props.onChanged();
  };

  // A removed Connection covers no bank, so Link lists only the others.
  const connected = connections.filter((connection) => !connection.removed);

  return (
    <section className="mt-6">
      <h3 className="font-semibold">Connections</h3>
      {connections.length === 0 ? <p className="mt-2">No bank is connected yet.</p> : null}
      <ul className="mt-2">
        {connections.map((connection) => (
          <ConnectionItem
            key={connection.id}
            connection={connection}
            accounts={accounts.filter((account) => account.connectionId === connection.id)}
            onChanged={changed}
            linkAgain={
              <LinkBank
                plaid={props.plaid}
                connections={connected.filter((other) => other.id !== connection.id)}
                accounts={accounts}
                onLinked={changed}
                replaces={connection}
              />
            }
          />
        ))}
      </ul>
      <ErrorLine error={error} />
      <LinkBank
        plaid={props.plaid}
        connections={connected}
        accounts={accounts}
        onLinked={changed}
      />
      <ImportConnection plaid={props.plaid} onImported={changed} />
    </section>
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
        onExit: (failed) => {
          if (failed) setError("Plaid Link closed before it finished. Nothing changed.");
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
      <button className="mt-1 mr-3 underline" type="button" onClick={open} disabled={busy}>
        {props.addAccounts ? "Add accounts" : "Repair"}
      </button>
      <ErrorLine error={error} />
      {done === undefined ? null : <p className="mt-1">{done}</p>}
    </>
  );
}

// What a Connection's health asks of a Member, if anything.
const HEALTH_NOTES: Partial<Record<ConnectionView["health"], string>> = {
  "needs a member": " (Needs you to sign in again: use Repair)",
  broken: " (Disconnected: use Link again)",
};

// One Connection with its Accounts, Repair or Link again, Add accounts, and Remove or Delete
// history (spec 02, Repair, New accounts at a bank, and Removing a Connection).
export function ConnectionItem(props: {
  connection: ConnectionView;
  accounts: AccountView[];
  onChanged: () => void;
  // Link again, shown while the Connection is Broken.
  linkAgain?: ReactNode;
}) {
  const { connection } = props;
  const [asking, setAsking] = useState<"remove" | "delete history" | undefined>();
  const [code, setCode] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const close = () => {
    setAsking(undefined);
    setCode("");
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
  const removal = { param, json: { code } };
  const deletion = { param, json: { confirmed: true } };
  const remove = () => send(() => api.connections[":id"].remove.$post(removal));
  const deleteHistory = () => send(() => api.connections[":id"]["delete-history"].$post(deletion));

  // A removed Connection whose Accounts are gone has nothing left to show.
  if (connection.removed && props.accounts.length === 0) return null;
  return (
    <li className="mt-3">
      <span className="font-medium">{connection.bankName}</span>
      {connection.removed
        ? " (Removed)"
        : connection.held
          ? " (Not in use: another Connection already covers this bank, so it never syncs. Remove it.)"
          : (HEALTH_NOTES[connection.health] ?? null)}
      <ul className="list-[circle] pl-6 text-gray-700">
        {props.accounts.map((account) => (
          <li key={account.id}>{accountLabel(account)}</li>
        ))}
      </ul>
      {connection.removed || connection.held || !connection.actions.repairInApp ? null : (
        <div>
          {connection.health === "needs a member" ? (
            <UpdateMode connection={connection} addAccounts={false} onChanged={props.onChanged} />
          ) : null}
          {connection.health === "broken" ? (
            props.linkAgain
          ) : (
            <UpdateMode connection={connection} addAccounts={true} onChanged={props.onChanged} />
          )}
        </div>
      )}
      {asking === undefined ? (
        <button
          className="mt-1 underline"
          type="button"
          onClick={() => setAsking(connection.removed ? "delete history" : "remove")}
        >
          {connection.removed ? "Delete history" : "Remove"}
        </button>
      ) : null}
      {asking === "remove" ? (
        <div className="mt-2">
          <p>
            Removing {connection.bankName} does not give its Plaid Item back: the Plaid Trial slot
            stays spent. Its Accounts become Closed, and their history stays.
          </p>
          <label className="mt-3 block">
            To confirm, enter a code from your authenticator app, or a backup code
            <input
              className={FIELD}
              inputMode="text"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
          <button
            className={BUTTON}
            type="button"
            onClick={remove}
            disabled={busy || code.trim() === ""}
          >
            Remove {connection.bankName}
          </button>
          <button className="mt-4 ml-3 underline" type="button" onClick={close}>
            Cancel
          </button>
        </div>
      ) : null}
      {asking === "delete history" ? (
        <div className="mt-2">
          <p>
            This deletes these Accounts and every one of their Transactions, for good. Transfers and
            Refunds matched to them are undone, and matching runs again.
          </p>
          <label className="mt-3 block">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />{" "}
            Delete the history of {connection.bankName}
          </label>
          <button
            className={BUTTON}
            type="button"
            onClick={deleteHistory}
            disabled={busy || !confirmed}
          >
            Delete history
          </button>
          <button className="mt-4 ml-3 underline" type="button" onClick={close}>
            Cancel
          </button>
        </div>
      ) : null}
      <ErrorLine error={error} />
    </li>
  );
}
