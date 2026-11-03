import { useEffect } from "react";
import { NavLink, Outlet, useNavigate } from "react-router";
import { api } from "./api.ts";
import { MAIN_MENU, type MenuItem, MORE_MENU } from "./menu.ts";
import { openWizardIfNeeded } from "./setup-gate.ts";

// The app shell: the main menu and the page. At phone width it is one column, with the menu above
// the page. From 900 px wide, the menu sits beside the page.

function MenuLink(props: { item: MenuItem; count?: number | undefined }) {
  return (
    <NavLink
      to={props.item.path}
      end={props.item.path === "/"}
      className={({ isActive }) =>
        `flex items-center justify-between gap-2 rounded px-3 py-2 ${
          isActive ? "bg-blue-50 font-semibold text-blue-800" : "text-gray-800 hover:bg-gray-100"
        }`
      }
    >
      <span>{props.item.label}</span>
      {props.count === undefined ? null : (
        <span className="rounded-full bg-gray-200 px-2 text-sm" data-slot="open-count">
          {props.count}
        </span>
      )}
    </NavLink>
  );
}

export function Shell(props: { reviewListOpenCount?: number }) {
  const navigate = useNavigate();

  // Every page leads to the wizard until it is done. After that, every page in the shell needs a
  // signed-in Member.
  useEffect(() => {
    openWizardIfNeeded(navigate, "app")
      .then(async (opened) => {
        if (opened) return;
        const res = await api.ping.$get();
        if (res.status === 401) await navigate("/sign-in", { replace: true });
      })
      .catch(() => {});
  }, [navigate]);

  return (
    <div className="min-h-screen bg-white text-gray-900 min-[900px]:grid min-[900px]:grid-cols-[15rem_1fr]">
      <nav
        aria-label="Main menu"
        className="border-b border-gray-200 p-3 min-[900px]:border-r min-[900px]:border-b-0"
      >
        <p className="px-3 py-2 font-semibold">Family Finance Tracker</p>
        <ul className="flex flex-wrap gap-1 min-[900px]:flex-col">
          {MAIN_MENU.map((item) => (
            <li key={item.path}>
              <MenuLink
                item={item}
                count={item.path === "/review-list" ? props.reviewListOpenCount : undefined}
              />
            </li>
          ))}
        </ul>
        <p className="mt-3 px-3 text-sm font-semibold text-gray-500">More</p>
        <ul className="flex flex-wrap gap-1 min-[900px]:flex-col">
          {MORE_MENU.map((item) => (
            <li key={item.path}>
              <MenuLink item={item} />
            </li>
          ))}
        </ul>
      </nav>
      <div className="min-w-0 p-4 min-[900px]:p-6">
        <Outlet />
      </div>
    </div>
  );
}
