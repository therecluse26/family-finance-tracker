import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { api } from "./api.ts";
import { MAIN_MENU, type MenuItem, MORE_MENU, PHONE_TABS } from "./menu.ts";
import { openWizardIfNeeded, resumeWizardIfNeeded } from "./setup-gate.ts";

// The app shell: the main menu and the page. From 900 px wide, the menu is a column beside the
// page. At phone width it folds to a bar at the foot of the screen with the PHONE_TABS and
// "More"; "More" opens the whole menu over the page. While it is open, the page under it is inert,
// so neither Tab nor a screen reader reaches it.

// Each class string is written out in full so Tailwind finds it. A phone tab is an icon over its
// label, with the open count on the icon's corner; below 360 px the labels get smaller so they
// never touch. From 900 px wide, and in the open menu, each item is a row.
const TAB_LINK = {
  base: "relative flex flex-col items-center gap-0.5 px-1 py-2 text-[11px] whitespace-nowrap max-[359px]:px-0.5 max-[359px]:text-[10px] max-[359px]:tracking-tight min-[900px]:flex-row min-[900px]:gap-2 min-[900px]:rounded-control min-[900px]:px-2.5 min-[900px]:py-[9px] min-[900px]:text-[15px]",
  current: "font-semibold text-accent min-[900px]:bg-nav-current min-[900px]:text-ink",
  other: "text-muted min-[900px]:text-ink-soft min-[900px]:hover:bg-page",
};
const ROW_LINK = {
  base: "flex flex-row items-center gap-2 rounded-control px-2.5 py-[9px] text-[15px]",
  current: "bg-nav-current font-semibold text-ink",
  other: "text-ink-soft hover:bg-page",
};
const TAB_BADGE =
  "absolute top-0.5 left-1/2 ml-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold tracking-normal text-white min-[900px]:static min-[900px]:ml-0 min-[900px]:h-[22px] min-[900px]:min-w-[22px] min-[900px]:px-1.5 min-[900px]:text-xs";
const ROW_BADGE =
  "inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-full bg-accent px-1.5 text-xs font-semibold text-white";

// The phone tabs' icons, from the App-Phone-Dashboard board.
const TAB_ICON: Record<string, ReactNode> = {
  "/": <path d="M4 11l8-7 8 7v9H4z" strokeLinejoin="round" />,
  "/transactions": <path d="M5 7h14M5 12h14M5 17h9" strokeLinecap="round" />,
  "/chat": <path d="M4 5h16v11H9l-5 4z" strokeLinejoin="round" />,
  "/review-list": <path d="M6 12l4 4 8-9" strokeLinecap="round" strokeLinejoin="round" />,
};

function TabIcon(props: { children: ReactNode; className: string }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      className={props.className}
    >
      {props.children}
    </svg>
  );
}

function MenuLink(props: {
  item: MenuItem;
  count?: number | undefined;
  open: boolean;
  onChoose(path: string): void;
}) {
  const style = props.open ? ROW_LINK : TAB_LINK;
  const icon = TAB_ICON[props.item.path];
  return (
    <NavLink
      to={props.item.path}
      end={props.item.path === "/"}
      className={({ isActive }) => `${style.base} ${isActive ? style.current : style.other}`}
      onClick={() => props.onChoose(props.item.path)}
    >
      {icon === undefined ? null : (
        <TabIcon className={props.open ? "hidden" : "min-[900px]:hidden"}>{icon}</TabIcon>
      )}
      <span className="flex flex-1 items-center justify-between gap-1">
        <span>{props.item.label}</span>
        {props.count === undefined ? null : (
          <span className={props.open ? ROW_BADGE : TAB_BADGE} data-slot="open-count">
            {props.count}
          </span>
        )}
      </span>
    </NavLink>
  );
}

function Brand() {
  return (
    <svg width="26" height="26" viewBox="0 0 28 28" aria-hidden="true">
      <rect width="28" height="28" rx="7" className="fill-accent" />
      <path
        d="M8 18l4-5 3 3 5-7"
        stroke="#fff"
        strokeWidth="2.2"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// What the shell gives each page: the Review list page sets the menu's open count after each
// answer.
export type ShellContext = { setReviewListOpenCount(count: number): void };

export function Shell(props: { reviewListOpenCount?: number }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [openCount, setOpenCount] = useState(props.reviewListOpenCount);
  // Whether "More" has opened the whole menu at phone width.
  const [open, setOpen] = useState(false);
  const moreButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  // Set when "Close menu" or Escape closes the menu, so the focus goes back to "More".
  const backToMore = useRef(false);
  const closeMenu = useCallback(() => {
    backToMore.current = true;
    setOpen(false);
  }, []);
  const page = useRef<HTMLDivElement>(null);
  // The page a Member chose in the open menu. Once it shows, its heading takes the focus, because
  // the link they chose is hidden with the menu.
  const chosenPage = useRef<string | null>(null);
  const choosePage = useCallback(
    (path: string) => {
      if (!open) return;
      chosenPage.current = path;
      setOpen(false);
    },
    [open],
  );

  // Every page leads to the wizard until it is done. After that, every page in the shell needs a
  // signed-in Member. The Review list's menu item then shows its open count.
  useEffect(() => {
    openWizardIfNeeded(navigate, "app")
      .then(async (opened) => {
        if (opened) return;
        const res = await api["review-list"].count.$get();
        if (res.status === 401) return navigate("/sign-in", { replace: true });
        if (res.ok) setOpenCount((await res.json()).open);
        // The first Member's next visit opens the wizard's next step, until its Finish step.
        await resumeWizardIfNeeded(navigate);
      })
      .catch(() => {});
  }, [navigate]);

  // Opening a page closes the menu.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the effect runs on each new page.
  useEffect(() => setOpen(false), [pathname]);

  // The open menu takes the focus, and Escape closes it. "More" is shown again only after the
  // render that closes the menu, so it takes the focus back here. From 900 px wide the menu is a
  // column again, so a window widened past it closes the menu, and the page is never left inert.
  useEffect(() => {
    if (!open) {
      if (backToMore.current) moreButton.current?.focus();
      backToMore.current = false;
      return;
    }
    closeButton.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };
    const wide = window.matchMedia("(min-width: 900px)");
    const onWide = () => {
      if (wide.matches) setOpen(false);
    };
    onWide();
    document.addEventListener("keydown", onKey);
    wide.addEventListener("change", onWide);
    return () => {
      document.removeEventListener("keydown", onKey);
      wide.removeEventListener("change", onWide);
    };
  }, [open, closeMenu]);

  // The page chosen in the menu takes the focus on its <h1>, or its <main>, once it shows.
  useEffect(() => {
    if (open || chosenPage.current !== pathname) return;
    chosenPage.current = null;
    const target =
      page.current?.querySelector<HTMLElement>("h1") ??
      page.current?.querySelector<HTMLElement>("main") ??
      page.current;
    if (target === null || target === undefined) return;
    if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
    target.focus();
  }, [open, pathname]);

  const onMorePage = !PHONE_TABS.some((path) =>
    path === "/" ? pathname === "/" : pathname.startsWith(path),
  );

  return (
    <div className="min-h-screen bg-page text-ink min-[900px]:grid min-[900px]:grid-cols-[13.75rem_minmax(0,1fr)]">
      <nav
        id="main-menu"
        aria-label="Main menu"
        className={`fixed inset-x-0 bottom-0 z-30 border-t border-line bg-white pb-[env(safe-area-inset-bottom)] min-[900px]:sticky min-[900px]:top-0 min-[900px]:h-screen min-[900px]:overflow-y-auto min-[900px]:border-t-0 min-[900px]:border-r min-[900px]:px-3 min-[900px]:py-5 ${
          open ? "top-0 overflow-y-auto px-3 py-4" : ""
        }`}
      >
        <div
          className={`items-center justify-between gap-2.5 px-2 pb-[18px] ${open ? "flex" : "hidden min-[900px]:flex"}`}
        >
          <p className="flex items-center gap-2.5 font-semibold">
            <Brand />
            Family Finance Tracker
          </p>
          {open ? (
            <button
              ref={closeButton}
              type="button"
              className="rounded-control border border-field bg-white px-3 py-1.5 text-sm min-[900px]:hidden"
              onClick={closeMenu}
            >
              Close menu
            </button>
          ) : null}
        </div>
        <ul
          className={
            open ? "flex flex-col gap-0.5" : "flex min-[900px]:flex-col min-[900px]:gap-0.5"
          }
        >
          {MAIN_MENU.map((item) => {
            const tab = PHONE_TABS.includes(item.path);
            return (
              <li
                key={item.path}
                className={
                  open
                    ? ""
                    : tab
                      ? "min-w-0 flex-1 min-[900px]:flex-none"
                      : "hidden min-[900px]:block"
                }
              >
                <MenuLink
                  item={item}
                  count={item.path === "/review-list" ? openCount : undefined}
                  open={open}
                  onChoose={choosePage}
                />
              </li>
            );
          })}
          <li className={open ? "hidden" : "min-w-0 flex-1 min-[900px]:hidden"}>
            <button
              ref={moreButton}
              type="button"
              aria-expanded={open}
              aria-controls="main-menu"
              className={`flex w-full flex-col items-center gap-0.5 px-1 py-2 text-[11px] max-[359px]:px-0.5 max-[359px]:text-[10px] ${
                onMorePage ? "font-semibold text-accent" : "text-muted"
              }`}
              onClick={() => setOpen(true)}
            >
              <TabIcon className="">
                <circle cx="6" cy="12" r="1.6" fill="currentColor" stroke="none" />
                <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
                <circle cx="18" cy="12" r="1.6" fill="currentColor" stroke="none" />
              </TabIcon>
              More
            </button>
          </li>
        </ul>
        <div className={open ? "" : "hidden min-[900px]:block"}>
          <p className="mx-2.5 mt-4 mb-1.5 text-xs font-semibold tracking-[.06em] text-muted uppercase">
            More
          </p>
          <ul className="flex flex-col gap-0.5">
            {MORE_MENU.map((item) => (
              <li key={item.path}>
                <MenuLink item={item} open={open} onChoose={choosePage} />
              </li>
            ))}
          </ul>
        </div>
      </nav>
      <div
        ref={page}
        inert={open}
        className="min-w-0 px-4 pt-4 pb-24 min-[900px]:px-5 min-[900px]:pt-7 min-[900px]:pb-12"
      >
        <Outlet context={{ setReviewListOpenCount: setOpenCount } satisfies ShellContext} />
      </div>
    </div>
  );
}
