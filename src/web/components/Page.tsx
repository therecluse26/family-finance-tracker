import type { ReactNode } from "react";

// The frame of a page inside the shell: a centered column of cards, 16 px apart. "narrow" suits a
// list page, such as Top Merchants or Goals; "wide" suits a page of tables or charts, such as the
// dashboard or Transactions.

const WIDTH = { narrow: "max-w-[860px]", wide: "max-w-[1060px]" };

export function Page(props: { children: ReactNode; width?: keyof typeof WIDTH }) {
  return (
    <main className={`mx-auto flex w-full ${WIDTH[props.width ?? "narrow"]} flex-col gap-4`}>
      {props.children}
    </main>
  );
}

// The page's <h1>, with its controls, such as a period switch or "Add a Goal", at the right. On a
// phone the controls wrap under the heading.
export function PageHeading(props: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <h1 className="flex-1 text-title font-bold">{props.title}</h1>
      {props.children}
    </div>
  );
}

// A heading inside the page, such as "Goals" or "AI provider".
export function SectionHeading(props: { children: ReactNode; id?: string }) {
  return (
    <h2 className="text-heading font-bold" id={props.id}>
      {props.children}
    </h2>
  );
}
