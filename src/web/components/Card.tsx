import type { ReactNode } from "react";

// A white box on the grey page. "list" padding suits a card of rows divided by lines, such as the
// Top Merchants list; "normal" suits a card of text and numbers.

const PADDING = {
  normal: "p-4 min-[900px]:px-[22px] min-[900px]:py-5",
  list: "px-4 py-2 min-[900px]:px-5",
};

export function Card(props: {
  children: ReactNode;
  padding?: keyof typeof PADDING;
  as?: "section" | "div" | "article";
  className?: string;
  "aria-labelledby"?: string;
}) {
  const Tag = props.as ?? "section";
  return (
    <Tag
      className={`rounded-card border border-line bg-white ${PADDING[props.padding ?? "normal"]} ${props.className ?? ""}`}
      aria-labelledby={props["aria-labelledby"]}
    >
      {props.children}
    </Tag>
  );
}

// The small grey label at the top of a card, such as "Left to spend in November".
export function CardLabel(props: { children: ReactNode }) {
  return <p className="text-small font-semibold text-muted">{props.children}</p>;
}
