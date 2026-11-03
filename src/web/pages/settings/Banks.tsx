import { type FormEvent, useEffect, useState } from "react";
import type { PlaidView } from "../../../bank/plaid-view.ts";
import { api } from "../../api.ts";
import { BUTTON, ErrorLine, FIELD, TextField } from "../../components/Fields.tsx";

// Settings, Banks: the Plaid keys and the count of Plaid Items (spec 02, Plaid keys and The 10
// lifetime Items). The app never shows the secret again, only that it is set. Connections come
// with their own tickets.

const CODE_LABEL = "A code from your authenticator app, or a backup code";

// The words to show for a refused request: the server's own, such as "Wrong code." or "Sign in
// first".
async function refusal(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: unknown };
  return typeof body.error === "string" ? body.error : "That did not work.";
}

export function PlaidKeysForm(props: { plaid: PlaidView; onSaved: (plaid: PlaidView) => void }) {
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [done, setDone] = useState<string | undefined>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setDone(undefined);
    try {
      const res = await api.plaid.keys.$post({
        json: { clientId: clientId.trim(), secret: secret.trim(), code: code.trim() },
      });
      setCode("");
      if (!res.ok) return setError(await refusal(res));
      const body = (await res.json()) as { plaid: PlaidView };
      setClientId("");
      setSecret("");
      props.onSaved(body.plaid);
      setDone("The keys work. They are saved.");
    } catch {
      setError("The server did not answer.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="mt-4" onSubmit={submit}>
      <h3 className="font-semibold">Plaid keys</h3>
      <p className="mt-2">
        {props.plaid.secretSet
          ? `Client ID ${props.plaid.clientId ?? ""}. The secret is set.`
          : "No Plaid keys yet."}
      </p>
      <p className="mt-2 text-gray-600">
        Enter the client ID and the Production secret from Plaid's dashboard. The app tests them
        with Plaid at once, which spends no Item.
      </p>
      <TextField label="Client ID" autoComplete="off" value={clientId} onChange={setClientId} />
      <TextField
        label="Production secret"
        type="password"
        autoComplete="off"
        value={secret}
        onChange={setSecret}
      />
      <TextField label={CODE_LABEL} autoComplete="one-time-code" value={code} onChange={setCode} />
      <button className={BUTTON} type="submit" disabled={busy}>
        Test and save the keys
      </button>
      <ErrorLine error={error} />
      {done === undefined ? null : <p className="mt-3">{done}</p>}
    </form>
  );
}

export function ItemsUsedForm(props: { plaid: PlaidView; onSaved: (plaid: PlaidView) => void }) {
  const [itemsUsed, setItemsUsed] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const { plaid } = props;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const res = await api.plaid["items-used"].$post({ json: { itemsUsed: Number(itemsUsed) } });
      if (!res.ok) return setError(await refusal(res));
      props.onSaved(((await res.json()) as { plaid: PlaidView }).plaid);
      setItemsUsed("");
    } catch {
      setError("The server did not answer.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="mt-6" onSubmit={submit}>
      <h3 className="font-semibold">Plaid Items</h3>
      <p className="mt-2 text-lg">
        At least {plaid.itemsUsed} of {plaid.itemLimit} used
      </p>
      <p className="mt-2 text-gray-600">
        Plaid's free Trial plan allows {plaid.itemLimit} Items for the life of your Plaid team. Each
        bank linked or imported spends one, and removing a Connection does not give it back. If your
        Plaid team spent Items outside this app, raise the count here.
      </p>
      <label className="mt-3 block">
        Items used, from {plaid.appItems} to {plaid.itemLimit}
        <input
          className={FIELD}
          type="number"
          min={plaid.appItems}
          max={plaid.itemLimit}
          step={1}
          required
          value={itemsUsed}
          onChange={(e) => setItemsUsed(e.target.value)}
        />
      </label>
      <button className={BUTTON} type="submit" disabled={busy}>
        Save the count
      </button>
      <ErrorLine error={error} />
    </form>
  );
}

export function Banks() {
  const [plaid, setPlaid] = useState<PlaidView | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    api.plaid.settings
      .$get()
      .then(async (res) => {
        if (!res.ok) return setError(await refusal(res));
        setPlaid(((await res.json()) as { plaid: PlaidView }).plaid);
      })
      .catch(() => setError("The server did not answer."));
  }, []);

  return (
    <>
      <h2 className="text-xl font-semibold">Banks</h2>
      <ErrorLine error={error} />
      {plaid === undefined ? null : (
        <>
          <PlaidKeysForm plaid={plaid} onSaved={setPlaid} />
          <ItemsUsedForm plaid={plaid} onSaved={setPlaid} />
        </>
      )}
    </>
  );
}
