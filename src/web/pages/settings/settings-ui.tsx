import type { HTMLInputTypeAttribute, ReactNode } from "react";
import type { StatusTone } from "../../../format.ts";
import { Card } from "../../components/Card.tsx";
import { StatusText } from "../../components/Status.tsx";

// The pieces every Settings tab shares, from the approved Settings boards: a card with its heading
// and an optional status at the right, labels above fields, short grey hints, and a row of
// buttons. Kept here, beside the tabs, until they move to src/web/components.

// A field's label: 14 px bold, above its box. Put the box inside the <label>.
export const LABEL = "mt-3.5 block text-sm font-semibold";
// A text box or select, 42 px tall, with no width limit: add one, such as `max-w-40` for a ZIP code.
// `font-normal` undoes the label's bold.
export const BOX =
  "mt-1.5 block h-[42px] w-full rounded-[10px] border border-field bg-white px-3 text-[15px] font-normal text-ink";
// A text box or select at the boards' usual width.
export const INPUT = `${BOX} max-w-[340px]`;
// A box for a pasted secret or a long value.
export const TEXTAREA =
  "mt-1.5 block w-full rounded-[10px] border border-field bg-white px-3 py-2 font-mono text-[15px] font-normal text-ink";
// A short grey line under a field or a button.
export const HINT = "mt-1.5 text-small text-muted";
// A row of buttons under a form.
export const BUTTONS = "mt-4 flex flex-wrap items-center gap-2";
// A link inside running text.
export const TEXT_LINK = "text-accent underline hover:text-accent-dark";
// A row inside a card, such as one passkey or one Member, with a line above it.
export const ROW =
  "flex flex-wrap items-center gap-x-3.5 gap-y-2 border-t border-line-soft py-3 first:border-t-0";
// A row that opens to show its form, such as one Unconnected account, and its summary line: the
// name at the left and the amount at the right, after a ▸ that turns when the row opens. Put
// <RowMarker /> first in the summary.
export const DETAILS = "group border-t border-line-soft py-2.5 first:border-t-0";
export const SUMMARY =
  "flex cursor-pointer list-none flex-wrap items-baseline gap-x-3 gap-y-0.5 [&::-webkit-details-marker]:hidden";

// The ▸ before a row's summary, turned down while the row is open.
export function RowMarker() {
  return (
    <span aria-hidden="true" className="inline-block text-muted group-open:rotate-90">
      ▸
    </span>
  );
}

// A form that opens in place under its "+" button, such as "Add a Manual loan": a grey panel with
// its heading. The button names the panel with aria-controls.
export const ADD_PANEL = "mt-4 rounded-control border border-line bg-page p-4";
// A heading inside a card, under a line, such as "Models" or "Add a Manual loan".
export const SUBHEADING = "mt-5 border-t border-line pt-4 font-semibold";
// A radio or checkbox with its words beside it.
export const CHOICE = "mt-2 flex items-center gap-2 text-[15px] font-normal";

// The Settings tab's own heading. The tab row above already names the tab, so it is for screen
// readers only.
export function TabHeading(props: { children: ReactNode }) {
  return <h2 className="sr-only">{props.children}</h2>;
}

// A white card with an h3 heading and, at its right, a short status such as "✓ On".
export function SettingCard(props: {
  id: string;
  title: ReactNode;
  status?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <Card aria-labelledby={props.id} className={props.className}>
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <h3 id={props.id} className="flex-1 text-heading font-bold">
          {props.title}
        </h3>
        {props.status === undefined ? null : <div className="text-small">{props.status}</div>}
      </div>
      {props.children}
    </Card>
  );
}

// The grey line under a card's heading.
export function Lead(props: { children: ReactNode }) {
  return <p className="mt-1.5 text-muted">{props.children}</p>;
}

// The line that says a save worked, with its ✓.
export function DoneLine(props: { done: string | undefined; tone?: StatusTone }) {
  if (props.done === undefined || props.done === "") return null;
  return (
    <p className="mt-3 text-small" role="status">
      <StatusText tone={props.tone ?? "good"}>{props.done}</StatusText>
    </p>
  );
}

// A text field with its label above it.
export function Field(props: {
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  type?: HTMLInputTypeAttribute;
  inputMode?: "numeric" | "decimal" | "email";
  autoComplete?: string;
  placeholder?: string;
  required?: boolean;
  // A width in place of the usual one, such as "max-w-36".
  className?: string;
}) {
  return (
    <label className={LABEL}>
      {props.label}
      <input
        className={props.className === undefined ? INPUT : `${BOX} ${props.className}`}
        type={props.type ?? "text"}
        inputMode={props.inputMode}
        autoComplete={props.autoComplete ?? "off"}
        placeholder={props.placeholder}
        required={props.required ?? false}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </label>
  );
}
