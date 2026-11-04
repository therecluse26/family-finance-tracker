import { useEffect, useState } from "react";
import type { CategoryRuleView } from "../../../server/category-views.ts";
import { api } from "../../api.ts";
import { ErrorLine } from "../../components/Fields.tsx";

// Settings → Categories (spec 07, Settings overview; spec 04, Category rules): every Category
// rule, with Delete. A Member's correction makes a rule; deleting one runs the cascade again on its
// Merchant's Transactions not set by hand.

export function CategoryRuleList(props: {
  rules: CategoryRuleView[];
  busy: string | undefined;
  onDelete: (rule: CategoryRuleView) => void;
}) {
  return (
    <>
      <h3 className="mt-4 font-semibold">Category rules</h3>
      <p className="mt-2 text-gray-600">
        When you change a Transaction's Category, the app makes a rule for its Merchant. The rule
        gives the Merchant's past and future Transactions the same Category, except those you set by
        hand.
      </p>
      {props.rules.length === 0 ? <p className="mt-2">No Category rules yet.</p> : null}
      <ul className="mt-2">
        {props.rules.map((rule) => (
          <li key={rule.id} className="mt-2 flex flex-wrap items-center gap-3">
            <span>
              {rule.merchantName}: {rule.category}
            </span>
            <button
              type="button"
              className="rounded border border-gray-400 px-3 py-1 hover:bg-gray-100"
              disabled={props.busy !== undefined}
              aria-label={`Delete the rule for ${rule.merchantName}`}
              onClick={() => props.onDelete(rule)}
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

export function Categories() {
  const [rules, setRules] = useState<CategoryRuleView[] | undefined>();
  const [busy, setBusy] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  async function load() {
    try {
      const res = await api["category-rules"].$get();
      if (!res.ok) return setError("The rules did not load.");
      setRules((await res.json()).rules);
    } catch {
      setError("The server did not answer.");
    }
  }

  async function remove(rule: CategoryRuleView) {
    setBusy(rule.id);
    setError(undefined);
    try {
      const res = await api["category-rules"][":id"].$delete({ param: { id: rule.id } });
      if (!res.ok && res.status !== 404) setError("The rule was not deleted.");
      await load();
    } catch {
      setError("The server did not answer.");
    } finally {
      setBusy(undefined);
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: load once, when the page opens.
  useEffect(() => {
    void load();
  }, []);

  return (
    <>
      <h2 className="text-xl font-semibold">Categories</h2>
      <ErrorLine error={error} />
      {rules === undefined ? null : (
        <CategoryRuleList rules={rules} busy={busy} onDelete={(rule) => void remove(rule)} />
      )}
    </>
  );
}
