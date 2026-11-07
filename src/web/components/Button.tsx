import type { ComponentProps, ReactNode } from "react";

// Buttons. "primary" is the one main action of a card or form, such as "Accept"; "outlined" is
// every other action, such as "Edit" or "Skip". Each is a native <button> and names its `type`,
// so a button inside a form never sends it by mistake.

export type ButtonVariant = "primary" | "outlined";
export type ButtonSize = "normal" | "small";

const BASE =
  "inline-flex items-center justify-center gap-2 rounded-control whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50";
const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-accent font-semibold text-white hover:bg-accent-dark",
  outlined: "border border-field bg-white text-ink hover:bg-page",
};
const SIZE: Record<ButtonSize, string> = {
  normal: "h-10 px-4 text-sm",
  small: "h-8 px-3 text-small",
};

// The classes of a button, for a link that looks like one.
export function buttonClass(variant: ButtonVariant = "primary", size: ButtonSize = "normal") {
  return `${BASE} ${VARIANT[variant]} ${SIZE[size]}`;
}

export function Button(
  props: Omit<ComponentProps<"button">, "type"> & {
    type: "button" | "submit" | "reset";
    variant?: ButtonVariant;
    size?: ButtonSize;
  },
) {
  const { variant, size, className, type, ...rest } = props;
  return (
    <button type={type} className={`${buttonClass(variant, size)} ${className ?? ""}`} {...rest} />
  );
}

// A switch of joined buttons, one pressed, such as "This month" and "Last 12 months". Put the
// Segments in a <fieldset className={SEGMENTS}> with a <legend className="sr-only">.
export const SEGMENTS = "flex";

export function Segment(props: { pressed: boolean; onClick(): void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={props.pressed}
      onClick={props.onClick}
      className="relative h-9 border border-field bg-white px-3.5 text-sm text-ink not-first:-ml-px first:rounded-l-control last:rounded-r-control hover:bg-page focus-visible:z-20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent aria-pressed:z-10 aria-pressed:border-ink aria-pressed:bg-ink aria-pressed:text-white"
    >
      {props.children}
    </button>
  );
}
