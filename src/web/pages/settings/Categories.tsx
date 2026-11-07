import { useEffect, useState } from "react";
import type { CategoryRuleView } from "../../../server/category-views.ts";
import { api } from "../../api.ts";
import { Button } from "../../components/Button.tsx";
import { ErrorLine } from "../../components/Fields.tsx";
import { Lead, ROW, SettingCard, TabHeading } from "./settings-ui.tsx";

// Settings → Categories (spec 07, Settings overview; spec 04, Category rules): every Category
// rule, with Delete. A Member's correction makes a rule; deleting one runs the cascade again on its
// Merchant's Transactions not set by hand.

export function CategoryRuleList(props: {
  rules: CategoryRuleView[];
  busy: string | undefined;
  onDelete: (rule: CategoryRuleView) => void;
}) {
  return (
    <SettingCard id="category-rules" title="Category rules">
      <Lead>
        When you change a Transaction's Category, the app makes a rule for its Merchant. The rule
        gives the Merchant's past and future Transactions the same Category, except those you set by
        hand.
      </Lead>
      {props.rules.length === 0 ? <p className="mt-3">No Category rules yet.</p> : null}
      <ul className="mt-2.5">
        {props.rules.map((rule) => (
          <li key={rule.id} className={ROW}>
            <span className="min-w-0 flex-[1_1_220px]">
              <span className="font-semibold">{rule.merchantName}</span>
              <span className="text-muted">: {rule.category}</span>
            </span>
            <Button
              type="button"
              variant="outlined"
              size="small"
              disabled={props.busy !== undefined}
              aria-label={`Delete the rule for ${rule.merchantName}`}
              onClick={() => props.onDelete(rule)}
            >
              Delete
            </Button>
          </li>
        ))}
      </ul>
    </SettingCard>
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
      <TabHeading>Categories</TabHeading>
      <ErrorLine error={error} />
      {rules === undefined ? null : (
        <CategoryRuleList rules={rules} busy={busy} onDelete={(rule) => void remove(rule)} />
      )}
    </>
  );
}
