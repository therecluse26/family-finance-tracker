import { useEffect, useRef } from "react";
import { Navigate, NavLink, Outlet, useLocation } from "react-router";
import { Page, PageHeading } from "../../components/Page.tsx";
import { SETTINGS_SECTIONS } from "../../menu.ts";
import { TabHeading } from "./settings-ui.tsx";

// The room kept beside the current tab when the row scrolls to it, so the tab beside it peeks in.
const TAB_MARGIN = 24;

// How far the row of tabs scrolls so the current tab shows whole: as little as it can, or not at
// all when the tab shows already. Each value is in px, from the row's left edge.
export function tabRowScroll(
  row: { scrollLeft: number; width: number },
  tab: {
    left: number;
    width: number;
  },
): number {
  if (tab.left < row.scrollLeft) return Math.max(0, tab.left - TAB_MARGIN);
  const right = tab.left + tab.width;
  if (right > row.scrollLeft + row.width) return right - row.width + TAB_MARGIN;
  return row.scrollLeft;
}

// Settings: one section per area (spec 07, Settings overview), as a row of tabs under the heading.
// Below 900 px, where the Shell shows the phone tab bar, the tabs stay one row that scrolls sideways
// under a thin scrollbar, so a mouse can scroll it too, and the current tab scrolls into view. From
// 900 px they wrap, as before. The tabs keep their order, so Tab moves through them as before. Each
// tab's focus ring is drawn inside it, so the scrolling row never clips it.
export function Settings() {
  const { pathname } = useLocation();
  const row = useRef<HTMLUListElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the effect runs on each new tab.
  useEffect(() => {
    const list = row.current;
    const current = list?.querySelector<HTMLElement>('[aria-current="page"]');
    if (list === null || list === undefined || current === null || current === undefined) return;
    list.scrollLeft = tabRowScroll(
      { scrollLeft: list.scrollLeft, width: list.clientWidth },
      { left: current.offsetLeft, width: current.offsetWidth },
    );
  }, [pathname]);

  return (
    <Page>
      <PageHeading title="Settings" />
      <nav aria-label="Settings sections" className="-mt-0.5 min-w-0">
        {/* The line under the tabs is an inset shadow, so the current tab's underline covers it
            inside a row that scrolls. */}
        <ul
          ref={row}
          className="relative flex overflow-x-auto shadow-[inset_0_-1px_0_var(--color-line)] [scrollbar-width:thin] min-[900px]:flex-wrap min-[900px]:overflow-x-visible"
        >
          {SETTINGS_SECTIONS.map((section) => (
            <li key={section.path} className="shrink-0">
              <NavLink
                to={section.path}
                className="block whitespace-nowrap border-b-2 border-transparent px-3 py-2.5 text-sm text-ink-soft hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent aria-[current=page]:border-accent aria-[current=page]:font-semibold aria-[current=page]:text-ink"
              >
                {section.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <div className="mt-1 flex min-w-0 flex-col gap-4">
        <Outlet />
      </div>
    </Page>
  );
}

// A Settings section whose content comes with its own ticket.
export function SettingsPlaceholder(props: { title: string }) {
  return (
    <>
      <TabHeading>{props.title}</TabHeading>
      <p className="text-muted">This section is not built yet.</p>
    </>
  );
}

// Settings with no section chosen opens the first section, Household. The address is replaced, so
// Back leaves Settings instead of coming back here.
export function SettingsIndex() {
  const first = SETTINGS_SECTIONS[0];
  return first === undefined ? null : <Navigate to={first.path} replace />;
}
