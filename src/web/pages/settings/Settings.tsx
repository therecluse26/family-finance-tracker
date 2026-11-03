import { NavLink, Outlet } from "react-router";
import { SETTINGS_SECTIONS } from "../../menu.ts";

// Settings: one section per area (spec 07, Settings overview).
export function Settings() {
  return (
    <main>
      <h1 className="text-2xl font-semibold">Settings</h1>
      <div className="mt-4 min-[900px]:grid min-[900px]:grid-cols-[12rem_1fr] min-[900px]:gap-6">
        <nav aria-label="Settings sections">
          <ul className="flex flex-wrap gap-1 min-[900px]:flex-col">
            {SETTINGS_SECTIONS.map((section) => (
              <li key={section.path}>
                <NavLink
                  to={section.path}
                  className={({ isActive }) =>
                    `block rounded px-3 py-2 ${
                      isActive ? "bg-blue-50 font-semibold text-blue-800" : "hover:bg-gray-100"
                    }`
                  }
                >
                  {section.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <section className="mt-4 min-w-0 min-[900px]:mt-0">
          <Outlet />
        </section>
      </div>
    </main>
  );
}

// A Settings section whose content comes with its own ticket.
export function SettingsPlaceholder(props: { title: string }) {
  return (
    <>
      <h2 className="text-xl font-semibold">{props.title}</h2>
      <p className="mt-2 text-gray-600">This section is not built yet.</p>
    </>
  );
}

// Settings before a section is chosen.
export function SettingsIndex() {
  return <p className="text-gray-600">Choose a section.</p>;
}
