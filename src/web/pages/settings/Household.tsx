import { type FormEvent, useEffect, useState } from "react";
import type { HouseholdFactsView } from "../../../server/household-views.ts";
import { api } from "../../api.ts";
import { BUTTON, ErrorLine, FIELD } from "../../components/Fields.tsx";

// The Household facts (spec 05, Household facts): the wizard's step 4, and Settings, Household,
// where any Member edits them at any time. No one is asked their sex.

type Person = { key: number; age: string };

let nextKey = 0;
const person = (age: string): Person => ({ key: nextKey++, age });

// The words to show for a refused request: the server's own, such as an unknown ZIP code.
async function refusal(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: unknown };
  return typeof body.error === "string" ? body.error : "That did not work.";
}

export function HouseholdFactsForm(props: {
  facts: HouseholdFactsView | null;
  submitLabel: string;
  onSaved: (facts: HouseholdFactsView) => void;
}) {
  const { facts } = props;
  const [zipCode, setZipCode] = useState(facts?.zipCode ?? "");
  const [people, setPeople] = useState<Person[]>(
    facts === null ? [person("")] : facts.ages.map((age) => person(String(age))),
  );
  const [rentOrOwn, setRentOrOwn] = useState<"rent" | "own" | undefined>(facts?.rentOrOwn);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const setAge = (key: number, age: string) =>
    setPeople((list) => list.map((p) => (p.key === key ? { ...p, age } : p)));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (rentOrOwn === undefined) return setError("Choose rent or own.");
    setBusy(true);
    setError(undefined);
    try {
      const res = await api.household.$put({
        json: { zipCode: zipCode.trim(), ages: people.map((p) => Number(p.age)), rentOrOwn },
      });
      if (!res.ok) return setError(await refusal(res));
      props.onSaved(((await res.json()) as { facts: HouseholdFactsView }).facts);
    } catch {
      setError("The server did not answer.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="mt-4" onSubmit={submit}>
      <p className="text-gray-600">
        These facts stay on this server. The AI never receives them. The ZIP code sets the Household
        time zone, which decides when the month starts and when quiet hours begin.
      </p>
      <label className="mt-3 block">
        ZIP code
        <input
          className={FIELD}
          inputMode="numeric"
          autoComplete="postal-code"
          pattern="\d{5}"
          maxLength={5}
          required
          value={zipCode}
          onChange={(e) => setZipCode(e.target.value)}
        />
      </label>
      <fieldset className="mt-4">
        <legend>Each person's age</legend>
        <p className="text-gray-600">
          Count everyone in the Household, children and others without a login included. Enter 0 for
          a baby under 1.
        </p>
        {people.map((p, index) => (
          <div className="mt-2 flex items-end gap-2" key={p.key}>
            <label className="block grow">
              Person {index + 1}, age in years
              <input
                className={FIELD}
                type="number"
                min={0}
                max={120}
                step={1}
                required
                value={p.age}
                onChange={(e) => setAge(p.key, e.target.value)}
              />
            </label>
            {people.length > 1 ? (
              <button
                className="rounded border border-gray-300 px-3 py-2"
                type="button"
                onClick={() => setPeople((list) => list.filter((other) => other.key !== p.key))}
              >
                Remove
              </button>
            ) : null}
          </div>
        ))}
        <button
          className="mt-2 rounded border border-gray-300 px-3 py-2"
          type="button"
          onClick={() => setPeople((list) => [...list, person("")])}
        >
          Add a person
        </button>
      </fieldset>
      <fieldset className="mt-4">
        <legend>Does the Household rent or own its home?</legend>
        {(["rent", "own"] as const).map((choice) => (
          <label className="mt-2 mr-4 inline-flex items-center gap-2" key={choice}>
            <input
              type="radio"
              name="rent-or-own"
              required
              checked={rentOrOwn === choice}
              onChange={() => setRentOrOwn(choice)}
            />
            {choice === "rent" ? "Rent" : "Own"}
          </label>
        ))}
      </fieldset>
      <button className={BUTTON} type="submit" disabled={busy}>
        {props.submitLabel}
      </button>
      <ErrorLine error={error} />
    </form>
  );
}

// Settings, Household.
export function Household() {
  const [facts, setFacts] = useState<HouseholdFactsView | null | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [done, setDone] = useState<string | undefined>();

  useEffect(() => {
    api.household
      .$get()
      .then(async (res) => {
        if (!res.ok) return setError(await refusal(res));
        setFacts(((await res.json()) as { facts: HouseholdFactsView | null }).facts);
      })
      .catch(() => setError("The server did not answer."));
  }, []);

  return (
    <>
      <h2 className="text-xl font-semibold">Household</h2>
      <ErrorLine error={error} />
      {facts === undefined ? null : (
        <>
          {facts === null ? null : <HouseholdTimeZone facts={facts} />}
          <HouseholdFactsForm
            facts={facts}
            submitLabel="Save the facts"
            onSaved={(saved) => {
              setFacts(saved);
              setDone("The facts are saved.");
            }}
          />
          {done === undefined ? null : <p className="mt-3">{done}</p>}
        </>
      )}
    </>
  );
}

export function HouseholdTimeZone(props: { facts: HouseholdFactsView }) {
  return (
    <>
      <p className="mt-2">Household time zone: {props.facts.timeZone}</p>
      <p className="mt-2 text-gray-600">
        A new ZIP code in another time zone changes the Household time zone at once. A daily task
        may then run one extra time that day.
      </p>
    </>
  );
}
