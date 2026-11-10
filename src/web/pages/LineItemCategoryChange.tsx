import { useState } from "react";
import { LINE_ITEM_CATEGORIES } from "../../categories/list.ts";
import type { LineItemView } from "../../server/amazon-views.ts";
import { api } from "../api.ts";
import { buttonClass } from "../components/Button.tsx";

// Change on one Line item (spec 14, Item rules; Pages): a Category, and "Only this item". Without
// it, the app makes an Item rule, so the product's other Line items take the Category too. The
// list leaves out Superstores, Cash and Payments to people, which a Line item never takes.

const FIELD =
  "block h-10 w-full rounded-control border border-field bg-white px-3 text-sm text-ink";

export const changeLineItemCategory = (id: string, category: string, onlyThisItem: boolean) => {
  const edit = { param: { id }, json: { category, onlyThisItem } };
  return api["line-items"][":id"].category.$put(edit);
};

export function LineItemCategoryChange(props: { item: LineItemView; onChanged(): void }) {
  const { item } = props;
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState(item.category ?? "");
  const [onlyThisItem, setOnlyThisItem] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const prefix = `line-item-${item.id}`;

  if (!open) {
    return (
      <button
        type="button"
        className={buttonClass("outlined", "small")}
        aria-label={`Change the Category of ${item.name}`}
        onClick={() => setOpen(true)}
      >
        Change
      </button>
    );
  }

  const save = async () => {
    if (category === "") {
      setError("Pick a Category.");
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const res = await changeLineItemCategory(item.id, category, onlyThisItem);
      if (!res.ok) {
        setError("The Category could not be saved. Try again.");
        return;
      }
      setOpen(false);
      props.onChanged();
    } catch {
      setError("The Category could not be saved. Try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-2 w-full basis-full rounded-control bg-page p-3">
      <label className="block text-sm font-semibold" htmlFor={`${prefix}-category`}>
        Category
      </label>
      <select
        id={`${prefix}-category`}
        name="category"
        className={`${FIELD} mt-1 sm:max-w-sm`}
        value={category}
        onChange={(e) => setCategory(e.target.value)}
      >
        <option value="">Pick a Category</option>
        {LINE_ITEM_CATEGORIES.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
      <label className="mt-3 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="onlyThisItem"
          className="size-4 accent-accent"
          aria-describedby={`${prefix}-help`}
          checked={onlyThisItem}
          onChange={(e) => setOnlyThisItem(e.target.checked)}
        />
        Only this item
      </label>
      <p id={`${prefix}-help`} className="mt-1 text-small text-muted">
        Without it, an Item rule gives this product's other items this Category too.
      </p>
      {error === undefined ? null : (
        <p className="mt-2 text-small text-critical" role="alert">
          {error}
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className={buttonClass("primary", "small")}
          disabled={saving}
          onClick={save}
        >
          Save
        </button>
        <button
          type="button"
          className={buttonClass("outlined", "small")}
          onClick={() => {
            setOpen(false);
            setError(undefined);
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
